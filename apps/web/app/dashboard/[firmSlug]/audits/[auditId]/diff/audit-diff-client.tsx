'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Minus,
  Plus,
  XCircle,
  Clock,
} from 'lucide-react';
import type {
  AuditDiff,
  AuditDiffRow,
  Movement,
  RagLabel,
} from '../../../../../actions/audit-diff-actions';

type MovementFilter = 'all' | Movement;

function formatDateTime(d: Date | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const RAG_CLASS: Record<RagLabel, string> = {
  red: 'bg-[--rag-red-bg] text-[--rag-red] border-[--rag-red]/30',
  yellow: 'bg-[--rag-yellow-bg] text-[--rag-yellow] border-[--rag-yellow]/30',
  green: 'bg-[--rag-green-bg] text-[--rag-green] border-[--rag-green]/30',
};

const MOVEMENT_META: Record<
  Movement,
  { label: string; tone: 'danger' | 'warning' | 'success' | 'neutral'; Icon: typeof ArrowDownRight }
> = {
  regressed: { label: 'Regressed', tone: 'danger', Icon: ArrowDownRight },
  improved: { label: 'Improved', tone: 'success', Icon: ArrowUpRight },
  stable: { label: 'Stable', tone: 'neutral', Icon: Minus },
  new: { label: 'New', tone: 'neutral', Icon: Plus },
  dropped: { label: 'Dropped', tone: 'neutral', Icon: XCircle },
};

const TONE_CLASS: Record<'danger' | 'warning' | 'success' | 'neutral', string> = {
  danger: 'text-red-300',
  warning: 'text-amber-300',
  success: 'text-emerald-300',
  neutral: 'text-white/55',
};

export function AuditDiffClient({
  firmSlug,
  diff,
}: {
  firmSlug: string;
  diff: AuditDiff;
}) {
  const [filter, setFilter] = useState<MovementFilter>('regressed');

  const rowsForFilter = useMemo(
    () => (filter === 'all' ? diff.rows : diff.rows.filter((r) => r.movement === filter)),
    [diff.rows, filter],
  );

  // Default to "regressed" but if that's empty, fall through to "all" so the
  // operator doesn't land on an empty table.
  const displayedRows = rowsForFilter.length === 0 && filter !== 'all' ? diff.rows : rowsForFilter;
  const displayedFilter: MovementFilter =
    rowsForFilter.length === 0 && filter !== 'all' ? 'all' : filter;

  if (!diff.previous) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 bg-[--bg-secondary] p-10 text-center">
        <Clock size={28} strokeWidth={1.5} className="mx-auto mb-3 text-white/30" />
        <p className="text-sm text-white/55">
          No earlier scoring run to compare against. Once at least one more
          weekly or daily-priority audit completes, this page will show
          per-query movement.
        </p>
        <Link
          href={`/dashboard/${firmSlug}/audits`}
          className="mt-4 inline-block rounded-lg bg-white/5 px-4 py-2 text-sm text-white hover:bg-white/10"
        >
          Back to audits
        </Link>
      </div>
    );
  }

  return (
    <>
      {/* Run context */}
      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <RunContextCard label="Latest" ctx={diff.latest} firmSlug={firmSlug} />
        <RunContextCard
          label={`Compared to${diff.previous ? '' : ' (none)'}`}
          ctx={diff.previous}
          firmSlug={firmSlug}
        />
      </div>

      {/* Summary tiles — click to filter */}
      <div className="mb-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryTile
          label="All"
          value={diff.summary.total}
          tone="neutral"
          active={filter === 'all'}
          onClick={() => setFilter('all')}
        />
        <SummaryTile
          label="Regressed"
          value={diff.summary.regressed}
          tone="danger"
          active={filter === 'regressed'}
          onClick={() => setFilter('regressed')}
        />
        <SummaryTile
          label="Improved"
          value={diff.summary.improved}
          tone="success"
          active={filter === 'improved'}
          onClick={() => setFilter('improved')}
        />
        <SummaryTile
          label="Stable"
          value={diff.summary.stable}
          tone="neutral"
          active={filter === 'stable'}
          onClick={() => setFilter('stable')}
        />
        <SummaryTile
          label="New"
          value={diff.summary.new}
          tone="neutral"
          active={filter === 'new'}
          onClick={() => setFilter('new')}
        />
        <SummaryTile
          label="Dropped"
          value={diff.summary.dropped}
          tone="neutral"
          active={filter === 'dropped'}
          onClick={() => setFilter('dropped')}
        />
      </div>

      {/* Filter fall-through note */}
      {displayedFilter === 'all' && filter !== 'all' ? (
        <div className="mb-3 text-xs text-white/40">
          No rows in "{filter}" — showing all.
        </div>
      ) : null}

      {/* Rows */}
      {displayedRows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 bg-[--bg-secondary] p-10 text-center">
          <p className="text-sm text-white/55">No rows in this diff.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-[--bg-secondary]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-white/5 text-left text-[10px] font-medium uppercase tracking-widest text-white/40">
                <th className="px-4 py-3">Query · provider</th>
                <th className="px-4 py-3">Was</th>
                <th className="px-4 py-3" />
                <th className="px-4 py-3">Now</th>
                <th className="px-4 py-3">Movement</th>
                <th className="px-4 py-3">Why</th>
              </tr>
            </thead>
            <tbody>
              {displayedRows.map((row, idx) => (
                <DiffRow key={`${row.queryText}|${row.provider}|${idx}`} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function RunContextCard({
  label,
  ctx,
  firmSlug,
}: {
  label: string;
  ctx: AuditDiff['latest'] | null;
  firmSlug: string;
}) {
  if (!ctx) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 bg-[--bg-secondary] p-5">
        <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
          {label}
        </div>
        <div className="mt-2 text-sm text-white/55">No run selected</div>
      </div>
    );
  }
  return (
    <Link
      href={`/dashboard/${firmSlug}/audits/${ctx.runId}`}
      className="group block rounded-xl border border-white/10 bg-[--bg-secondary] p-5 transition-colors hover:border-[--accent]/30"
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
          {label}
        </div>
        {ctx.kind ? (
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/55">
            {ctx.kind}
          </span>
        ) : null}
      </div>
      <div className="mt-2 font-[family-name:var(--font-jakarta)] text-base font-semibold text-white">
        {formatDateTime(ctx.startedAt)}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <RagPill label="red" pct={ctx.redPct} />
        <RagPill label="yellow" pct={ctx.yellowPct} />
        <RagPill label="green" pct={ctx.greenPct} />
      </div>
      <div className="mt-2 inline-flex items-center gap-1.5 text-xs text-[--accent] opacity-0 transition-opacity group-hover:opacity-100">
        Open run <ArrowRight size={12} strokeWidth={2} />
      </div>
    </Link>
  );
}

function RagPill({ label, pct }: { label: RagLabel; pct: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${RAG_CLASS[label]}`}
    >
      <span className="text-white/55">{label}</span>
      {pct.toFixed(1)}%
    </span>
  );
}

function SummaryTile({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone: 'danger' | 'warning' | 'success' | 'neutral';
  active: boolean;
  onClick: () => void;
}) {
  const border = active
    ? tone === 'danger'
      ? 'border-red-500/60'
      : tone === 'success'
        ? 'border-emerald-500/60'
        : 'border-white/40'
    : 'border-white/10';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border bg-[--bg-secondary] p-4 text-left transition-colors hover:border-white/30 ${border}`}
    >
      <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
        {label}
      </div>
      <div
        className={`mt-1 font-[family-name:var(--font-jakarta)] text-2xl font-bold ${TONE_CLASS[tone]}`}
      >
        {value}
      </div>
    </button>
  );
}

function DiffRow({ row }: { row: AuditDiffRow }) {
  const meta = MOVEMENT_META[row.movement];
  return (
    <tr className="border-b border-white/5 align-top last:border-b-0">
      <td className="px-4 py-3">
        <div className="font-medium text-white">{row.queryText}</div>
        <div className="mt-0.5 font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40">
          {row.provider}
        </div>
      </td>
      <td className="px-4 py-3">
        <LabelCell label={row.previousLabel} tone={row.previousToneScore} />
      </td>
      <td className="px-2 py-3 text-white/30">
        <ArrowRight size={14} strokeWidth={2} />
      </td>
      <td className="px-4 py-3">
        <LabelCell label={row.latestLabel} tone={row.latestToneScore} />
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${TONE_CLASS[meta.tone]}`}>
          <meta.Icon size={14} strokeWidth={2} />
          {meta.label}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-white/55">
        <GapReasons
          previous={row.previousGapReasons}
          latest={row.latestGapReasons}
          movement={row.movement}
        />
      </td>
    </tr>
  );
}

function LabelCell({ label, tone }: { label: RagLabel | null; tone: number | null }) {
  if (!label) {
    return <span className="text-xs text-white/30">—</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      <span
        className={`inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${RAG_CLASS[label]}`}
      >
        {label}
      </span>
      {tone !== null ? (
        <span className="font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40">
          tone {tone.toFixed(1)}/10
        </span>
      ) : null}
    </div>
  );
}

/**
 * For regressed rows we show the *new* gap reasons (the latest run's reasons).
 * For improved rows we show the *old* gap reasons — because the operator
 * already fixed those, and seeing them confirms what changed. Stable rows
 * show whichever list is non-empty.
 */
function GapReasons({
  previous,
  latest,
  movement,
}: {
  previous: string[];
  latest: string[];
  movement: Movement;
}) {
  let reasons: string[] = [];
  if (movement === 'regressed' || movement === 'new') reasons = latest;
  else if (movement === 'improved' || movement === 'dropped') reasons = previous;
  else reasons = latest.length > 0 ? latest : previous;

  if (reasons.length === 0) return <span className="text-white/30">—</span>;
  return (
    <ul className="list-disc space-y-0.5 pl-4">
      {reasons.slice(0, 3).map((r, i) => (
        <li key={i}>{r}</li>
      ))}
      {reasons.length > 3 ? (
        <li className="list-none text-[10px] text-white/40">+{reasons.length - 3} more</li>
      ) : null}
    </ul>
  );
}
