import * as cheerio from 'cheerio';
import type { FirmType } from '@ai-edge/shared';

/**
 * Schema.org JSON-LD scanner (PLAN §5.6 item 1).
 *
 * Pulls a page's HTML, extracts every `<script type="application/ld+json">`
 * block, parses, and walks the graph (handles both `@graph` arrays and loose
 * top-level objects). Returns a flat list of the Schema.org `@type`s that
 * appear anywhere on the page plus a per-type breakdown so the UI can
 * render "LegalService ✓ / Person ✗".
 *
 * Why home page only (for V1):
 *   - A firm's home page is where the canonical `Organization` / `LocalBusiness`
 *     JSON-LD almost always lives. That's the block that feeds the Google
 *     Knowledge Panel and LLM attribution.
 *   - About / team / service pages matter too, but sitemap-wide scanning
 *     belongs in the suppression crawler path, not here. For V1 the home
 *     page catches ~80% of signal at 1/Nth the cost.
 */

export interface JsonLdFinding {
  url: string;
  typesFound: string[]; // deduped, sorted
  blocks: Array<{ type: string; raw: unknown }>; // preserve per-block detail for future UI drill-downs
  errors: string[]; // non-fatal parse failures
  /**
   * `true` when the page fetch itself failed (HTTP non-2xx, network error,
   * or WAF block page). Distinguishes "we couldn't see what's on the page"
   * from "we read the page and it has no schema" — the former is an
   * infrastructure issue (residential proxy needed for WAF-protected sites
   * per ADR-0010), the latter is a real schema gap. Without this flag the
   * orchestrator would emit `schema:missing_Organization` for sites we
   * never even reached, and the dashboard would tell the operator to add
   * markup that's already there.
   */
  fetchBlocked: boolean;
  /** HTTP status when fetch returned non-2xx; null on network failure or success. */
  httpStatus: number | null;
}

/**
 * What types SHOULD show up for a given firm type. Missing expected types
 * are the primary "gap" signal the UI raises.
 *
 * We keep this list *narrow* — only types that genuinely affect how Google /
 * Bing / LLMs understand the firm. Adding "Review" here means "we expect
 * review markup"; that's the kind of thing an operator can actually fix.
 */
export const EXPECTED_TYPES_BY_FIRM: Record<FirmType, string[]> = {
  law_firm: ['LegalService', 'Organization', 'Person', 'PostalAddress'],
  dental_practice: ['Dentist', 'MedicalBusiness', 'Organization', 'PostalAddress'],
  marketing_agency: ['Organization', 'ProfessionalService', 'PostalAddress'],
  other: ['Organization', 'PostalAddress'],
};

/**
 * Types that are nice-to-have across every firm type — additive signal
 * but not critical to flag as a gap. We surface them as "recommended"
 * in the UI.
 */
export const RECOMMENDED_TYPES: string[] = [
  'FAQPage',
  'BreadcrumbList',
  'WebSite',
  'Review',
  'AggregateRating',
];

/**
 * Recursively collect every `@type` string found in a JSON-LD node.
 * Handles both:
 *   - `{"@type": "Organization"}`
 *   - `{"@type": ["Organization", "LegalService"]}`
 *   - `{"@graph": [...]}`
 *   - Nested sub-objects (mainEntity, address, etc).
 */
function collectTypes(node: unknown, acc: string[] = []): string[] {
  if (!node) return acc;

  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, acc);
    return acc;
  }

  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const t = obj['@type'];
    if (typeof t === 'string') {
      acc.push(t);
    } else if (Array.isArray(t)) {
      for (const tt of t) if (typeof tt === 'string') acc.push(tt);
    }

    // Recurse into every value — JSON-LD nests entities deep (e.g. a
    // LegalService's `address` is a PostalAddress with its own @type).
    for (const key of Object.keys(obj)) {
      if (key === '@type') continue;
      collectTypes(obj[key], acc);
    }
  }

  return acc;
}

/**
 * Find each top-level "@type" (or @graph entry) so we can keep raw JSON
 * alongside the flattened type list — useful for the UI preview and for
 * the patch generator deciding "do we ALREADY have Organization? skip it."
 */
function topLevelBlocks(
  node: unknown,
): Array<{ type: string; raw: unknown }> {
  const out: Array<{ type: string; raw: unknown }> = [];
  if (!node || typeof node !== 'object') return out;

  const arr = Array.isArray(node) ? node : [node];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const graph = obj['@graph'];
    if (Array.isArray(graph)) {
      for (const g of graph) {
        if (g && typeof g === 'object') {
          const t = (g as Record<string, unknown>)['@type'];
          out.push({
            type: typeof t === 'string' ? t : Array.isArray(t) ? t.join(',') : 'Thing',
            raw: g,
          });
        }
      }
    } else {
      const t = obj['@type'];
      out.push({
        type: typeof t === 'string' ? t : Array.isArray(t) ? t.join(',') : 'Thing',
        raw: obj,
      });
    }
  }
  return out;
}

export async function scanJsonLd(url: string): Promise<JsonLdFinding> {
  const errors: string[] = [];
  const blocks: JsonLdFinding['blocks'] = [];
  const allTypes: string[] = [];

  let html: string;
  let httpStatus: number | null = null;
  try {
    const res = await fetch(url, {
      headers: {
        // Browser-compatible UA in the conventional `(compatible; <bot>; +<url>)`
        // format Googlebot uses. Improves the success rate against WAFs that
        // refuse plain `curl/`-style or `app-name/version` UAs while still
        // identifying us honestly. WAFs that fingerprint by IP (e.g.
        // adidas.com's Cloudflare config) still 403 — those need the
        // Playwright + residential-proxy worker per ADR-0010.
        'User-Agent':
          'Mozilla/5.0 (compatible; ai-edge-bot/0.1; +https://clixsy.com)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    httpStatus = res.status;
    if (!res.ok) {
      // 4xx/5xx with no body access — distinguish in the return value so the
      // orchestrator can write a `schema:fetch_blocked` flag rather than
      // claiming the page is missing schema it might actually have.
      return {
        url,
        typesFound: [],
        blocks: [],
        errors: [`${url} returned ${res.status}`],
        fetchBlocked: true,
        httpStatus,
      };
    }
    html = await res.text();
  } catch (err) {
    // Network-level failure (DNS, TCP, TLS, etc.). Also fetch-blocked.
    return {
      url,
      typesFound: [],
      blocks: [],
      errors: [`fetch failed: ${String(err)}`],
      fetchBlocked: true,
      httpStatus,
    };
  }

  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]');

  scripts.each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      blocks.push(...topLevelBlocks(parsed));
      collectTypes(parsed, allTypes);
    } catch (err) {
      // Some sites publish invalid JSON-LD — don't abort the whole scan.
      errors.push(`json-ld parse error: ${String(err).slice(0, 120)}`);
    }
  });

  const typesFound = Array.from(new Set(allTypes)).sort();
  return { url, typesFound, blocks, errors, fetchBlocked: false, httpStatus };
}

/**
 * Diff a scan against what a firm of `firmType` is expected to have.
 * Returns missing required types + missing recommended types separately
 * so the UI can prioritize the "red" items.
 */
export function diffExpectedTypes(
  firmType: FirmType,
  typesFound: string[],
): {
  missingRequired: string[];
  missingRecommended: string[];
  presentRequired: string[];
} {
  const present = new Set(typesFound);
  const required = EXPECTED_TYPES_BY_FIRM[firmType] ?? EXPECTED_TYPES_BY_FIRM.other;
  const missingRequired = required.filter((t) => !present.has(t));
  const presentRequired = required.filter((t) => present.has(t));
  const missingRecommended = RECOMMENDED_TYPES.filter((t) => !present.has(t));
  return { missingRequired, missingRecommended, presentRequired };
}
