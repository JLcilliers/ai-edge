/**
 * Sitemap-first crawler for the suppression scan.
 *
 * Responsibilities:
 *  - Fetch /sitemap.xml (and nested sitemap indices) from the firm's origin.
 *  - Dedupe + normalize URLs (drop fragments/query strings where they clearly
 *    identify the same page, limit to the firm's origin, HTML-looking only).
 *  - Cap the result at `maxUrls` so a pathological 10k-page sitemap doesn't
 *    blow the function's time/cost budget on a first pass.
 *
 * Non-goals (intentionally deferred):
 *  - robots.txt — for v1 we're only scanning sites the firm owns; the plan
 *    contemplates this in the Python worker path.
 *  - BFS fallback — if sitemap.xml is missing we surface an error rather
 *    than crawl. Firms we target reliably have sitemaps.
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
 * Discover URLs from a firm's sitemap.xml. Given any URL on the site, we
 * derive the origin and try `${origin}/sitemap.xml` — the convention every
 * modern CMS honors.
 */
export async function crawlViaSitemap(args: {
  firmSiteUrl: string;
  maxUrls?: number;
}): Promise<CrawlResult> {
  const maxUrls = args.maxUrls ?? 100;
  const origin = originOf(args.firmSiteUrl);
  const sitemapUrl = `${origin}/sitemap.xml`;

  const rootXml = await fetchSitemapXml(sitemapUrl);
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
