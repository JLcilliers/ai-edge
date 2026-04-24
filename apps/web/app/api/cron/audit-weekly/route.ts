import { getDb, firms, brandTruthVersions } from '@ai-edge/db';
import { eq, desc } from 'drizzle-orm';
import { runAudit } from '../../../lib/audit/run-audit';
import { getFirmBudgetStatus } from '../../../lib/audit/budget';
import { isAuthorizedCronRequest, unauthorizedResponse } from '../../../lib/cron/auth';
import { recordCronRun } from '../../../lib/cron/log';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Weekly full audit cron (declared in vercel.ts at `0 6 * * 1`).
 *
 * For every firm that has at least one saved Brand Truth version, kick off a
 * `kind='full'` audit using the latest BT. Runs sequentially so a single
 * OpenAI/Anthropic rate-limit blast doesn't nuke every firm — each firm either
 * completes or records its own `auditRuns.status='failed'` row.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedResponse();

  return recordCronRun('audit-weekly', async () => {
    console.log('[cron:audit-weekly] start');

    const db = getDb();
    const allFirms = await db.select({ id: firms.id, slug: firms.slug }).from(firms);

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
          console.log(`[cron:audit-weekly] skip ${firm.slug} — no_brand_truth`);
          results.push({ firmSlug: firm.slug, status: 'skipped', reason: 'no_brand_truth' });
          continue;
        }

        // Pre-flight budget gate. Skip — don't fail — so the audit log stays clean.
        const budget = await getFirmBudgetStatus(firm.id);
        if (budget.overBudget) {
          console.log(`[cron:audit-weekly] skip ${firm.slug} — budget_exceeded ($${budget.spentThisMonthUsd.toFixed(2)}/$${budget.monthlyCapUsd.toFixed(2)})`);
          results.push({ firmSlug: firm.slug, status: 'skipped', reason: 'budget_exceeded' });
          continue;
        }

        const auditRunId = await runAudit(firm.id, btv.id, { kind: 'full' });
        console.log(`[cron:audit-weekly] ok ${firm.slug} → auditRun=${auditRunId}`);
        results.push({ firmSlug: firm.slug, status: 'ok', auditRunId });
      } catch (err) {
        console.error(`[cron:audit-weekly] error ${firm.slug}:`, err);
        results.push({ firmSlug: firm.slug, status: 'error', reason: String(err) });
      }
    }

    const summary = {
      ran: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      errored: results.filter((r) => r.status === 'error').length,
    };
    console.log('[cron:audit-weekly] done', summary);

    // `body` is what the cron runner sees as HTTP response. `summary` is
    // what we persist — we skip the verbose per-firm results array to
    // keep cron_run.summary small and readable in the admin UI.
    return { body: { ...summary, results }, summary };
  });
}
