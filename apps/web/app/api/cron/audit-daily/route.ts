import { getDb, firms, brandTruthVersions } from '@ai-edge/db';
import { eq, desc } from 'drizzle-orm';
import { runAudit } from '../../../lib/audit/run-audit';
import { getFirmBudgetStatus } from '../../../lib/audit/budget';
import { isAuthorizedCronRequest, unauthorizedResponse } from '../../../lib/cron/auth';
import { recordCronRun } from '../../../lib/cron/log';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Daily priority audit cron (declared in vercel.ts at `0 8 * * *`).
 *
 * Cheap daily variant — runs only the top 20 seed queries per firm so we
 * catch alignment drift between the weekly full runs without burning the full
 * LLM-call budget every day.
 *
 * Operator override: `?firm=<slug>` runs the audit for a single firm only.
 * Useful when the scheduled cron previously hit `maxDuration` before
 * reaching a particular tenant (Vercel's 300s wall-clock kills the loop and
 * later firms never get scored), or when an operator wants to re-trigger
 * after editing Brand Truth without waiting for the next 08:00 UTC firing.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedResponse();

  return recordCronRun('audit-daily', async () => {
    const url = new URL(request.url);
    const firmSlugFilter = url.searchParams.get('firm')?.trim() || null;

    console.log(
      `[cron:audit-daily] start${firmSlugFilter ? ` (firm filter: ${firmSlugFilter})` : ''}`,
    );

    const db = getDb();
    const allFirms = firmSlugFilter
      ? await db
          .select({ id: firms.id, slug: firms.slug })
          .from(firms)
          .where(eq(firms.slug, firmSlugFilter))
      : await db.select({ id: firms.id, slug: firms.slug }).from(firms);

    if (firmSlugFilter && allFirms.length === 0) {
      console.warn(`[cron:audit-daily] no firm matches slug '${firmSlugFilter}'`);
      // Fall through with empty firm list so the response shape stays
      // consistent with normal cron firings — the loop just no-ops.
    }

    const results: Array<{
      firmSlug: string;
      status: 'ok' | 'skipped' | 'error';
      auditRunId?: string;
      reason?: string;
    }> = [];

    for (const firm of allFirms) {
      try {
        const [btv] = await db
          .select({ id: brandTruthVersions.id })
          .from(brandTruthVersions)
          .where(eq(brandTruthVersions.firm_id, firm.id))
          .orderBy(desc(brandTruthVersions.version))
          .limit(1);

        if (!btv) {
          console.log(`[cron:audit-daily] skip ${firm.slug} — no_brand_truth`);
          results.push({ firmSlug: firm.slug, status: 'skipped', reason: 'no_brand_truth' });
          continue;
        }

        // Pre-flight budget gate. Daily cron is the cheap cadence but it still
        // fires every morning — if a firm is already over cap, we quietly skip.
        const budget = await getFirmBudgetStatus(firm.id);
        if (budget.overBudget) {
          console.log(`[cron:audit-daily] skip ${firm.slug} — budget_exceeded ($${budget.spentThisMonthUsd.toFixed(2)}/$${budget.monthlyCapUsd.toFixed(2)})`);
          results.push({ firmSlug: firm.slug, status: 'skipped', reason: 'budget_exceeded' });
          continue;
        }

        const auditRunId = await runAudit(firm.id, btv.id, {
          kind: 'daily-priority',
          queryLimit: 20,
        });
        console.log(`[cron:audit-daily] ok ${firm.slug} → auditRun=${auditRunId}`);
        results.push({ firmSlug: firm.slug, status: 'ok', auditRunId });
      } catch (err) {
        console.error(`[cron:audit-daily] error ${firm.slug}:`, err);
        results.push({ firmSlug: firm.slug, status: 'error', reason: String(err) });
      }
    }

    const summary = {
      ran: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      errored: results.filter((r) => r.status === 'error').length,
    };
    console.log('[cron:audit-daily] done', summary);

    return { body: { ...summary, results }, summary };
  });
}
