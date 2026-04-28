// Reference Playwright AIO worker — Phase B #7 fallback per ADR-0010.
//
// What this is.
//   A standalone Node service that runs Playwright headed (or headless)
//   and scrapes Google's AI Overview panel for a (query, country, language)
//   triple. Designed to live on Fly.io (or any container host) with a
//   Bright Data residential proxy attached, isolated from the Vercel
//   runtime so Playwright's heavy deps + ongoing CAPTCHA arms race
//   stay out of the main app's build.
//
// What this is NOT.
//   - A drop-in production scraper. Google's AIO selectors change. The
//     selectors below are best-effort heuristics that worked at ship
//     time; they will need maintenance. When they break, the worker
//     returns has_aio=false rather than fabricating; the operator sees
//     an honest "AIO not detected" row in the dashboard.
//   - A bot-detection bypass. Without a residential proxy, you'll
//     get reCAPTCHA-walled within a few queries. Set BRIGHT_DATA_PROXY_URL
//     before serious use.
//
// Endpoints.
//   GET  /health        → 200 OK + { ok: true, version }
//   POST /capture-aio   → { ok, has_aio, overview_text, sources, error? }
//                         Authorization: Bearer ${WORKER_SHARED_SECRET}
//                         Body: { query, country?, language? }
//
// Env.
//   WORKER_SHARED_SECRET  — required; matches PLAYWRIGHT_AIO_WORKER_SECRET on Vercel
//   BRIGHT_DATA_PROXY_URL — optional; e.g. http://customer-...:pwd@brd.superproxy.io:33335
//   PORT                  — default 8080
//   HEADLESS              — 'true' (default) | 'false' for local debug
//
// Deploying on Fly.io
//   1. fly launch (creates fly.toml; pick the smallest instance — this image is heavy)
//   2. fly secrets set WORKER_SHARED_SECRET="$(openssl rand -hex 32)"
//   3. fly secrets set BRIGHT_DATA_PROXY_URL="http://customer-...:pwd@brd.superproxy.io:33335"
//   4. fly deploy
//   5. On Vercel: PLAYWRIGHT_AIO_WORKER_URL=https://your-app.fly.dev,
//                 PLAYWRIGHT_AIO_WORKER_SECRET=<the secret above>

import { createServer } from 'node:http';
import { URL as NodeURL } from 'node:url';
import { chromium } from 'playwright-core';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const SHARED_SECRET = process.env.WORKER_SHARED_SECRET ?? '';
const PROXY_URL = process.env.BRIGHT_DATA_PROXY_URL ?? null;
const HEADLESS = (process.env.HEADLESS ?? 'true') !== 'false';

if (!SHARED_SECRET) {
  console.error('FATAL: WORKER_SHARED_SECRET not set. Refusing to start.');
  process.exit(1);
}

// One persistent browser, recycled per request — Playwright cold-start
// is the slowest part of a capture (~2s of the ~30s total). Keeping a
// browser alive between requests trades RAM (~150MB/instance) for
// per-request latency. Crashes are recovered by relaunching on next
// request.
let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) return browserInstance;
  browserInstance = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
    proxy: PROXY_URL ? { server: PROXY_URL } : undefined,
  });
  browserInstance.on('disconnected', () => {
    browserInstance = null;
  });
  return browserInstance;
}

/**
 * Capture an AIO panel for a single query. Best-effort selector logic;
 * Google rewrites these regularly. When selectors miss, returns
 * has_aio=false with an empty overview — never fabricates content.
 */
async function captureAioOnce({ query, country, language }) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1100 },
    locale: language ?? 'en-US',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
    geolocation: country === 'us' ? { latitude: 40.7128, longitude: -74.006 } : undefined,
  });
  const page = await context.newPage();

  // Mask the most obvious automation tells. Bright Data + this is
  // sufficient for moderate-volume use; high-volume needs more.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  try {
    const url = new NodeURL('https://www.google.com/search');
    url.searchParams.set('q', query);
    if (country === 'us') url.searchParams.set('gl', 'us');
    if (language === 'en') url.searchParams.set('hl', 'en');
    // udm=14 forces "Web" mode but skips the SERP UI re-org Google
    // sometimes serves; helpful for stability.

    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // Soft consent dialog — a small fraction of geos get an interstitial.
    // Click "Accept all" if present and continue. No-op otherwise.
    try {
      const accept = page.getByRole('button', { name: /Accept all|I agree|Reject all/i });
      await accept.first().click({ timeout: 2500 });
    } catch {
      /* no consent dialog — fine */
    }

    // Wait for the AIO container OR the "no AIO" indicator (organic
    // results). Whichever lands first.
    await Promise.race([
      page.waitForSelector('[data-mfe-name="ai_overview"], div[aria-label*="AI overview"]', {
        timeout: 18_000,
      }),
      page.waitForSelector('#search div[data-async-context]', { timeout: 18_000 }),
    ]).catch(() => {});

    // Detect AIO presence.
    const aioContainer =
      (await page.locator('[data-mfe-name="ai_overview"]').first().elementHandle()) ??
      (await page.locator('div[aria-label*="AI overview"]').first().elementHandle()) ??
      (await page
        .locator('div:has-text("AI Overview"):below(:text("AI Overview"))')
        .first()
        .elementHandle());

    if (!aioContainer) {
      return { ok: true, has_aio: false, overview_text: null, sources: [] };
    }

    // Sometimes the AIO renders behind a "Show more" / "Generate" button.
    // Click it to expand if present.
    try {
      const showMore = page.getByRole('button', { name: /Show more|Generate|Continue/i });
      await showMore.first().click({ timeout: 2500 });
      await page.waitForTimeout(1500);
    } catch {
      /* no expand button — fine */
    }

    // Extract prose.
    const overview_text = (
      await aioContainer.evaluate((el) => {
        return (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 8000);
      })
    ) || null;

    // Extract sources — anchors inside the AIO container.
    const sources = await aioContainer.evaluate((el) => {
      const out = [];
      const seen = new Set();
      el.querySelectorAll('a[href]').forEach((a) => {
        const href = a.href;
        if (!href || seen.has(href)) return;
        seen.add(href);
        let domain = '';
        try {
          domain = new URL(href).host.toLowerCase().replace(/^www\./, '');
        } catch (_) { /* skip */ }
        // Filter out Google internal links.
        if (
          domain.endsWith('google.com') ||
          domain.endsWith('gstatic.com') ||
          href.startsWith('javascript:')
        ) {
          return;
        }
        out.push({ url: href, title: (a.textContent || '').trim().slice(0, 240), domain });
      });
      return out;
    });

    return {
      ok: true,
      has_aio: true,
      overview_text,
      sources,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

// ── HTTP handler ────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new NodeURL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '0.1.0' }));
    return;
  }

  if (url.pathname === '/capture-aio' && req.method === 'POST') {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${SHARED_SECRET}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
      return;
    }
    if (typeof payload?.query !== 'string' || payload.query.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'query required' }));
      return;
    }
    try {
      const result = await captureAioOnce({
        query: payload.query,
        country: payload.country,
        language: payload.language,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[playwright-aio-worker] capture error', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(
    `[playwright-aio-worker] listening on :${PORT} (proxy=${PROXY_URL ? 'set' : 'none'}, headless=${HEADLESS})`,
  );
});

process.on('SIGTERM', async () => {
  console.log('[playwright-aio-worker] SIGTERM — shutting down');
  if (browserInstance) await browserInstance.close().catch(() => {});
  server.close(() => process.exit(0));
});
