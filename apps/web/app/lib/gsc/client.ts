import { getDb, gscConnections, gscDailyMetrics } from '@ai-edge/db';
import { eq, desc, and, gte, lte } from 'drizzle-orm';
import { getValidAccessToken } from './oauth';

/**
 * Search Console SearchAnalytics adapter (Phase B #6).
 *
 * Pulls daily clicks/impressions/ctr/position for the firm's GSC
 * property and persists into `gsc_daily_metric`. The visibility tab
 * reads these alongside audit citation rates so the operator can
 * compare "did Google AI Overviews eat our organic clicks?" — the
 * canonical Phase B framing.
 *
 * API. POST searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
 * Body: { startDate, endDate, dimensions: ['date'], rowLimit }
 * Returns: { rows: [{ keys: [date], clicks, impressions, ctr, position }] }
 *
 * Rate. Default Search Console quota: 1,200 queries/min, 50/min/user.
 * Per-firm sync = 1 query, so even a 100-firm workspace stays well
 * under the budget. We sync sequentially in the cron — no need to
 * fan out.
 */

const SEARCH_ANALYTICS_ENDPOINT = (siteUrl: string) =>
  `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    siteUrl,
  )}/searchAnalytics/query`;

export interface DailyMetricRow {
  date: string; // YYYY-MM-DD
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface SearchAnalyticsResponse {
  rows?: Array<{
    keys?: string[];
    clicks?: number;
    impressions?: number;
    ctr?: number;
    position?: number;
  }>;
}

/**
 * Fetch daily metrics for a date range from Search Console. Returns
 * the raw rows; the caller persists them. Pure function (no DB
 * writes) so it can be reused for ad-hoc operator queries from the
 * UI later.
 */
export async function fetchDailyMetrics(args: {
  firmId: string;
  startDate: string;
  endDate: string;
  rowLimit?: number;
}): Promise<DailyMetricRow[]> {
  const { accessToken, siteUrl } = await getValidAccessToken(args.firmId);
  const res = await fetch(SEARCH_ANALYTICS_ENDPOINT(siteUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: ['date'],
      rowLimit: args.rowLimit ?? 1000,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `searchAnalytics.query returned ${res.status}: ${body.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as SearchAnalyticsResponse;
  const rows = json.rows ?? [];
  return rows
    .map((r) => ({
      date: r.keys?.[0] ?? '',
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    }))
    .filter((r) => r.date.length === 10);
}

/**
 * Sync the last N days for a firm. Idempotent: upserts by (firm, date)
 * so re-running today won't duplicate yesterday's row.
 *
 * Default lookback = 30 days. Search Console data has a 2-3 day delay
 * by design, so we don't bother asking for "today" — the API just
 * returns nothing for days that haven't aggregated yet.
 */
export interface SyncOutcome {
  ok: true;
  rowsFetched: number;
  rowsUpserted: number;
}

export interface SyncSkipped {
  ok: false;
  reason: string;
}

export type SyncResult = SyncOutcome | SyncSkipped;

export async function syncFirmGscMetrics(
  firmId: string,
  options: { lookbackDays?: number } = {},
): Promise<SyncResult> {
  const db = getDb();
  const [conn] = await db
    .select({ id: gscConnections.firm_id })
    .from(gscConnections)
    .where(eq(gscConnections.firm_id, firmId))
    .limit(1);
  if (!conn) {
    return { ok: false, reason: 'No GSC connection for firm' };
  }
  const lookback = options.lookbackDays ?? 30;
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2); // GSC data lags ~2 days
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - lookback);

  const rows = await fetchDailyMetrics({
    firmId,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  });

  let upserted = 0;
  for (const row of rows) {
    // Try update first; if 0 rows match, insert. Drizzle has no native
    // ON CONFLICT helper for this composite key but the cycle is short
    // (max ~30 rows per sync) so the extra round-trip is fine.
    const updated = await db
      .update(gscDailyMetrics)
      .set({
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        fetched_at: new Date(),
      })
      .where(
        and(
          eq(gscDailyMetrics.firm_id, firmId),
          eq(gscDailyMetrics.date, row.date),
        ),
      )
      .returning({ id: gscDailyMetrics.id });
    if (updated.length === 0) {
      await db.insert(gscDailyMetrics).values({
        firm_id: firmId,
        date: row.date,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      });
    }
    upserted += 1;
  }

  await db
    .update(gscConnections)
    .set({ last_synced_at: new Date(), last_sync_error: null })
    .where(eq(gscConnections.firm_id, firmId));

  return { ok: true, rowsFetched: rows.length, rowsUpserted: upserted };
}

/**
 * Read API for the visibility-tab correlation panel. Returns the last
 * N days of metrics. Empty array when GSC isn't connected — caller
 * decides how to render that.
 */
export async function getRecentDailyMetrics(
  firmId: string,
  daysBack: number = 30,
): Promise<DailyMetricRow[]> {
  const db = getDb();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - daysBack);
  const cutoff = since.toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(gscDailyMetrics)
    .where(
      and(
        eq(gscDailyMetrics.firm_id, firmId),
        gte(gscDailyMetrics.date, cutoff),
      ),
    )
    .orderBy(desc(gscDailyMetrics.date));
  return rows.map((r) => ({
    date: r.date,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

export async function getGscConnectionStatus(firmId: string): Promise<{
  connected: boolean;
  siteUrl: string | null;
  connectedAt: Date | null;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
}> {
  const db = getDb();
  const [conn] = await db
    .select()
    .from(gscConnections)
    .where(eq(gscConnections.firm_id, firmId))
    .limit(1);
  if (!conn) {
    return {
      connected: false,
      siteUrl: null,
      connectedAt: null,
      lastSyncedAt: null,
      lastSyncError: null,
    };
  }
  return {
    connected: true,
    siteUrl: conn.site_url,
    connectedAt: conn.connected_at,
    lastSyncedAt: conn.last_synced_at,
    lastSyncError: conn.last_sync_error,
  };
}
