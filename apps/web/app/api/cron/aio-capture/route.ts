import { captureAioForAllFirms } from '../../../lib/aio/capture';
import { isAuthorizedCronRequest, unauthorizedResponse } from '../../../lib/cron/auth';
import { recordCronRun } from '../../../lib/cron/log';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Weekly AI Overview capture (Phase B #7).
 *
 * For each firm in the workspace, fetches Google AI Overview panels
 * for the firm's top seed_query_intents via the configured AIO
 * provider (DataForSEO primary; Playwright fallback when wired).
 * Persists into `aio_capture` so the visibility tab can diff captures
 * over time.
 *
 * Frequency: Tuesday 10:00 UTC (vercel.ts). One day after the SERP
 * capture cron so a paid SERP capture for the same query doesn't
 * collide with the AIO request budget.
 *
 * Skip behavior: with NullAioProvider (no DATAFORSEO creds, no
 * PLAYWRIGHT_AIO_WORKER_URL) the per-query capture persists a
 * provider:'none' row with has_aio:false — the operator sees in the
 * UI "we tried, no provider configured" rather than "the cron never
 * ran." Clear, honest signal.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedResponse();

  return recordCronRun('aio-capture', async () => {
    console.log('[cron:aio-capture] start');
    const summary = await captureAioForAllFirms({
      maxQueries: 5,
      country: 'United States',
      language: 'English',
    });
    console.log('[cron:aio-capture] done', summary);
    return { body: summary, summary };
  });
}
