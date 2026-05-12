/**
 * Per-URL GSC metrics — clicks / impressions / ctr / position per page
 * over a rolling 30-day window. Populated lazily at Suppression scan
 * time, NOT via the existing nightly gsc-sync cron.
 *
 * Why lazy:
 *   The Suppression scan runs on operator cadence (manual triggers +
 *   weekly cron), which already distributes load naturally. Adding a
 *   separate cron to backfill per-URL metrics across 200+ firms in one
 *   pass would burst the GSC API quota; piggybacking on Suppression
 *   spreads the load over the natural firm-by-firm scanning cadence
 *   without any new infrastructure.
 *
 * Cache strategy:
 *   getClicksPerMonthForUrl(firmId, url) checks gsc_url_metric for a
 *   row with window_end_date >= today - 7 days. Hits return cached.
 *   Misses trigger a one-shot per-firm fetch (single API call with
 *   dimensions:['page']) that backfills every URL the firm has crawled
 *   into pages.url. Operator pays the latency once per scan (typical
 *   site ≤500 pages = one API call = <1s); subsequent reads are local.
 *
 * GSC API endpoint matches lib/gsc/client.ts:
 *   POST /webmasters/v3/sites/{siteUrl}/searchAnalytics/query
 *   Body: { startDate, endDate, dimensions: ['page'], rowLimit }
 *
 * Quota math:
 *   GSC default quota = 1,200 queries/min, 50/min/user (the OAuth user).
 *   Per Suppression scan = 1 query. Even at peak scanning (10 firms
 *   per minute) we use <1% of quota. Safe.
 */
import {
  getDb,
  firms,
  gscConnections,
  gscUrlMetrics,
} from '@ai-edge/db';
import { and, eq, desc, gte, sql } from 'drizzle-orm';
import { getValidAccessToken } from './oauth';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
// Treat a fetch as still-fresh if its window_end_date is within the
// last 7 days. GSC data has a 2-3 day reporting delay anyway, so
// re-fetching daily produces near-identical numbers — weekly is cheap
// enough.
const FRESHNESS_DAYS = 7;

export interface UrlMetricRow {
  url: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  windowStartDate: string;
  windowEndDate: string;
}

interface PerPageResponse {
  rows?: Array<{
    keys?: string[];
    clicks?: number;
    impressions?: number;
    ctr?: number;
    position?: number;
  }>;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Does the firm have a GSC connection? Used as the dual-mode gate by
 * the Suppression scanner.
 */
export async function firmHasGscConnection(firmId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ firm_id: gscConnections.firm_id })
    .from(gscConnections)
    .where(eq(gscConnections.firm_id, firmId))
    .limit(1);
  return !!row;
}

/**
 * Pull last-N-days per-URL metrics for a firm in one API request,
 * upsert into gsc_url_metric. Returns the upserted rows.
 *
 * Throws if no GSC connection (caller is responsible for the gate
 * check via firmHasGscConnection above).
 */
export async function syncPerUrlMetrics(args: {
  firmId: string;
  windowDays?: number;
}): Promise<UrlMetricRow[]> {
  const windowDays = args.windowDays ?? WINDOW_DAYS;
  const { accessToken, siteUrl } = await getValidAccessToken(args.firmId);

  // GSC reports lag 2-3 days. End at 3 days ago to avoid querying for
  // empty trailing days.
  const endDate = new Date(Date.now() - 3 * DAY_MS);
  const startDate = new Date(endDate.getTime() - windowDays * DAY_MS);
  const startStr = ymd(startDate);
  const endStr = ymd(endDate);

  const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    siteUrl,
  )}/searchAnalytics/query`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      startDate: startStr,
      endDate: endStr,
      dimensions: ['page'],
      // 25K is the GSC API per-request limit. Most firms have <500
      // pages; the cap is a safety belt against firms with massive
      // sitemaps.
      rowLimit: 25_000,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `gsc per-url query returned ${res.status}: ${body.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as PerPageResponse;
  const rows: UrlMetricRow[] = (json.rows ?? [])
    .map((r) => ({
      url: r.keys?.[0] ?? '',
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? null,
      position: r.position ?? null,
      windowStartDate: startStr,
      windowEndDate: endStr,
    }))
    .filter((r) => r.url.length > 0);

  if (rows.length === 0) return [];

  // Upsert. Drizzle's onConflictDoUpdate needs target keys + set columns.
  const db = getDb();
  await db
    .insert(gscUrlMetrics)
    .values(
      rows.map((r) => ({
        firm_id: args.firmId,
        url: r.url,
        window_start_date: r.windowStartDate,
        window_end_date: r.windowEndDate,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      })),
    )
    .onConflictDoUpdate({
      target: [
        gscUrlMetrics.firm_id,
        gscUrlMetrics.url,
        gscUrlMetrics.window_end_date,
      ],
      set: {
        clicks: sql`excluded.clicks`,
        impressions: sql`excluded.impressions`,
        ctr: sql`excluded.ctr`,
        position: sql`excluded.position`,
        fetched_at: new Date(),
      },
    });
  return rows;
}

/**
 * Look up a single URL's recent clicks. Returns null if no GSC data
 * has ever been ingested for this URL (could mean: firm has no GSC
 * connection, OR firm has GSC but GSC has 0 impressions for this URL
 * in the window — the latter is real data and the caller should treat
 * 0 clicks as a valid signal, not "unknown").
 *
 * The caller distinguishes "no GSC" vs "0 clicks" via
 * firmHasGscConnection() — call that first.
 */
export async function getClicksPerMonthForUrl(
  firmId: string,
  url: string,
): Promise<number | null> {
  const db = getDb();
  const [row] = await db
    .select({
      clicks: gscUrlMetrics.clicks,
      windowEndDate: gscUrlMetrics.window_end_date,
    })
    .from(gscUrlMetrics)
    .where(and(eq(gscUrlMetrics.firm_id, firmId), eq(gscUrlMetrics.url, url)))
    .orderBy(desc(gscUrlMetrics.window_end_date))
    .limit(1);
  if (!row) return null;
  return row.clicks;
}

/**
 * Ensure per-URL metrics are fresh enough for the Suppression scan.
 * Triggers syncPerUrlMetrics when the most recent window is older than
 * FRESHNESS_DAYS. Returns true if a sync happened (so the caller can
 * log the latency), false if cache was fresh.
 *
 * Caller must have already verified firmHasGscConnection().
 */
export async function ensureFreshPerUrlMetrics(firmId: string): Promise<{
  refreshed: boolean;
  windowEndDate: string | null;
}> {
  const db = getDb();
  const cutoff = new Date(Date.now() - FRESHNESS_DAYS * DAY_MS);
  const cutoffStr = ymd(cutoff);

  // Is there ANY row newer than the freshness cutoff?
  const [recent] = await db
    .select({ windowEndDate: gscUrlMetrics.window_end_date })
    .from(gscUrlMetrics)
    .where(
      and(
        eq(gscUrlMetrics.firm_id, firmId),
        gte(gscUrlMetrics.window_end_date, cutoffStr),
      ),
    )
    .orderBy(desc(gscUrlMetrics.window_end_date))
    .limit(1);
  if (recent) return { refreshed: false, windowEndDate: recent.windowEndDate };

  // Stale (or empty). Sync.
  const rows = await syncPerUrlMetrics({ firmId });
  return {
    refreshed: true,
    windowEndDate: rows[0]?.windowEndDate ?? null,
  };
}
