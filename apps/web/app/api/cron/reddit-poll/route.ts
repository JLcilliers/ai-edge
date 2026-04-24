import { getDb, firms, brandTruthVersions } from '@ai-edge/db';
import { eq, desc } from 'drizzle-orm';
import { runRedditScan } from '../../../lib/reddit/scan';
import { isAuthorizedCronRequest, unauthorizedResponse } from '../../../lib/cron/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Daily Reddit sentiment poll (declared in vercel.ts at `0 7 * * *`).
 *
 * For every firm with a saved Brand Truth, search Reddit for firm_name +
 * name_variants + common_misspellings over the past month, classify sentiment,
 * and auto-open a remediation ticket for any ≥10-karma complaint. See
 * `lib/reddit/scan.ts` for the full flow.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedResponse();

  const startedAt = Date.now();
  console.log('[cron:reddit-poll] start');

  const db = getDb();
  const allFirms = await db.select({ id: firms.id, slug: firms.slug }).from(firms);

  const results: Array<{
    firmSlug: string;
    status: 'ok' | 'skipped' | 'error';
    runId?: string;
    reason?: string;
  }> = [];

  for (const firm of allFirms) {
    try {
      // runRedditScan itself pulls the latest BT, but we pre-check so we can
      // skip cleanly instead of marking a failed audit_run.
      const [btv] = await db
        .select({ id: brandTruthVersions.id })
        .from(brandTruthVersions)
        .where(eq(brandTruthVersions.firm_id, firm.id))
        .orderBy(desc(brandTruthVersions.version))
        .limit(1);

      if (!btv) {
        console.log(`[cron:reddit-poll] skip ${firm.slug} — no_brand_truth`);
        results.push({ firmSlug: firm.slug, status: 'skipped', reason: 'no_brand_truth' });
        continue;
      }

      const runId = await runRedditScan(firm.id);
      console.log(`[cron:reddit-poll] ok ${firm.slug} → run=${runId}`);
      results.push({ firmSlug: firm.slug, status: 'ok', runId });
    } catch (err) {
      console.error(`[cron:reddit-poll] error ${firm.slug}:`, err);
      results.push({ firmSlug: firm.slug, status: 'error', reason: String(err) });
    }
  }

  const durationMs = Date.now() - startedAt;
  const summary = {
    ran: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    errored: results.filter((r) => r.status === 'error').length,
    durationMs,
  };
  console.log('[cron:reddit-poll] done', summary);

  return Response.json({ ...summary, results });
}
