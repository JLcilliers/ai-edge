/**
 * Backlinks signal provider for the suppression scan (Phase B #4).
 *
 * Why this exists. The current suppression scan picks `'noindex'` for any
 * page with semantic distance > 0.55. That's the right call for thin or
 * abandoned content with no inbound links — but for an old page that the
 * web has been linking to for years, no-indexing destroys link equity that
 * could be redirected to a still-relevant URL. PLAN §5.3 acknowledged this
 * gap:
 *
 *   > The PLAN also distinguishes "no-index" vs "301 to closest aligned
 *   > page" based on backlinks. We don't have a backlinks source yet, so
 *   > the v1 default for d > 0.55 is 'noindex'.
 *
 * What this module adds. A pluggable provider interface that returns a
 * backlink count for a URL. The suppression decision logic consults the
 * provider and flips action from 'noindex' to 'redirect' when the URL
 * has inbound links above a threshold (default: 5 referring domains).
 *
 * Providers
 * ---------
 *   AhrefsProvider        — paid, accurate, full ref-domain breakdown.
 *                           Activates when AHREFS_API_KEY is set.
 *   DataForSEOProvider    — paid, also covers SERP capture; activates
 *                           when DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD
 *                           are both set. (Already provisioned in
 *                           .env.example for the AIO + SERP path.)
 *   NullProvider          — fallback when no key is configured. Returns
 *                           backlinks=0 for every URL → suppression
 *                           keeps current 'noindex' behavior. No
 *                           regression vs. pre-Phase-B.
 *
 * Decision policy. We keep it conservative:
 *   - d > 0.55 AND backlinks ≥ 5 ref-domains  → 'redirect' (preserve link equity)
 *   - d > 0.55 AND backlinks <  5 ref-domains → 'noindex'
 *   - 0.40 < d ≤ 0.55                          → 'rewrite' (unchanged)
 *
 * Cost note. Backlinks lookups are paid (~$0.001/URL on Ahrefs at the
 * cheapest tier). For a 75-page firm, that's ~$0.08 per scan. We cache
 * the result for 7 days in `entitySignals` keyed by source='backlinks'
 * so re-running the scan within the week doesn't re-bill.
 */

export interface BacklinkCount {
  /** Total inbound links pointing at this URL. */
  total: number;
  /** Distinct referring domains — the metric we actually use for routing. */
  refDomains: number;
  /** Provider label for telemetry. */
  provider: string;
}

export interface BacklinksProvider {
  name: string;
  /**
   * Return null when the provider can't service this URL (e.g., quota
   * exhausted, transient error). The caller defaults to backlinks=0
   * which preserves current 'noindex' behavior — safer than throwing.
   */
  getBacklinks(url: string): Promise<BacklinkCount | null>;
}

// ── Ahrefs adapter ────────────────────────────────────────────────────

class AhrefsProvider implements BacklinksProvider {
  name = 'ahrefs';
  private apiKey: string;
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }
  async getBacklinks(url: string): Promise<BacklinkCount | null> {
    // Ahrefs v3 API endpoint shape:
    //   GET https://api.ahrefs.com/v3/site-explorer/backlinks-stats?target=<url>
    //         &date=YYYY-MM-DD&mode=exact
    //   Authorization: Bearer <key>
    //   Returns: { metrics: { live: number, all_time: number,
    //                         live_refdomains: number, all_time_refdomains: number } }
    //
    // History: this used to call /site-explorer/metrics — which is a
    // *different* endpoint that returns org_keywords / org_traffic /
    // paid_* (SERP signals, not backlinks). Both endpoints respond
    // HTTP 200 with a `metrics` object, so the wrong-endpoint failure
    // mode was silent: the code read `metrics.backlinks` and
    // `metrics.refdomains` which simply didn't exist on the /metrics
    // response, falling through to the `?? 0` defaults. C1's "preserve
    // link equity via 301 when ≥5 ref-domains" branch had never fired
    // in production. The smoke check below now catches this class of
    // silent failure on activation.
    const date = new Date().toISOString().slice(0, 10);
    const endpoint = new URL('https://api.ahrefs.com/v3/site-explorer/backlinks-stats');
    endpoint.searchParams.set('target', url);
    endpoint.searchParams.set('date', date);
    endpoint.searchParams.set('mode', 'exact');
    try {
      const res = await fetch(endpoint.toString(), {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': 'ai-edge-suppression/0.1',
        },
      });
      if (!res.ok) return null;
      const json = await res.json();
      return parseBacklinksStatsResponse(json);
    } catch {
      return null;
    }
  }
}

/**
 * Pure JSON-to-BacklinkCount mapper for the backlinks-stats response.
 * Extracted from AhrefsProvider.getBacklinks so the field-name mapping
 * can be unit-tested against a recorded fixture (locks the mapping
 * down so a future refactor can't silently regress it the way the
 * /metrics endpoint did).
 *
 * Returns null when the JSON shape is wholly wrong (no `metrics`
 * object); returns zeros when the shape is right but the URL has no
 * inbound data. Callers treat null and zeros differently: null = "we
 * couldn't tell," zeros = "API said this URL has nothing."
 */
export function parseBacklinksStatsResponse(
  json: unknown,
): BacklinkCount | null {
  if (!json || typeof json !== 'object') return null;
  const metrics = (json as { metrics?: unknown }).metrics;
  if (!metrics || typeof metrics !== 'object') return null;
  const m = metrics as { live?: unknown; live_refdomains?: unknown };
  const total = typeof m.live === 'number' ? m.live : 0;
  const refDomains =
    typeof m.live_refdomains === 'number' ? m.live_refdomains : 0;
  return { total, refDomains, provider: 'ahrefs' };
}

// ── DataForSEO adapter ────────────────────────────────────────────────

class DataForSEOProvider implements BacklinksProvider {
  name = 'dataforseo';
  private login: string;
  private password: string;
  constructor(login: string, password: string) {
    this.login = login;
    this.password = password;
  }
  async getBacklinks(url: string): Promise<BacklinkCount | null> {
    // DataForSEO Backlinks API — POST https://api.dataforseo.com/v3/backlinks/summary/live
    // Auth: HTTP Basic. Returns { tasks: [{ result: [{ backlinks, referring_domains }] }] }
    try {
      const credentials = Buffer.from(`${this.login}:${this.password}`).toString('base64');
      const res = await fetch('https://api.dataforseo.com/v3/backlinks/summary/live', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ target: url, internal_list_limit: 1 }]),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        tasks?: Array<{
          result?: Array<{ backlinks?: number; referring_domains?: number }>;
        }>;
      };
      const result = json?.tasks?.[0]?.result?.[0];
      if (!result) return null;
      return {
        total: result.backlinks ?? 0,
        refDomains: result.referring_domains ?? 0,
        provider: this.name,
      };
    } catch {
      return null;
    }
  }
}

// ── Null fallback ─────────────────────────────────────────────────────

class NullProvider implements BacklinksProvider {
  name = 'none';
  async getBacklinks(): Promise<BacklinkCount | null> {
    return { total: 0, refDomains: 0, provider: this.name };
  }
}

// ── Resolver ──────────────────────────────────────────────────────────

/**
 * Smoke check the Ahrefs provider on activation. We probe a known
 * high-backlink URL (nytimes.com — ~100k live ref-domains, stable for
 * the foreseeable future) and assert refDomains > 0. The check exists
 * because the wrong-endpoint failure mode (see history comment on
 * AhrefsProvider.getBacklinks above) was silent: HTTP 200, malformed
 * field names, every URL returns 0. A future endpoint rename or
 * auth-shape change at Ahrefs would exhibit the same shape, so we
 * gate activation on the probe.
 *
 * If the probe fails or returns 0, we log a clear warning and refuse
 * to activate the provider — the resolver falls through to DataForSEO
 * or NullProvider instead. That keeps the bad signal out of the
 * suppression decision flow rather than silently producing
 * methodology-wrong tickets.
 */
async function smokeCheckAhrefs(apiKey: string): Promise<boolean> {
  const probe = new AhrefsProvider(apiKey);
  const startMs = Date.now();
  try {
    const r = await probe.getBacklinks('https://www.nytimes.com/');
    const elapsedMs = Date.now() - startMs;
    if (!r || r.refDomains <= 0) {
      console.warn(
        `[AhrefsProvider] smoke check returned ${r?.refDomains ?? 'null'} ref-domains for nytimes.com after ${elapsedMs}ms — endpoint or auth likely broken. Falling back to next provider.`,
      );
      return false;
    }
    console.log(
      `[AhrefsProvider] smoke check OK — nytimes.com live_refdomains=${r.refDomains} live=${r.total} (${elapsedMs}ms)`,
    );
    return true;
  } catch (err) {
    console.warn(
      `[AhrefsProvider] smoke check threw, falling back: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// One-shot resolution per process — the smoke check is cheap (~600ms
// network roundtrip) but no reason to re-probe on every scan. The
// cached promise is shared across concurrent callers; first call pays
// the latency, subsequent calls are O(1).
let providerPromise: Promise<BacklinksProvider> | null = null;

async function resolveProvider(): Promise<BacklinksProvider> {
  const ahrefsKey = process.env.AHREFS_API_KEY;
  if (ahrefsKey && ahrefsKey.length > 0) {
    const healthy = await smokeCheckAhrefs(ahrefsKey);
    if (healthy) return new AhrefsProvider(ahrefsKey);
    // fall through to next provider if smoke check failed
  }
  const dfsLogin = process.env.DATAFORSEO_LOGIN;
  const dfsPassword = process.env.DATAFORSEO_PASSWORD;
  if (dfsLogin && dfsPassword) {
    return new DataForSEOProvider(dfsLogin, dfsPassword);
  }
  return new NullProvider();
}

/**
 * Pick the best-available provider based on env. Order of preference:
 *   1. Ahrefs (highest data quality, smoke-checked on activation)
 *   2. DataForSEO (good quality + bundled with SERP/AIO data)
 *   3. Null (no signal — preserves current behavior)
 *
 * Returning Null instead of throwing means the suppression scan stays
 * green on a tenant that hasn't procured any backlinks API; they just
 * keep getting 'noindex' for d > 0.55 like they always have.
 *
 * The promise is cached at module scope; first caller pays the smoke
 * check latency (~600ms), subsequent callers get the resolved provider
 * immediately. Re-runs of the suppression scanner inside the same
 * process reuse the cached provider.
 */
export function getBacklinksProvider(): Promise<BacklinksProvider> {
  if (!providerPromise) providerPromise = resolveProvider();
  return providerPromise;
}

/**
 * Test-only escape hatch. Resets the cached provider promise so a
 * subsequent getBacklinksProvider() call re-runs the resolver with
 * whatever env state is now in place. Not exported as a public API.
 */
export function __resetBacklinksProviderForTests(): void {
  providerPromise = null;
}

// ── Decision policy ───────────────────────────────────────────────────

export const REDIRECT_REF_DOMAIN_THRESHOLD = 5;

/**
 * Given a page's semantic distance and (optional) backlinks count,
 * return the suppression action to record. Pure function — no DB, no
 * env access, easy to test.
 */
export function decideSuppressionAction(
  distance: number,
  thresholds: { rewrite: number; suppress: number },
  backlinks: BacklinkCount | null,
): 'aligned' | 'rewrite' | 'redirect' | 'noindex' {
  if (distance <= thresholds.rewrite) return 'aligned';
  if (distance <= thresholds.suppress) return 'rewrite';
  // distance > suppress threshold — split between noindex and redirect.
  const refDomains = backlinks?.refDomains ?? 0;
  if (refDomains >= REDIRECT_REF_DOMAIN_THRESHOLD) return 'redirect';
  return 'noindex';
}

/**
 * Build a human-readable rationale for a finding, including the
 * backlinks signal when it was the deciding factor.
 */
export function buildRationale(
  distance: number,
  action: 'aligned' | 'rewrite' | 'redirect' | 'noindex',
  thresholds: { rewrite: number; suppress: number },
  backlinks: BacklinkCount | null,
): string {
  if (action === 'aligned') {
    return `Semantic distance ${distance.toFixed(3)} ≤ ${thresholds.rewrite} — aligned with Brand Truth.`;
  }
  if (action === 'rewrite') {
    return `Semantic distance ${distance.toFixed(3)} in (${thresholds.rewrite}, ${thresholds.suppress}] — rewrite to align with Brand Truth positioning while keeping on-page entities.`;
  }
  if (action === 'redirect') {
    const ref = backlinks?.refDomains ?? 0;
    return `Semantic distance ${distance.toFixed(3)} > ${thresholds.suppress} but the page has ${ref} referring domain${ref === 1 ? '' : 's'} (≥ ${REDIRECT_REF_DOMAIN_THRESHOLD} threshold). Issue a 301 redirect to the closest aligned page to preserve link equity.`;
  }
  // noindex
  const ref = backlinks?.refDomains ?? 0;
  if (backlinks && backlinks.provider !== 'none') {
    return `Semantic distance ${distance.toFixed(3)} > ${thresholds.suppress} and only ${ref} referring domain${ref === 1 ? '' : 's'} (< ${REDIRECT_REF_DOMAIN_THRESHOLD} threshold) — noindex; no link equity to preserve via redirect.`;
  }
  return `Semantic distance ${distance.toFixed(3)} > ${thresholds.suppress} — page doesn't reflect the Brand Truth; candidate for noindex (no backlinks provider configured to evaluate redirect path).`;
}
