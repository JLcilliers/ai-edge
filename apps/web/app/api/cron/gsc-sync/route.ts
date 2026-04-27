import { getDb, gscConnections } from '@ai-edge/db';
import { syncFirmGscMetrics } from '../../../lib/gsc/client';
import { isAuthorizedCronRequest, unauthorizedResponse } from '../../../lib/cron/auth';
import { recordCronRun } from '../../../lib/cron/log';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Daily Search Console sync (Phase B #6).
 *
 * For every firm with a stored gsc_connection, pull the last 30 days of
 * daily clicks/impressions/ctr/position and upsert into
 * gsc_daily_metric. The visibility tab reads this table alongside the
 * audit citation rate to surface the canonical "did AIO eat our organic
 * clicks?" comparison.
 *
 * Frequency: nightly. Search Console data lags 2-3 days, but a daily
 * pull catches incremental refinements (Google revises recent days as
 * more spam filtering completes).
 *
 * Skip behavior: firms without a connection row don't appear in this
 * loop at all. There's no "Phase B #6 not configured" surface — the
 * cron silently does the right thing for the firms that have set up
 * the integration. Firms that haven't see "GSC not connected" in the
 * settings UI and an empty correlation panel.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedResponse();

  return recordCronRun('gsc-sync', async () => {
    console.log('[cron:gsc-sync] start');
    const db = getDb();
    const connections = await db
      .select({ firmId: gscConnections.firm_id })
      .from(gscConnections);

    const results: Array<{
      firmId: string;
      ok: boolean;
      rowsFetched?: number;
      reason?: string;
    }> = [];

    for (const c of connections) {
      try {
        const r = await syncFirmGscMetrics(c.firmId, { lookbackDays: 30 });
        if (r.ok) {
          results.push({
            firmId: c.firmId,
            ok: true,
            rowsFetched: r.rowsFetched,
          });
          console.log(`[cron:gsc-sync] ok firm=${c.firmId} rows=${r.rowsFetched}`);
        } else {
          results.push({ firmId: c.firmId, ok: false, reason: r.reason });
          console.log(`[cron:gsc-sync] skipped firm=${c.firmId} reason=${r.reason}`);
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        results.push({ firmId: c.firmId, ok: false, reason });
        console.error(`[cron:gsc-sync] error firm=${c.firmId}:`, e);
      }
    }

    const summary = {
      connections: connections.length,
      ok: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => !r.ok).length,
    };
    console.log('[cron:gsc-sync] done', summary);
    return { body: { ...summary, results }, summary };
  });
}
