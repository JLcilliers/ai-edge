import { captureSerpsForAllFirms } from '../../../lib/scenarios/serp-capture';
import { isAuthorizedCronRequest, unauthorizedResponse } from '../../../lib/cron/auth';
import { recordCronRun } from '../../../lib/cron/log';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Live SERP capture cron (Phase B #3).
 *
 * For every firm in the workspace, capture top SERPs for the firm's
 * `seed_query_intents` via Bing Web Search v7. Persists each as a new
 * `serp_snapshot` (provider='bing-web-search') with up to 10 ranked
 * `serp_result` rows.
 *
 * Frequency: weekly recommended (vercel.ts cron schedule). Bing Web
 * Search free tier is 1,000 queries/month; capping at 5 queries per
 * firm per week + 4 weeks = 20 queries/firm/month → 50 firms before
 * we exceed the free quota. The captureSerpsForFirm helper enforces
 * the per-firm cap.
 *
 * Graceful skip: if BING_SEARCH_API_KEY is not set, every per-firm
 * call returns ok=false reason='BING_SEARCH_API_KEY not set' and the
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
