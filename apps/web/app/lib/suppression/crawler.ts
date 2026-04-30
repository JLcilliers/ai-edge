/**
 * Sitemap-first crawler for the suppression scan.
 *
 * Responsibilities:
 *  - Discover the firm's sitemap URL(s) via robots.txt → falls back to
 *    common paths (/sitemap.xml, /sitemap_index.xml, /wp-sitemap.xml).
 *  - Walk sitemap indices and collect page URLs.
 *  - Dedupe + normalize URLs (drop fragments/query strings where they clearly
 *    identify the same page, limit to the firm's origin, HTML-looking only).
 *  - Cap the result at `maxUrls` so a pathological 10k-page sitemap doesn't
 *    blow the function's time/cost budget on a first pass.
 *
 * Discovery order (first hit wins):
 *   1. `${origin}/robots.txt` — parse `Sitemap:` directives. This is the
 *      RFC-9309-blessed canonical location and the one most large sites
 *      use (Nike, for example, has its sitemap at a non-standard URL but
 *      links it from robots.txt). When robots.txt advertises multiple
 *      sitemaps we use the first one on the same origin.
 *   2. `${origin}/sitemap.xml` — the de-facto convention.
 *   3. `${origin}/sitemap_index.xml` — common WordPress / Yoast convention.
 *   4. `${origin}/wp-sitemap.xml` — newer WP core convention.
 *   5. `${origin}/sitemap-index.xml` — variant convention.
 *
 * If every candidate 404s we throw with all attempted URLs in the message
 * so operators have something concrete to debug.
 *
 * Non-goals (intentionally deferred):
 *  - BFS fallback — if no sitemap can be discovered we surface an error
 *    rather than crawl. Firms we target reliably have sitemaps.
 */

const SITEMAP_INDEX_MATCH = /<sitemap>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/g;
const SITEMAP_URL_MATCH = /<url>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/g;

export interface CrawlResult {
  urls: string[];
  source: 'sitemap' | 'sitemap-index';
  discovered: number;
  capped: boolean;
}

async function fetchSitemapXml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'ai-edge-suppression/0.1 (brand audit)',
      Accept: 'application/xml,text/xml,*/*',
    },
  });
  if (!res.ok) {
    throw new Error(`sitemap fetch ${url} returned ${res.status}`);
  }
  return res.text();
}

/**
 * Parse either a sitemap index or a urlset. We don't bother with a proper
 * XML parser — the two top-level shapes only expose <loc> under either
 * <sitemap> or <url>, and pulling both via regex is robust enough for the
 * long tail of CMS-generated sitemaps (and tolerates namespaces in the root
 * element).
 */
function parseSitemap(xml: string): {
  kind: 'index' | 'urlset';
  locs: string[];
} {
  const isIndex = /<sitemapindex[^>]*>/i.test(xml);
  if (isIndex) {
    const locs: string[] = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(SITEMAP_INDEX_MATCH);
    while ((m = re.exec(xml)) !== null) {
      if (m[1]) locs.push(m[1].trim());
    }
    return { kind: 'index', locs };
  }

  const locs: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(SITEMAP_URL_MATCH);
  while ((m = re.exec(xml)) !== null) {
    if (m[1]) locs.push(m[1].trim());
  }
  return { kind: 'urlset', locs };
}

function originOf(input: string): string {
  try {
    const u = new URL(input);
    return `${u.protocol}//${u.host}`;
  } catch {
    throw new Error(`invalid origin URL: ${input}`);
  }
}

/** Strip known non-HTML extensions so we don't try to extract text from PDFs / images. */
function isHtmlish(url: string): boolean {
  const lower = url.toLowerCase().split('?')[0]?.split('#')[0] ?? '';
  if (!lower) return false;
  const denyExt = [
    '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico',
    '.css', '.js', '.mjs', '.json', '.xml', '.zip', '.rar', '.mp4', '.mp3',
    '.woff', '.woff2', '.ttf', '.otf', '.eot', '.doc', '.docx', '.xls',
    '.xlsx', '.ppt', '.pptx',
  ];
  return !denyExt.some((ext) => lower.endsWith(ext));
}

/** Discard URLs not on the firm's origin — don't crawl linked third parties. */
function sameOrigin(url: string, origin: string): boolean {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}` === origin;
  } catch {
    return false;
  }
}

/** Collapse trailing slash + fragment + known tracking query noise. */
function normalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    // Drop common tracking params; preserve ones that change content.
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'ref',
    ];
    for (const p of trackingParams) u.searchParams.delete(p);
    let out = u.toString();
    if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1);
    return out;
  } catch {
    return url;
  }
}

/**
 * Best-effort sitemap-URL discovery via robots.txt. Returns the first
 * `Sitemap:` directive that points at the same origin, or null if
 * robots.txt itself is missing / lists no sitemap / lists only off-origin
 * sitemaps. Off-origin sitemaps are dropped for SSRF safety + because the
 * suppression scan only crawls the firm's own origin anyway.
 */
async function discoverSitemapFromRobots(origin: string): Promise<string | null> {
  let body: string;
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: {
        'User-Agent': 'ai-edge-suppression/0.1 (brand audit)',
        Accept: 'text/plain,*/*',
      },
    });
    if (!res.ok) return null;
    body = await res.text();
  } catch {
    return null;
  }

  // Sitemap directives are case-insensitive per the de-facto convention.
  // One per line; we take the first that resolves to the same origin.
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*sitemap:\s*(\S+)/i.exec(line);
    if (!m || !m[1]) continue;
    const candidate = m[1].trim();
    try {
      const u = new URL(candidate);
      if (`${u.protocol}//${u.host}` === origin) return candidate;
    } catch {
      // Malformed Sitemap: directive — skip.
    }
  }
  return null;
}

/**
 * Common sitemap paths to probe when robots.txt fails to advertise one.
 * Order matters — `/sitemap.xml` is the canonical path that wins when
 * present on a CMS that supports it.
 */
const FALLBACK_SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/wp-sitemap.xml',
  '/sitemap-index.xml',
];

/**
 * Try a list of sitemap URLs in order, returning the first XML body
 * that fetches successfully. Records the URLs attempted so the error
 * message can name each one when ALL candidates fail.
 */
async function fetchFirstWorkingSitemap(
  candidates: string[],
): Promise<{ xml: string; url: string }> {
  const attempted: Array<{ url: string; status: string }> = [];
  for (const url of candidates) {
    try {
      const xml = await fetchSitemapXml(url);
      return { xml, url };
    } catch (err) {
      attempted.push({
        url,
        status: err instanceof Error ? err.message.replace(/^sitemap fetch \S+ /, '') : String(err),
      });
    }
  }
  throw new Error(
    `Could not find a sitemap. Tried ${attempted.length} location(s): ` +
      attempted.map((a) => `${a.url} (${a.status})`).join(' · ') +
      `. Add a "Sitemap: <url>" line to robots.txt or place sitemap.xml at the site root.`,
  );
}

/**
 * Discover URLs from a firm's sitemap. Tries robots.txt first (RFC-9309-
 * blessed canonical location), then falls back to common paths. Given any
 * URL on the site, we derive the origin and probe each candidate in turn.
 */
export async function crawlViaSitemap(args: {
  firmSiteUrl: string;
  maxUrls?: number;
}): Promise<CrawlResult> {
  const maxUrls = args.maxUrls ?? 100;
  const origin = originOf(args.firmSiteUrl);

  // Discover candidates: robots.txt-advertised sitemap (if any), then
  // the conventional fallback paths. Dedupe in case robots.txt happens
  // to advertise the same path as a fallback.
  const fromRobots = await discoverSitemapFromRobots(origin);
  const candidateUrls = new Set<string>();
  if (fromRobots) candidateUrls.add(fromRobots);
  for (const path of FALLBACK_SITEMAP_PATHS) candidateUrls.add(`${origin}${path}`);

  const { xml: rootXml } = await fetchFirstWorkingSitemap(Array.from(candidateUrls));
  const root = parseSitemap(rootXml);

  let urls: string[] = [];
  let source: CrawlResult['source'] = 'sitemap';

  if (root.kind === 'urlset') {
    urls = root.locs;
  } else {
    // Sitemap index — walk each child sitemap and collect urls. Cap at 10
    // children so a huge index doesn't make us fetch forever.
    source = 'sitemap-index';
    const children = root.locs.slice(0, 10);
    for (const child of children) {
      try {
        const childXml = await fetchSitemapXml(child);
        const parsed = parseSitemap(childXml);
        // Only merge urlsets — nested indices get skipped to keep it bounded.
        if (parsed.kind === 'urlset') urls.push(...parsed.locs);
      } catch {
        // Skip failing child sitemaps; log-level isn't important here.
      }
      if (urls.length >= maxUrls * 2) break; // Early exit to bound work.
    }
  }

  // Dedupe → same-origin → HTML-ish → cap.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const raw of urls) {
    const n = normalize(raw);
    if (seen.has(n)) continue;
    if (!sameOrigin(n, origin)) continue;
    if (!isHtmlish(n)) continue;
    seen.add(n);
    deduped.push(n);
  }

  const discovered = deduped.length;
  const capped = discovered > maxUrls;
  return {
    urls: capped ? deduped.slice(0, maxUrls) : deduped,
    source,
    discovered,
    capped,
  };
}
