import { captureSerpsForAllFirms } from '../../../lib/scenarios/serp-capture';
import { isAuthorizedCronRequest, unauthorizedResponse } from '../../../lib/cron/auth';
import { recordCronRun } from '../../../lib/cron/log';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Live SERP capture cron (Phase B #3).
 *
 * For every firm in the workspace, capture top Google organic SERPs for
 * the firm's `seed_query_intents` via DataForSEO. Persists each as a new
 * `serp_snapshot` (provider='dataforseo') with up to 10 ranked
 * `serp_result` rows.
 *
 * History: previously used Bing Web Search v7 (free tier, 1,000 queries
 * /month), but Microsoft retired the Bing Search API on Aug 11, 2025.
 * Swapped to DataForSEO — credentials already provisioned for AIO
 * capture, ~$0.0006/query for Google organic SERP. 5 queries/firm/week
 * × 4 weeks × 50 firms ≈ $0.60/month. See `lib/scenarios/serp-capture.ts`
 * header for rationale.
 *
 * Frequency: weekly recommended (vercel.ts cron schedule). The
 * captureSerpsForFirm helper enforces a per-firm cap (default 5
 * queries) so the cron stays inside bounded cost.
 *
 * Graceful skip: if DataForSEO credentials are not set, every per-firm
 * call returns ok=false reason='DATAFORSEO credentials not set' and the
 * cron records a `skipped: N` summary without touching the DB further.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedResponse();

  return recordCronRun('serp-capture', async () => {
    console.log('[cron:serp-capture] start');
    const outcome = await captureSerpsForAllFirms({ count: 10, maxQueries: 5 });
    console.log('[cron:serp-capture] done', {
      firmsScanned: outcome.firmsScanned,
      totalSucceeded: outcome.totalSucceeded,
      totalSkipped: outcome.totalSkipped,
      totalFailed: outcome.totalFailed,
    });
    return {
      body: {
        firmsScanned: outcome.firmsScanned,
        totalSucceeded: outcome.totalSucceeded,
        totalSkipped: outcome.totalSkipped,
        totalFailed: outcome.totalFailed,
        perFirm: outcome.perFirm.map((f) => ({
          slug: f.slug,
          attempted: f.outcome.attempted,
          succeeded: f.outcome.succeeded,
          skipped: f.outcome.skipped,
          failed: f.outcome.failed,
        })),
      },
      summary: {
        firmsScanned: outcome.firmsScanned,
        ok: outcome.totalSucceeded,
        skipped: outcome.totalSkipped,
        errored: outcome.totalFailed,
      },
    };
  });
}
