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
    //   GET https://api.ahrefs.com/v3/site-explorer/metrics?target=<url>
    //         &date=YYYY-MM-DD&mode=exact
    //   Authorization: Bearer <key>
    //   Returns: { metrics: { backlinks: number, refdomains: number, ... } }
    const date = new Date().toISOString().slice(0, 10);
    const endpoint = new URL('https://api.ahrefs.com/v3/site-explorer/metrics');
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
      const json = (await res.json()) as {
        metrics?: { backlinks?: number; refdomains?: number };
      };
      const total = json?.metrics?.backlinks ?? 0;
      const refDomains = json?.metrics?.refdomains ?? 0;
      return { total, refDomains, provider: this.name };
    } catch {
      return null;
    }
  }
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
 * Pick the best-available provider based on env. Order of preference:
 *   1. Ahrefs (highest data quality)
 *   2. DataForSEO (good quality + bundled with SERP/AIO data)
 *   3. Null (no signal — preserves current behavior)
 *
 * Returning Null instead of throwing means the suppression scan stays
 * green on a tenant that hasn't procured any backlinks API; they just
 * keep getting 'noindex' for d > 0.55 like they always have.
 */
export function getBacklinksProvider(): BacklinksProvider {
  const ahrefsKey = process.env.AHREFS_API_KEY;
  if (ahrefsKey && ahrefsKey.length > 0) {
    return new AhrefsProvider(ahrefsKey);
  }
  const dfsLogin = process.env.DATAFORSEO_LOGIN;
  const dfsPassword = process.env.DATAFORSEO_PASSWORD;
  if (dfsLogin && dfsPassword) {
    return new DataForSEOProvider(dfsLogin, dfsPassword);
  }
  return new NullProvider();
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
