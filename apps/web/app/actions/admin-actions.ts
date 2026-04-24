'use server';

import {
  getDb,
  firms,
  auditRuns,
  cronRuns,
  brandTruthVersions,
  firmBudgets,
  legacyRewriteDrafts,
  legacyFindings,
  pages,
  monthlyReports,
  redditMentions,
} from '@ai-edge/db';
import { and, desc, eq, gte, lt, sql, inArray } from 'drizzle-orm';

/**
 * Read-only admin observability queries.
 *
 * The admin dashboard (`/dashboard/admin`) is the ops cockpit for the
 * whole workspace. Everything in this module is a SELECT — mutations go
 * through the firm-scoped `settings-actions.ts` or `firm-actions.ts`.
 *
 * Three surfaces:
 *   - Workspace spend: MTD and 12-month, split by category (audits /
 *     rewrites) and aggregated across all firms. Mirrors the per-firm
 *     cost telemetry so the operator can compare the workspace total
 *     against any one firm's contribution.
 *   - Cron health: last N rows from `cron_run` per cron name, plus
 *     duration/success stats over the trailing 30 days. Stalled runs
 *     (started_at older than 15 minutes with status='running') are
 *     flagged so the operator can spot wedged workers.
 *   - Firm health snapshot: one row per firm with the latest audit,
 *     latest reddit scan, open mentions count, BT version, budget
 *     utilisation, and whether this month's report has been generated.
 *
 * Nothing here takes a firm slug — the admin page is workspace-wide
 * by design. Firm-level tasks live inside the firm-scoped routes.
 */

// ─── Workspace cost ────────────────────────────────────────────

export interface WorkspaceCostBreakdown {
  month: string; // 'YYYY-MM'
  monthStart: Date;
  audits: number;
  rewrites: number;
  total: number;
}

function startOfUtcMonth(year: number, monthIdx0: number): Date {
  return new Date(Date.UTC(year, monthIdx0, 1));
}

function trailingMonths(
  n: number,
): Array<{ label: string; start: Date; end: Date }> {
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

/**
 * Workspace MTD: sum across all firms. Identical shape to the per-firm
 * breakdown so the admin UI can reuse the same tile components.
 */
export async function getWorkspaceMonthToDateBreakdown(): Promise<WorkspaceCostBreakdown> {
  const db = getDb();
  const now = new Date();
  const monthStart = startOfUtcMonth(now.getUTCFullYear(), now.getUTCMonth());
  const monthEnd = startOfUtcMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);

  const [auditRow, rewriteRow] = await Promise.all([
    db
      .select({ total: sql<number>`coalesce(sum(${auditRuns.cost_usd}), 0)` })
      .from(auditRuns)
      .where(and(
        gte(auditRuns.started_at, monthStart),
        lt(auditRuns.started_at, monthEnd),
      )),
    db
      .select({ total: sql<number>`coalesce(sum(${legacyRewriteDrafts.cost_usd}), 0)` })
      .from(legacyRewriteDrafts)
      .where(and(
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
 * Workspace 12-month breakdown, oldest → newest. Zero-filled so the
 * chart always renders 12 buckets even when the workspace is new.
 */
export async function getWorkspaceTrailingYearBreakdown(): Promise<WorkspaceCostBreakdown[]> {
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
      .where(and(
        gte(legacyRewriteDrafts.generated_at, oldest),
        lt(legacyRewriteDrafts.generated_at, newest),
      ))
      .groupBy(sql`date_trunc('month', ${legacyRewriteDrafts.generated_at})`),
  ]);

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

// ─── Cron health ───────────────────────────────────────────────

export type CronStatus = 'running' | 'ok' | 'error' | 'stalled';

export interface CronRunRow {
  id: string;
  cronName: string;
  status: CronStatus;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  summary: unknown;
  error: string | null;
}

export interface CronHealthRow {
  cronName: string;
  /** Most recent N runs, newest-first. `N` is `recentLimit` (default 10). */
  recentRuns: CronRunRow[];
  /** 30-day counts across all statuses. */
  stats30d: {
    total: number;
    ok: number;
    errored: number;
    running: number;
    stalled: number;
    avgDurationMs: number | null;
  };
  /** Most recent run in any state — convenient for the row header. */
  lastRun: CronRunRow | null;
}

/**
 * Fifteen-minute wall-clock grace — if a `running` row is older than
 * this, we flag it as stalled (process almost certainly crashed before
 * `finished_at` got written). Matches the 5-minute function timeout
 * plus 10 minutes of operator benefit-of-the-doubt.
 */
const STALLED_THRESHOLD_MS = 15 * 60 * 1000;

function classifyStatus(row: {
  status: string;
  startedAt: Date;
}): CronStatus {
  if (row.status === 'ok') return 'ok';
  if (row.status === 'error') return 'error';
  // 'running' — either genuinely in-flight or dead.
  const ageMs = Date.now() - row.startedAt.getTime();
  return ageMs > STALLED_THRESHOLD_MS ? 'stalled' : 'running';
}

/**
 * Return one row per known cron name. Rows are returned in a stable
 * order (alphabetical by name) so the admin page doesn't rearrange
 * between refreshes.
 */
export async function getCronHealth(
  recentLimit = 10,
): Promise<CronHealthRow[]> {
  const db = getDb();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Pull all cron run names that have ever executed so the table shows
  // every cron even if a specific one hasn't fired in 30 days. We'll
  // still only aggregate stats over the 30-day window.
  const names = await db
    .selectDistinct({ cronName: cronRuns.cron_name })
    .from(cronRuns)
    .orderBy(cronRuns.cron_name);

  const out: CronHealthRow[] = [];
  for (const { cronName } of names) {
    // Recent rows (any status) for the expanded-row history view.
    const rows = await db
      .select({
        id: cronRuns.id,
        cronName: cronRuns.cron_name,
        status: cronRuns.status,
        startedAt: cronRuns.started_at,
        finishedAt: cronRuns.finished_at,
        durationMs: cronRuns.duration_ms,
        summary: cronRuns.summary,
        error: cronRuns.error,
      })
      .from(cronRuns)
      .where(eq(cronRuns.cron_name, cronName))
      .orderBy(desc(cronRuns.started_at))
      .limit(recentLimit);

    const recentRuns: CronRunRow[] = rows.map((r) => ({
      id: r.id,
      cronName: r.cronName,
      status: classifyStatus({ status: r.status, startedAt: r.startedAt }),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
      summary: r.summary,
      error: r.error,
    }));

    // 30-day aggregate stats. We can't use classifyStatus in SQL
    // directly (time-dependent) so we pull raw counts and compute
    // stalled in JS.
    const statsWindow = await db
      .select({
        id: cronRuns.id,
        status: cronRuns.status,
        startedAt: cronRuns.started_at,
        durationMs: cronRuns.duration_ms,
      })
      .from(cronRuns)
      .where(and(
        eq(cronRuns.cron_name, cronName),
        gte(cronRuns.started_at, thirtyDaysAgo),
      ));

    let ok = 0;
    let errored = 0;
    let running = 0;
    let stalled = 0;
    let durationSum = 0;
    let durationCount = 0;
    for (const r of statsWindow) {
      const s = classifyStatus({ status: r.status, startedAt: r.startedAt });
      if (s === 'ok') ok++;
      else if (s === 'error') errored++;
      else if (s === 'running') running++;
      else stalled++;
      if (r.durationMs != null) {
        durationSum += r.durationMs;
        durationCount++;
      }
    }

    out.push({
      cronName,
      recentRuns,
      stats30d: {
        total: statsWindow.length,
        ok,
        errored,
        running,
        stalled,
        avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
      },
      lastRun: recentRuns[0] ?? null,
    });
  }

  return out;
}

// ─── Firm health snapshot ──────────────────────────────────────

export interface FirmHealthRow {
  firmId: string;
  slug: string;
  name: string;
  brandTruthVersion: number | null;
  lastAudit: { id: string; kind: string; status: string; startedAt: Date | null } | null;
  lastAuditErrorCount30d: number;
  openMentionCount: number;
  monthlyReportGenerated: boolean;
  budget: {
    monthlyCapUsd: number;
    spentThisMonthUsd: number;
    utilizationPct: number;
    overBudget: boolean;
    source: 'firm' | 'default';
  };
}

function defaultCapUsd(): number {
  const raw = process.env.DEFAULT_FIRM_MONTHLY_CAP_USD;
  if (!raw) return 50;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : 50;
}

/**
 * One snapshot row per firm, sorted by name. Designed as a dense table
 * view so the operator can triage the whole workspace at a glance.
 *
 * Cost: a handful of aggregate SELECTs bounded by firm count. For the
 * admin page (dozens of firms max) this is well under a second. If the
 * workspace grows past ~500 firms we'll want to move to a single
 * aggregate view; for now the per-firm fanout keeps the code readable.
 */
export async function getFirmHealthSnapshot(): Promise<FirmHealthRow[]> {
  const db = getDb();
  const allFirms = await db
    .select({ id: firms.id, slug: firms.slug, name: firms.name })
    .from(firms)
    .orderBy(firms.name);

  if (allFirms.length === 0) return [];

  const firmIds = allFirms.map((f) => f.id);
  const monthStart = startOfUtcMonth(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
  );
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const currentMonthKey = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`;

  // Parallel aggregate queries — each hits a different table so there's
  // no contention, and we keep wall-time flat regardless of firm count.
  const [
    latestBtvs,
    latestAudits,
    errorCounts,
    mentionCounts,
    reportRows,
    budgetRows,
    spendRows,
  ] = await Promise.all([
    // Latest BT version per firm
    db
      .select({
        firm_id: brandTruthVersions.firm_id,
        version: sql<number>`max(${brandTruthVersions.version})`,
      })
      .from(brandTruthVersions)
      .where(inArray(brandTruthVersions.firm_id, firmIds))
      .groupBy(brandTruthVersions.firm_id),
    // Latest audit per firm. Fan out one small ORDER BY + LIMIT 1
    // per firm in parallel rather than a single DISTINCT-ON query —
    // drizzle's neon-http adapter has edge cases with raw DISTINCT ON
    // and the firm count is bounded (dozens max for this internal
    // tool), so parallel fanout is simpler and more robust.
    Promise.all(
      firmIds.map(async (fid) => {
        const [row] = await db
          .select({
            firm_id: auditRuns.firm_id,
            id: auditRuns.id,
            kind: auditRuns.kind,
            status: auditRuns.status,
            startedAt: auditRuns.started_at,
          })
          .from(auditRuns)
          .where(and(
            eq(auditRuns.firm_id, fid),
            sql`${auditRuns.started_at} IS NOT NULL`,
          ))
          .orderBy(desc(auditRuns.started_at))
          .limit(1);
        return row ?? null;
      }),
    ),
    // 30-day error count per firm
    db
      .select({
        firm_id: auditRuns.firm_id,
        errors: sql<number>`count(*)`,
      })
      .from(auditRuns)
      .where(and(
        inArray(auditRuns.firm_id, firmIds),
        eq(auditRuns.status, 'failed'),
        gte(auditRuns.started_at, thirtyDaysAgo),
      ))
      .groupBy(auditRuns.firm_id),
    // Open-complaint mention count per firm. `sentiment='complaint'` is
    // what the Reddit classifier actually writes (the old `'negative'`
    // filter here was always 0 — the classifier has never emitted that
    // label). `triage_status='open'` narrows this to the actionable
    // subset: complaints the operator hasn't acknowledged, dismissed,
    // or escalated. This is the exact queue the admin UI links to.
    db
      .select({
        firm_id: redditMentions.firm_id,
        count: sql<number>`count(*)`,
      })
      .from(redditMentions)
      .where(and(
        inArray(redditMentions.firm_id, firmIds),
        eq(redditMentions.sentiment, 'complaint'),
        eq(redditMentions.triage_status, 'open'),
      ))
      .groupBy(redditMentions.firm_id),
    // Current month's report (if generated)
    db
      .select({ firm_id: monthlyReports.firm_id })
      .from(monthlyReports)
      .where(and(
        inArray(monthlyReports.firm_id, firmIds),
        eq(monthlyReports.month_key, currentMonthKey),
      )),
    // Budget overrides
    db
      .select({ firm_id: firmBudgets.firm_id, cap: firmBudgets.monthly_cap_usd })
      .from(firmBudgets)
      .where(inArray(firmBudgets.firm_id, firmIds)),
    // MTD spend per firm
    db
      .select({
        firm_id: auditRuns.firm_id,
        spent: sql<number>`coalesce(sum(${auditRuns.cost_usd}), 0)`,
      })
      .from(auditRuns)
      .where(and(
        inArray(auditRuns.firm_id, firmIds),
        gte(auditRuns.started_at, monthStart),
      ))
      .groupBy(auditRuns.firm_id),
  ]);

  const btvMap = new Map<string, number>();
  for (const r of latestBtvs) btvMap.set(r.firm_id, Number(r.version));

  const auditMap = new Map<
    string,
    { id: string; kind: string; status: string; startedAt: Date | null }
  >();
  // `latestAudits[i]` corresponds to `firmIds[i]` (fanout preserves order).
  // Nulls mean the firm has no audits yet.
  for (const r of latestAudits) {
    if (!r) continue;
    auditMap.set(r.firm_id, {
      id: r.id,
      kind: r.kind,
      status: r.status,
      startedAt: r.startedAt,
    });
  }

  const errorMap = new Map<string, number>();
  for (const r of errorCounts) errorMap.set(r.firm_id, Number(r.errors));

  const mentionMap = new Map<string, number>();
  for (const r of mentionCounts) mentionMap.set(r.firm_id, Number(r.count));

  const reportSet = new Set<string>(reportRows.map((r) => r.firm_id));

  const budgetMap = new Map<string, number>();
  for (const r of budgetRows) budgetMap.set(r.firm_id, Number(r.cap));

  const spendMap = new Map<string, number>();
  for (const r of spendRows) spendMap.set(r.firm_id, Number(r.spent));

  const fallbackCap = defaultCapUsd();

  return allFirms.map((f) => {
    const overrideCap = budgetMap.get(f.id);
    const cap = overrideCap ?? fallbackCap;
    const source: 'firm' | 'default' = overrideCap != null ? 'firm' : 'default';
    const spent = spendMap.get(f.id) ?? 0;
    const utilizationPct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;

    return {
      firmId: f.id,
      slug: f.slug,
      name: f.name,
      brandTruthVersion: btvMap.get(f.id) ?? null,
      lastAudit: auditMap.get(f.id) ?? null,
      lastAuditErrorCount30d: errorMap.get(f.id) ?? 0,
      openMentionCount: mentionMap.get(f.id) ?? 0,
      monthlyReportGenerated: reportSet.has(f.id),
      budget: {
        monthlyCapUsd: cap,
        spentThisMonthUsd: spent,
        utilizationPct,
        overBudget: spent >= cap,
        source,
      },
    };
  });
}

// ─── Bundle ────────────────────────────────────────────────────

export interface AdminDashboardBundle {
  workspaceMtd: WorkspaceCostBreakdown;
  workspaceYear: WorkspaceCostBreakdown[];
  cronHealth: CronHealthRow[];
  firmHealth: FirmHealthRow[];
}

/**
 * Single parallel fetch of everything the admin page needs. Keeps the
 * page component trivial and the RSC round-trip minimal.
 */
export async function getAdminDashboardBundle(): Promise<AdminDashboardBundle> {
  const [workspaceMtd, workspaceYear, cronHealth, firmHealth] = await Promise.all([
    getWorkspaceMonthToDateBreakdown(),
    getWorkspaceTrailingYearBreakdown(),
    getCronHealth(10),
    getFirmHealthSnapshot(),
  ]);
  return { workspaceMtd, workspaceYear, cronHealth, firmHealth };
}
