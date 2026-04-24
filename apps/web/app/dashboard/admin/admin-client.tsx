'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertCircle,
  BadgeDollarSign,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  ShieldCheck,
  TrendingUp,
  Wand2,
} from 'lucide-react';
import type {
  AdminDashboardBundle,
  CronHealthRow,
  CronRunRow,
  CronStatus,
  FirmHealthRow,
  WorkspaceCostBreakdown,
} from '../../actions/admin-actions';

/**
 * Admin dashboard client shell. Pure presentation — all data arrives
 * as props from the server component. Interactive state lives here:
 *   - Expanded cron row (to show recent history table)
 *   - Nothing else; the page is intentionally read-only.
 *
 * Layout order mirrors severity: cron health first (the thing that
 * breaks most visibly when it breaks), then per-firm snapshot, then
 * workspace spend trend.
 */
export function AdminClient({ bundle }: { bundle: AdminDashboardBundle }) {
  return (
    <div className="flex flex-col gap-8">
      <CronHealthSection rows={bundle.cronHealth} />
      <FirmHealthSection rows={bundle.firmHealth} />
      <WorkspaceSpendSection
        mtd={bundle.workspaceMtd}
        year={bundle.workspaceYear}
      />
    </div>
  );
}

// ─── Cron health ───────────────────────────────────────────────────────────

function CronHealthSection({ rows }: { rows: CronHealthRow[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <SectionCard
      icon={Activity}
      title="Cron Health"
      description="Last 30 days per scheduled job. Stalled = status still 'running' after 15 minutes. Click a row to see recent executions."
    >
      {rows.length === 0 ? (
        <EmptyState
          message="No cron runs recorded yet. The first scheduled execution will populate this table."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-[--bg-secondary]">
          <table className="w-full text-sm">
            <thead className="border-b border-white/10 bg-white/[0.02]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-white/40">
                <th className="px-4 py-3 font-medium">Cron</th>
                <th className="px-4 py-3 font-medium">Last run</th>
                <th className="px-4 py-3 font-medium">30d ok</th>
                <th className="px-4 py-3 font-medium">30d err</th>
                <th className="px-4 py-3 font-medium">Stalled</th>
                <th className="px-4 py-3 font-medium">Avg duration</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <CronRow
                  key={r.cronName}
                  row={r}
                  isExpanded={expanded === r.cronName}
                  onToggle={() =>
                    setExpanded((cur) => (cur === r.cronName ? null : r.cronName))
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function CronRow({
  row,
  isExpanded,
  onToggle,
}: {
  row: CronHealthRow;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const last = row.lastRun;
  const isHealthy =
    row.stats30d.errored === 0 && row.stats30d.stalled === 0 && row.stats30d.total > 0;
  return (
    <>
      <tr
        className="cursor-pointer border-b border-white/5 transition-colors hover:bg-white/[0.02]"
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <StatusDot status={last?.status ?? 'running'} />
            <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white">
              {row.cronName}
            </span>
          </div>
        </td>
        <td className="px-4 py-3">
          {last ? (
            <div>
              <div className="text-white/80">{formatRelative(last.startedAt)}</div>
              <div className="mt-0.5 text-[10px] text-white/40">
                {last.durationMs != null ? formatDuration(last.durationMs) : '—'}
              </div>
            </div>
          ) : (
            <span className="text-white/40">never</span>
          )}
        </td>
        <td className="px-4 py-3 text-white/70">{row.stats30d.ok}</td>
        <td className="px-4 py-3">
          <span
            className={
              row.stats30d.errored > 0 ? 'font-semibold text-red-300' : 'text-white/70'
            }
          >
            {row.stats30d.errored}
          </span>
        </td>
        <td className="px-4 py-3">
          <span
            className={
              row.stats30d.stalled > 0
                ? 'font-semibold text-amber-300'
                : 'text-white/70'
            }
          >
            {row.stats30d.stalled}
          </span>
        </td>
        <td className="px-4 py-3 text-white/70">
          {row.stats30d.avgDurationMs != null
            ? formatDuration(row.stats30d.avgDurationMs)
            : '—'}
        </td>
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-2">
            {isHealthy && (
              <CheckCircle2
                size={14}
                strokeWidth={1.5}
                className="text-[--rag-green]"
              />
            )}
            {isExpanded ? (
              <ChevronDown size={14} strokeWidth={1.5} className="text-white/40" />
            ) : (
              <ChevronRight size={14} strokeWidth={1.5} className="text-white/40" />
            )}
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={7} className="border-b border-white/5 bg-black/20 p-0">
            <div className="px-8 py-5">
              <div className="mb-3 text-[10px] font-medium uppercase tracking-widest text-white/40">
                Last {row.recentRuns.length} execution{row.recentRuns.length === 1 ? '' : 's'}
              </div>
              {row.recentRuns.length === 0 ? (
                <div className="text-xs text-white/40">No runs recorded.</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {row.recentRuns.map((run) => (
                    <CronRunDetail key={run.id} run={run} />
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function CronRunDetail({ run }: { run: CronRunRow }) {
  const [showJson, setShowJson] = useState(false);
  const summaryStr = useMemo(
    () => (run.summary != null ? JSON.stringify(run.summary, null, 2) : ''),
    [run.summary],
  );

  return (
    <div className="rounded-lg border border-white/10 bg-[--bg-secondary]/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <StatusDot status={run.status} />
          <div className="font-[family-name:var(--font-geist-mono)] text-xs text-white/90">
            {run.startedAt.toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
          <StatusBadge status={run.status} />
        </div>
        <div className="flex items-center gap-2 font-[family-name:var(--font-geist-mono)] text-[10px] text-white/50">
          <Clock size={10} strokeWidth={1.5} />
          {run.durationMs != null ? formatDuration(run.durationMs) : 'in flight'}
        </div>
      </div>

      {run.error && (
        <div className="mt-2 rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-200">
          {run.error}
        </div>
      )}

      {summaryStr && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowJson((v) => !v)}
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-white/40 transition-colors hover:text-white/70"
          >
            {showJson ? 'hide summary' : 'show summary'}
          </button>
          {showJson && (
            <pre className="mt-2 overflow-x-auto rounded-md border border-white/10 bg-black/40 p-3 text-[11px] leading-relaxed text-white/70">
              {summaryStr}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: CronStatus }) {
  const color =
    status === 'ok'
      ? 'bg-[--rag-green]'
      : status === 'error'
        ? 'bg-red-400'
        : status === 'stalled'
          ? 'bg-amber-400'
          : 'bg-blue-400 animate-pulse';
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

function StatusBadge({ status }: { status: CronStatus }) {
  const cls =
    status === 'ok'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
      : status === 'error'
        ? 'border-red-500/30 bg-red-500/10 text-red-300'
        : status === 'stalled'
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
          : 'border-blue-500/30 bg-blue-500/10 text-blue-300';
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls}`}
    >
      {status}
    </span>
  );
}

// ─── Firm health snapshot ──────────────────────────────────────────────────

function FirmHealthSection({ rows }: { rows: FirmHealthRow[] }) {
  return (
    <SectionCard
      icon={ShieldCheck}
      title="Firm Health"
      description="Per-firm triage snapshot. Click a row to jump into that firm's dashboard."
    >
      {rows.length === 0 ? (
        <EmptyState message="No firms yet. Add one from the clients page." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-[--bg-secondary]">
          <table className="w-full text-sm">
            <thead className="border-b border-white/10 bg-white/[0.02]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-white/40">
                <th className="px-4 py-3 font-medium">Firm</th>
                <th className="px-4 py-3 font-medium">Last audit</th>
                <th className="px-4 py-3 font-medium">BT</th>
                <th className="px-4 py-3 font-medium" title="Unified remediation queue — audit, legacy, entity, reddit combined">Open tickets</th>
                <th className="px-4 py-3 font-medium" title="Reddit complaints still in the open triage bucket">Open complaints</th>
                <th className="px-4 py-3 font-medium">This month report</th>
                <th className="px-4 py-3 font-medium">Budget (MTD)</th>
                <th className="px-4 py-3 font-medium">30d err</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <FirmRow key={r.firmId} row={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function FirmRow({ row }: { row: FirmHealthRow }) {
  const auditTone =
    row.lastAudit?.status === 'failed'
      ? 'text-red-300'
      : row.lastAudit?.status === 'completed'
        ? 'text-white/80'
        : 'text-white/60';
  const budgetTone = row.budget.overBudget
    ? 'text-red-300'
    : row.budget.utilizationPct >= 90
      ? 'text-amber-300'
      : 'text-white/80';
  const errorTone =
    row.lastAuditErrorCount30d > 0 ? 'text-red-300 font-semibold' : 'text-white/60';

  return (
    <tr className="border-b border-white/5 transition-colors hover:bg-white/[0.02]">
      <td className="px-4 py-3">
        <Link
          href={`/dashboard/${row.slug}`}
          className="group flex flex-col"
        >
          <span className="font-semibold text-white group-hover:text-[--accent]">
            {row.name}
          </span>
          <span className="font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40">
            /{row.slug}
          </span>
        </Link>
      </td>
      <td className="px-4 py-3">
        {row.lastAudit ? (
          <div>
            <div className={auditTone}>
              {row.lastAudit.startedAt
                ? formatRelative(row.lastAudit.startedAt)
                : 'pending'}
            </div>
            <div className="mt-0.5 text-[10px] text-white/40">
              {row.lastAudit.kind} · {row.lastAudit.status}
            </div>
          </div>
        ) : (
          <span className="text-white/40">never</span>
        )}
      </td>
      <td className="px-4 py-3 font-[family-name:var(--font-geist-mono)] text-xs">
        {row.brandTruthVersion != null ? (
          <span className="text-white/80">v{row.brandTruthVersion}</span>
        ) : (
          <span className="text-amber-300">unset</span>
        )}
      </td>
      <td className="px-4 py-3">
        {row.openTicketCount > 0 ? (
          <Link
            href={`/dashboard/${row.slug}/tickets?status=open`}
            className="inline-flex items-center gap-1.5 rounded-full bg-[--accent]/15 px-2.5 py-0.5 font-semibold text-[--accent] underline-offset-2 hover:underline"
            title="Open the unified remediation queue for this firm"
          >
            {row.openTicketCount}
          </Link>
        ) : (
          <span className="text-white/70">0</span>
        )}
      </td>
      <td className="px-4 py-3">
        {row.openMentionCount > 0 ? (
          <Link
            href={`/dashboard/${row.slug}/reddit?status=open`}
            className="font-semibold text-amber-300 underline-offset-2 hover:underline"
            title="Open the triage queue for this firm"
          >
            {row.openMentionCount}
          </Link>
        ) : (
          <span className="text-white/70">0</span>
        )}
      </td>
      <td className="px-4 py-3">
        {row.monthlyReportGenerated ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-[--rag-green]">
            <CheckCircle2 size={12} strokeWidth={1.5} />
            generated
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-white/40">
            <Circle size={12} strokeWidth={1.5} />
            pending
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <div className={budgetTone}>
          ${row.budget.spentThisMonthUsd.toFixed(2)}{' '}
          <span className="text-xs text-white/40">
            / ${row.budget.monthlyCapUsd.toFixed(2)}
          </span>
        </div>
        <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-white/5">
          <div
            className={`h-full rounded-full ${
              row.budget.overBudget
                ? 'bg-red-500'
                : row.budget.utilizationPct >= 90
                  ? 'bg-amber-500'
                  : 'bg-[--accent]'
            }`}
            style={{ width: `${row.budget.utilizationPct}%` }}
          />
        </div>
        <div className="mt-0.5 font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40">
          {row.budget.source === 'firm' ? 'firm cap' : 'default cap'}
        </div>
      </td>
      <td className={`px-4 py-3 ${errorTone}`}>{row.lastAuditErrorCount30d}</td>
    </tr>
  );
}

// ─── Workspace spend ───────────────────────────────────────────────────────

function WorkspaceSpendSection({
  mtd,
  year,
}: {
  mtd: WorkspaceCostBreakdown;
  year: WorkspaceCostBreakdown[];
}) {
  const maxTotal = useMemo(
    () => Math.max(1, ...year.map((m) => m.total)),
    [year],
  );

  return (
    <SectionCard
      icon={TrendingUp}
      title="Workspace Spend"
      description="Aggregate cost across every firm. Audits are scheduler-driven; rewrites are operator-initiated."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <CostTile
          icon={BadgeDollarSign}
          label="Total this month"
          value={mtd.total}
          tone="accent"
        />
        <CostTile
          icon={TrendingUp}
          label="Audits"
          value={mtd.audits}
          tone="neutral"
        />
        <CostTile
          icon={Wand2}
          label="Rewrite drafts"
          value={mtd.rewrites}
          tone="neutral"
        />
      </div>

      <div className="mt-6 rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
            12-month workspace spend
          </div>
          <div className="flex items-center gap-3 text-[10px] text-white/55">
            <LegendSwatch color="bg-[--accent]" label="Audits" />
            <LegendSwatch color="bg-purple-400" label="Rewrites" />
          </div>
        </div>
        <div className="flex h-40 items-end gap-1">
          {year.map((m) => (
            <BarColumn key={m.month} month={m} maxTotal={maxTotal} />
          ))}
        </div>
        <div className="mt-2 flex justify-between font-[family-name:var(--font-geist-mono)] text-[10px] text-white/30">
          <span>{year[0]?.month ?? ''}</span>
          <span>{year[year.length - 1]?.month ?? ''}</span>
        </div>
      </div>
    </SectionCard>
  );
}

function CostTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof BadgeDollarSign;
  label: string;
  value: number;
  tone: 'accent' | 'neutral';
}) {
  const valueClass = tone === 'accent' ? 'text-[--accent]' : 'text-white';
  return (
    <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-widest text-white/40">
        <Icon size={12} strokeWidth={1.5} />
        {label}
      </div>
      <div className={`mt-2 font-[family-name:var(--font-jakarta)] text-2xl font-bold ${valueClass}`}>
        ${value.toFixed(2)}
      </div>
    </div>
  );
}

function BarColumn({
  month,
  maxTotal,
}: {
  month: WorkspaceCostBreakdown;
  maxTotal: number;
}) {
  const auditsPct = (month.audits / maxTotal) * 100;
  const rewritesPct = (month.rewrites / maxTotal) * 100;
  const hasSpend = month.total > 0;
  return (
    <div className="group flex flex-1 flex-col items-center gap-1">
      <div className="relative flex h-full w-full flex-col justify-end">
        <div className="pointer-events-none absolute -top-10 left-1/2 z-10 -translate-x-1/2 rounded-md border border-white/10 bg-black/80 px-2 py-1 text-[10px] font-[family-name:var(--font-geist-mono)] text-white/90 opacity-0 transition-opacity group-hover:opacity-100">
          {month.month}: ${month.total.toFixed(2)}
        </div>
        {hasSpend ? (
          <>
            <div
              className="w-full rounded-t-sm bg-purple-400"
              style={{ height: `${rewritesPct}%` }}
              title={`Rewrites: $${month.rewrites.toFixed(2)}`}
            />
            <div
              className={`w-full bg-[--accent] ${rewritesPct === 0 ? 'rounded-t-sm' : ''}`}
              style={{ height: `${auditsPct}%` }}
              title={`Audits: $${month.audits.toFixed(2)}`}
            />
          </>
        ) : (
          <div className="h-[2px] w-full bg-white/10" />
        )}
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-sm ${color}`} />
      {label}
    </span>
  );
}

// ─── Shared atoms ──────────────────────────────────────────────────────────

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Activity;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[--bg-secondary]/40 p-6">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/5">
          <Icon size={18} strokeWidth={1.5} className="text-[--accent]" />
        </div>
        <div>
          <h2 className="font-[family-name:var(--font-jakarta)] text-lg font-semibold text-white">
            {title}
          </h2>
          <p className="mt-1 text-sm text-white/55">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed border-white/10 bg-[--bg-secondary]/50 px-6 py-8 text-sm text-white/50">
      <AlertCircle size={16} strokeWidth={1.5} />
      {message}
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Short human-readable relative time. Keeps the admin table scannable —
 * operators care about "is this fresh?" not the exact timestamp.
 */
function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}
