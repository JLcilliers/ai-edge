import { getDb, firms, brandTruthVersions } from '@ai-edge/db';
import { eq, desc } from 'drizzle-orm';
import { runSuppressionScan } from '../../../lib/suppression/scan';
import {
  isAuthorizedCronRequest,
  unauthorizedResponse,
} from '../../../lib/cron/auth';
import { recordCronRun } from '../../../lib/cron/log';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Suppression scan trigger — operator endpoint, NOT scheduled.
 *
 * The suppression scan (sitemap discovery → page fetch → embedding →
 * semantic-distance scoring → finding/ticket writes) is currently
 * triggered from the dashboard's Clerk-authed "Run Scan" button. This
 * route gives operators a CRON_SECRET-authed lever for the same action,
 * symmetric with `/api/cron/audit-daily?firm=<slug>` (PR #55).
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://<host>/api/cron/suppression-poll?firm=nike"
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://<host>/api/cron/suppression-poll"   # → all firms
 *
 * Why no `vercel.ts` cron entry. Suppression scans are heavier than the
 * other crons (page fetch + embedding for up to 75 URLs per firm; can
 * exceed maxDuration if a firm has lots of slow-loading pages) AND the
 * results are typically only acted on weekly via operator review. Running
 * unattended every night would burn embedding API budget for diffs the
 * operator wouldn't read until the weekly review anyway. Better to leave
 * scheduling to operator discretion via this endpoint or the dashboard.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedResponse();

  return recordCronRun('suppression-poll', async () => {
    const url = new URL(request.url);
    const firmSlugFilter = url.searchParams.get('firm')?.trim() || null;

    console.log(
      `[cron:suppression-poll] start${firmSlugFilter ? ` (firm filter: ${firmSlugFilter})` : ''}`,
    );

    const db = getDb();
    const allFirms = firmSlugFilter
      ? await db
          .select({ id: firms.id, slug: firms.slug })
          .from(firms)
          .where(eq(firms.slug, firmSlugFilter))
      : await db.select({ id: firms.id, slug: firms.slug }).from(firms);

    if (firmSlugFilter && allFirms.length === 0) {
      console.warn(`[cron:suppression-poll] no firm matches slug '${firmSlugFilter}'`);
    }

    const results: Array<{
      firmSlug: string;
      status: 'ok' | 'skipped' | 'error';
      runId?: string;
      reason?: string;
    }> = [];

    for (const firm of allFirms) {
      try {
        // Pre-check: scan needs Brand Truth (for primary_url + the centroid).
        const [btv] = await db
          .select({ id: brandTruthVersions.id })
          .from(brandTruthVersions)
          .where(eq(brandTruthVersions.firm_id, firm.id))
          .orderBy(desc(brandTruthVersions.version))
          .limit(1);

        if (!btv) {
          console.log(`[cron:suppression-poll] skip ${firm.slug} — no_brand_truth`);
          results.push({ firmSlug: firm.slug, status: 'skipped', reason: 'no_brand_truth' });
          continue;
        }

        const runId = await runSuppressionScan(firm.id);
        console.log(`[cron:suppression-poll] ok ${firm.slug} → run=${runId}`);
        results.push({ firmSlug: firm.slug, status: 'ok', runId });
      } catch (err) {
        console.error(`[cron:suppression-poll] error ${firm.slug}:`, err);
        results.push({ firmSlug: firm.slug, status: 'error', reason: String(err) });
      }
    }

    const summary = {
      ran: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      errored: results.filter((r) => r.status === 'error').length,
    };
    console.log('[cron:suppression-poll] done', summary);

    return { body: { ...summary, results }, summary };
  });
}
