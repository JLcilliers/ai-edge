import { getDb, firms } from '@ai-edge/db';
import { generateAndPersistMonthlyReport } from '../../../lib/reports/persist-monthly-report';
import { previousMonthKey } from '../../../lib/reports/build-monthly-report';
import {
  isAuthorizedCronRequest,
  unauthorizedResponse,
} from '../../../lib/cron/auth';
import { recordCronRun } from '../../../lib/cron/log';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Monthly report generator cron (declared in vercel.ts at `0 5 1 * *` —
 * 05:00 UTC on the 1st of every month).
 *
 * For every firm, generates a report for the *previous* calendar month
 * (so the Apr-1 run produces March data), writes it to Vercel Blob, and
 * upserts the `monthly_report` row. Errors per-firm are captured and
 * reported in the summary; they don't short-circuit the loop.
 *
 * Supports a `?month=YYYY-MM` override for manual backfill from the
 * Vercel dashboard's "Run now" action.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedResponse();

  const url = new URL(request.url);
  const monthOverride = url.searchParams.get('month');
  const monthKey = monthOverride ?? previousMonthKey(new Date());

  return recordCronRun('report-monthly', async () => {
    console.log('[cron:report-monthly] start', { monthKey });

    const db = getDb();
    const allFirms = await db.select({ id: firms.id, slug: firms.slug }).from(firms);

    const results: Array<{
      firmSlug: string;
      status: 'ok' | 'error';
      reportId?: string;
      blobUrl?: string | null;
      reason?: string;
    }> = [];

    for (const firm of allFirms) {
      try {
        const { reportId, blobUrl } = await generateAndPersistMonthlyReport({
          firmId: firm.id,
          firmSlug: firm.slug,
          monthKey,
        });
        console.log(
          `[cron:report-monthly] ok ${firm.slug} → report=${reportId} blob=${blobUrl ?? 'skipped'}`,
        );
        results.push({ firmSlug: firm.slug, status: 'ok', reportId, blobUrl });
      } catch (err) {
        console.error(`[cron:report-monthly] error ${firm.slug}:`, err);
        results.push({ firmSlug: firm.slug, status: 'error', reason: String(err) });
      }
    }

    const summary = {
      monthKey,
      ran: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      errored: results.filter((r) => r.status === 'error').length,
    };
    console.log('[cron:report-monthly] done', summary);

    return { body: { ...summary, results }, summary };
  });
}
