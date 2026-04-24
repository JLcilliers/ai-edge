import {
  getDb,
  auditRuns,
  legacyRewriteDrafts,
  legacyFindings,
  pages,
} from '@ai-edge/db';
import { and, eq, gte, lt, sql } from 'drizzle-orm';

/**
 * Cost telemetry module.
 *
 * The canonical monthly spend cap (see `lib/audit/budget.ts`) sums only
 * `audit_run.cost_usd` — that's intentional, because the budget decision is
 * "should we start another audit?" and only audit spend is scheduler-driven.
 *
 * The *settings* page wants a different view: everything we spent, broken
 * down by source, so the operator can see where the money went. Rewrite
 * drafts are operator-initiated (one click = one generation) but still hit
 * the Anthropic API, and a runaway rewrite loop on a large page would burn
 * real money. Surfacing that line item is the point of this module.
 *
 * Categories (stable strings — used as chart/table keys in the UI):
 *   'audits'   → sum(audit_run.cost_usd) across all non-reddit runs.
 *                Reddit scans don't hit paid LLM APIs so we exclude them.
 *   'rewrites' → sum(legacy_rewrite_draft.cost_usd) scoped to the firm via
 *                the page → firm join (drafts don't carry firm_id directly).
 *
 * Dates use UTC month boundaries so a firm's "March spend" matches wherever
 * it's reported. All queries filter on `started_at` / `generated_at` so
 * long-running rows don't leak across month boundaries.
 */

export type CostCategory = 'audits' | 'rewrites';

export interface CostBreakdown {
  /** Calendar label, e.g. "2026-04". UTC-based. */
  month: string;
  /** Start of the month in UTC — useful for sorting / axis labels. */
  monthStart: Date;
  audits: number;
  rewrites: number;
  total: number;
}

/** Start of the current UTC month (inclusive). */
function startOfUtcMonth(year: number, monthIdx0: number): Date {
  return new Date(Date.UTC(year, monthIdx0, 1));
}

/**
 * Return the UTC-month window for `n` months ending at (and including) the
 * current month. `n = 12` yields a rolling year. The returned array is
 * ordered oldest → newest so charts render left-to-right naturally.
 */
function trailingMonths(n: number): Array<{ label: string; start: Date; end: Date }> {
  const out: Array<{ label: string; start: Date; end: Date }> = [];
  const now = new Date();
  const year = now.getUTCFullYear();
  const monthIdx = now.getUTCMonth();
  for (let i = n - 1; i >= 0; i--) {
    const start = startOfUtcMonth(year, monthIdx - i);
    const end = startOfUtcMonth(year, monthIdx - i + 1);
    const label = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({ label, start, end });
  }
  return out;
}

/**
 * Month-to-date cost breakdown for a firm. Used by the Settings page header
 * tiles so the operator sees "spent $X this month ($Y on audits, $Z on
 * rewrites)" at a glance.
 */
export async function getFirmMonthToDateBreakdown(
  firmId: string,
): Promise<CostBreakdown> {
  const now = new Date();
  const monthStart = startOfUtcMonth(now.getUTCFullYear(), now.getUTCMonth());
  const monthEnd = startOfUtcMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);

  const db = getDb();

  // Run both SUMs in parallel — they hit different tables so there's no
  // contention and we halve the wait.
  const [auditRow, rewriteRow] = await Promise.all([
    db
      .select({ total: sql<number>`coalesce(sum(${auditRuns.cost_usd}), 0)` })
      .from(auditRuns)
      .where(and(
        eq(auditRuns.firm_id, firmId),
        gte(auditRuns.started_at, monthStart),
        lt(auditRuns.started_at, monthEnd),
      )),
    db
      .select({ total: sql<number>`coalesce(sum(${legacyRewriteDrafts.cost_usd}), 0)` })
      .from(legacyRewriteDrafts)
      .innerJoin(legacyFindings, eq(legacyFindings.id, legacyRewriteDrafts.legacy_finding_id))
      .innerJoin(pages, eq(pages.id, legacyFindings.page_id))
      .where(and(
        eq(pages.firm_id, firmId),
        gte(legacyRewriteDrafts.generated_at, monthStart),
        lt(legacyRewriteDrafts.generated_at, monthEnd),
      )),
  ]);

  const audits = Number(auditRow[0]?.total ?? 0);
  const rewrites = Number(rewriteRow[0]?.total ?? 0);

  return {
    month: `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`,
    monthStart,
    audits,
    rewrites,
    total: audits + rewrites,
  };
}

/**
 * Per-month cost breakdown for the trailing 12 UTC months, oldest → newest.
 * Empty months are represented with zero values (so the chart is the right
 * width even for brand-new firms).
 *
 * Implemented as one GROUP BY per source table, then merged into the window
 * in memory. SQL-side `date_trunc` keeps the aggregation in the DB while
 * the JS layer handles the zero-fill and shape conversion — cleaner than
 * GENERATE_SERIES on neon-http.
 */
export async function getFirmTrailingYearBreakdown(
  firmId: string,
): Promise<CostBreakdown[]> {
  const db = getDb();
  const window = trailingMonths(12);
  const oldest = window[0]!.start;
  const newest = window[window.length - 1]!.end;

  const [auditRows, rewriteRows] = await Promise.all([
    db
      .select({
        bucket: sql<Date>`date_trunc('month', ${auditRuns.started_at})`.as('bucket'),
        total: sql<number>`coalesce(sum(${auditRuns.cost_usd}), 0)`,
      })
      .from(auditRuns)
      .where(and(
        eq(auditRuns.firm_id, firmId),
        gte(auditRuns.started_at, oldest),
        lt(auditRuns.started_at, newest),
      ))
      .groupBy(sql`date_trunc('month', ${auditRuns.started_at})`),
    db
      .select({
        bucket: sql<Date>`date_trunc('month', ${legacyRewriteDrafts.generated_at})`.as('bucket'),
        total: sql<number>`coalesce(sum(${legacyRewriteDrafts.cost_usd}), 0)`,
      })
      .from(legacyRewriteDrafts)
      .innerJoin(legacyFindings, eq(legacyFindings.id, legacyRewriteDrafts.legacy_finding_id))
      .innerJoin(pages, eq(pages.id, legacyFindings.page_id))
      .where(and(
        eq(pages.firm_id, firmId),
        gte(legacyRewriteDrafts.generated_at, oldest),
        lt(legacyRewriteDrafts.generated_at, newest),
      ))
      .groupBy(sql`date_trunc('month', ${legacyRewriteDrafts.generated_at})`),
  ]);

  // Index both result sets by UTC-month label for O(1) lookup per bucket.
  const auditByLabel = indexByMonthLabel(auditRows);
  const rewriteByLabel = indexByMonthLabel(rewriteRows);

  return window.map(({ label, start }) => {
    const audits = Number(auditByLabel.get(label) ?? 0);
    const rewrites = Number(rewriteByLabel.get(label) ?? 0);
    return {
      month: label,
      monthStart: start,
      audits,
      rewrites,
      total: audits + rewrites,
    };
  });
}

function indexByMonthLabel(
  rows: Array<{ bucket: Date | string | null; total: number | string }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.bucket) continue;
    const d = r.bucket instanceof Date ? r.bucket : new Date(r.bucket);
    const label = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.set(label, Number(r.total));
  }
  return out;
}
