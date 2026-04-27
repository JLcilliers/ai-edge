import {
  getDb,
  firms,
  serpSnapshots,
  serpResults,
  brandTruthVersions,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { eq, desc } from 'drizzle-orm';

/**
 * Live SERP capture via Bing Web Search v7 (Phase B #3).
 *
 * Why Bing not Google. Google doesn't expose a SERP API to third parties
 * — every option (SerpAPI, DataForSEO, ScrapingBee, Bright Data) wraps
 * Google scraping behind a paid abstraction. Bing Web Search v7 has a
 * free tier on Azure (1,000 transactions/month with the F1 / Free pricing
 * tier) and returns a clean JSON response. For a v1 calibration corpus,
 * Bing rankings are a usable proxy for Google rankings on most queries —
 * not perfect, but good enough to learn directional weights and
 * directional rank deltas. When DataForSEO or SerpAPI procurement
 * happens, we wire them as additional providers behind the same
 * `serp_snapshot.provider` discriminator.
 *
 * Auth. Set `BING_SEARCH_API_KEY` (Azure resource → Cognitive Services →
 * Bing Search v7 → Keys and Endpoint). The free tier is rate-limited to
 * 3 transactions/second; we run sequentially with no extra throttle and
 * never exceed it.
 *
 * Graceful no-op. If `BING_SEARCH_API_KEY` is not set, every call returns
 * `{ ok: false, reason: 'BING_SEARCH_API_KEY not set' }` rather than
 * throwing. The cron route surfaces this as a "skipped" status so the
 * admin dashboard doesn't fill up with noise on tenants that haven't
 * provisioned the key yet.
 */

const BING_ENDPOINT =
  'https://api.bing.microsoft.com/v7.0/search';

interface BingWebPageResult {
  name?: string;
  url?: string;
  snippet?: string;
}

interface BingResponse {
  webPages?: {
    value?: BingWebPageResult[];
  };
}

export interface SerpCaptureSuccess {
  ok: true;
  snapshotId: string;
  resultCount: number;
}

export interface SerpCaptureSkipped {
  ok: false;
  reason: string;
}

export type SerpCaptureOutcome = SerpCaptureSuccess | SerpCaptureSkipped;

function safeHostFromUrl(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Capture a single SERP for (firmId, query). The caller decides which
 * queries to capture; this function is just the "fetch + persist" unit.
 */
export async function captureSerpViaBing(
  firmId: string,
  query: string,
  options: { count?: number; market?: string } = {},
): Promise<SerpCaptureOutcome> {
  const apiKey = process.env.BING_SEARCH_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'BING_SEARCH_API_KEY not set' };
  }
  const count = Math.max(1, Math.min(50, options.count ?? 10));
  const market = options.market ?? 'en-US';

  // Resolve firm host so we can flag is_target on the firm's own URLs.
  const db = getDb();
  const [btv] = await db
    .select({ payload: brandTruthVersions.payload })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  const bt = (btv?.payload ?? null) as BrandTruth | null;
  const primaryUrl = (bt as { primary_url?: string } | null)?.primary_url ?? null;
  const firmHost = primaryUrl ? safeHostFromUrl(primaryUrl) : '';

  const url = new URL(BING_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  url.searchParams.set('mkt', market);
  url.searchParams.set('responseFilter', 'Webpages');
  // textDecorations=false keeps the response clean of <b> tags.
  url.searchParams.set('textDecorations', 'false');

  let json: BingResponse;
  try {
    const res = await fetch(url.toString(), {
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'User-Agent': 'ai-edge-serp-capture/0.1',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        reason: `bing returned ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    json = (await res.json()) as BingResponse;
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  const value = json.webPages?.value ?? [];
  if (value.length === 0) {
    // Successful API hit but no results — persist an empty snapshot so the
    // operator can see we ran and Bing simply had no matches.
    const [snap] = await db
      .insert(serpSnapshots)
      .values({
        firm_id: firmId,
        query,
        provider: 'bing-web-search',
        country: market.split('-')[1] ?? null,
        language: market.split('-')[0] ?? null,
        raw: json as unknown as Record<string, unknown>,
        notes: 'Bing returned 0 webPages',
      })
      .returning({ id: serpSnapshots.id });
    return { ok: true, snapshotId: snap!.id, resultCount: 0 };
  }

  const [snap] = await db
    .insert(serpSnapshots)
    .values({
      firm_id: firmId,
      query,
      provider: 'bing-web-search',
      country: market.split('-')[1] ?? null,
      language: market.split('-')[0] ?? null,
      raw: json as unknown as Record<string, unknown>,
    })
    .returning({ id: serpSnapshots.id });

  // Bing returns results in order; we use index as the position.
  const rows = value.map((r, i) => {
    const resultUrl = r.url ?? '';
    const host = safeHostFromUrl(resultUrl);
    return {
      snapshot_id: snap!.id,
      position: i + 1,
      url: resultUrl,
      domain: host,
      title: r.name ?? null,
      snippet: r.snippet ?? null,
      is_target: !!firmHost && host === firmHost,
    };
  });
  // Filter rows with empty URL — defensive against malformed Bing payloads.
  const safeRows = rows.filter((r) => r.url.length > 0);
  if (safeRows.length > 0) {
    await db.insert(serpResults).values(safeRows);
  }

  return {
    ok: true,
    snapshotId: snap!.id,
    resultCount: safeRows.length,
  };
}

/**
 * Capture SERPs for multiple seed queries on a firm. Default behavior:
 * pull the firm's `seed_query_intents` from Brand Truth and capture the
 * top N (cap to keep per-run cost bounded — ~$0/query on Bing free tier
 * but cron budgets are still finite).
 */
export interface BulkCaptureOptions {
  /** Override the queries to capture; default = Brand Truth seed_query_intents */
  queries?: string[];
  /** Max queries to capture per call (cron-budget-friendly default = 5). */
  maxQueries?: number;
  count?: number;
  market?: string;
}

export interface BulkCaptureOutcome {
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
  perQuery: Array<{ query: string; outcome: SerpCaptureOutcome }>;
}

export async function captureSerpsForFirm(
  firmId: string,
  options: BulkCaptureOptions = {},
): Promise<BulkCaptureOutcome> {
  const db = getDb();

  let queries = options.queries;
  if (!queries) {
    const [btv] = await db
      .select({ payload: brandTruthVersions.payload })
      .from(brandTruthVersions)
      .where(eq(brandTruthVersions.firm_id, firmId))
      .orderBy(desc(brandTruthVersions.version))
      .limit(1);
    const bt = (btv?.payload ?? null) as BrandTruth | null;
    queries = bt?.seed_query_intents ?? [];
  }
  const max = Math.max(1, options.maxQueries ?? 5);
  const subset = queries.slice(0, max);

  const perQuery: BulkCaptureOutcome['perQuery'] = [];
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  for (const q of subset) {
    const outcome = await captureSerpViaBing(firmId, q, {
      count: options.count,
      market: options.market,
    });
    perQuery.push({ query: q, outcome });
    if (outcome.ok) succeeded += 1;
    else if (outcome.reason === 'BING_SEARCH_API_KEY not set') skipped += 1;
    else failed += 1;
  }

  return { attempted: subset.length, succeeded, skipped, failed, perQuery };
}

/**
 * Cron-style wrapper: capture SERPs for every firm in the workspace.
 * Used by /api/cron/serp-capture. Returns a summary suitable for the
 * cron observability log.
 */
export async function captureSerpsForAllFirms(
  options: BulkCaptureOptions = {},
): Promise<{
  firmsScanned: number;
  totalSucceeded: number;
  totalSkipped: number;
  totalFailed: number;
  perFirm: Array<{ slug: string; outcome: BulkCaptureOutcome }>;
}> {
  const db = getDb();
  const allFirms = await db
    .select({ id: firms.id, slug: firms.slug })
    .from(firms);
  const perFirm: Array<{ slug: string; outcome: BulkCaptureOutcome }> = [];
  let totalSucceeded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  for (const f of allFirms) {
    const outcome = await captureSerpsForFirm(f.id, options);
    perFirm.push({ slug: f.slug, outcome });
    totalSucceeded += outcome.succeeded;
    totalSkipped += outcome.skipped;
    totalFailed += outcome.failed;
  }
  return {
    firmsScanned: allFirms.length,
    totalSucceeded,
    totalSkipped,
    totalFailed,
    perFirm,
  };
}
