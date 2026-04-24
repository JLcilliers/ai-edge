import { getDb, firmBudgets, auditRuns } from '@ai-edge/db';
import { and, eq, gte, sql } from 'drizzle-orm';

/**
 * Default monthly cap applied to any firm without an explicit `firm_budget`
 * row. Keeps "nobody has configured this yet" from turning into "unlimited
 * spend." Overridable via env so staging/prod can run different defaults.
 */
function defaultMonthlyCapUsd(): number {
  const raw = process.env.DEFAULT_FIRM_MONTHLY_CAP_USD;
  if (!raw) return 50; // safe dev default — one or two full runs' worth
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : 50;
}

/** The first day of the current UTC month. Budget caps reset on this boundary. */
function startOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface FirmBudgetStatus {
  monthlyCapUsd: number;
  spentThisMonthUsd: number;
  remainingUsd: number;
  overBudget: boolean;
  /** True when spend is within 10% of the cap — UI can show a warning. */
  nearCap: boolean;
  /** The cap source, so the UI can show "default" vs "set by operator". */
  source: 'firm' | 'default';
}

/**
 * Compute the current month's spend + cap for a firm. Read-only — safe to
 * call from server components. We sum `audit_run.cost_usd` rather than
 * walking individual `model_response` rows because the run-level field is
 * the canonical accumulator updated after every provider call.
 */
export async function getFirmBudgetStatus(firmId: string): Promise<FirmBudgetStatus> {
  const db = getDb();

  // Cap: firm override, else default.
  const [budget] = await db
    .select()
    .from(firmBudgets)
    .where(eq(firmBudgets.firm_id, firmId))
    .limit(1);

  const monthlyCapUsd = budget?.monthly_cap_usd ?? defaultMonthlyCapUsd();
  const source: 'firm' | 'default' = budget ? 'firm' : 'default';

  // Spend: sum(audit_run.cost_usd) this UTC month.
  const monthStart = startOfCurrentMonthUtc();
  const [spendRow] = await db
    .select({
      spent: sql<number>`coalesce(sum(${auditRuns.cost_usd}), 0)`,
    })
    .from(auditRuns)
    .where(and(
      eq(auditRuns.firm_id, firmId),
      gte(auditRuns.started_at, monthStart),
    ));

  const spentThisMonthUsd = Number(spendRow?.spent ?? 0);
  const remainingUsd = Math.max(0, monthlyCapUsd - spentThisMonthUsd);
  const overBudget = spentThisMonthUsd >= monthlyCapUsd;
  const nearCap = !overBudget && spentThisMonthUsd >= monthlyCapUsd * 0.9;

  return { monthlyCapUsd, spentThisMonthUsd, remainingUsd, overBudget, nearCap, source };
}

/**
 * Preflight used by cron + UI to decide whether to start a new run. If the
 * firm is already at/over cap, the caller should skip with
 * `status='skipped_budget_exceeded'` rather than create a failed run.
 */
export async function isFirmOverBudget(firmId: string): Promise<boolean> {
  const { overBudget } = await getFirmBudgetStatus(firmId);
  return overBudget;
}

/**
 * Atomically accumulate cost onto an audit_run row. Called after every
 * provider response so we can cap mid-run rather than only at the end.
 */
export async function recordRunCost(
  auditRunId: string,
  deltaUsd: number,
): Promise<void> {
  if (!Number.isFinite(deltaUsd) || deltaUsd <= 0) return;
  const db = getDb();
  await db
    .update(auditRuns)
    .set({
      cost_usd: sql`coalesce(${auditRuns.cost_usd}, 0) + ${deltaUsd}`,
    })
    .where(eq(auditRuns.id, auditRunId));
}

/**
 * Upsert a firm's monthly cap. Called from the dashboard settings form.
 * A null/undefined cap deletes the override and falls back to the env
 * default — semantically "reset this firm's budget to the global default."
 */
export async function setFirmMonthlyCap(
  firmId: string,
  capUsd: number | null,
  note?: string | null,
): Promise<void> {
  const db = getDb();
  if (capUsd === null) {
    await db.delete(firmBudgets).where(eq(firmBudgets.firm_id, firmId));
    return;
  }
  if (!Number.isFinite(capUsd) || capUsd < 0) {
    throw new Error('monthly cap must be a non-negative number');
  }
  // Drizzle doesn't have a portable onConflictDoUpdate for neon-http in all
  // versions, so do the two-step select/update to stay compatible.
  const [existing] = await db
    .select({ firm_id: firmBudgets.firm_id })
    .from(firmBudgets)
    .where(eq(firmBudgets.firm_id, firmId))
    .limit(1);
  if (existing) {
    await db
      .update(firmBudgets)
      .set({ monthly_cap_usd: capUsd, note: note ?? null, updated_at: new Date() })
      .where(eq(firmBudgets.firm_id, firmId));
  } else {
    await db.insert(firmBudgets).values({
      firm_id: firmId,
      monthly_cap_usd: capUsd,
      note: note ?? null,
    });
  }
}
