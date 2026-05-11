import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2,
  Circle,
  Clock,
  AlertCircle,
  ArrowRight,
  ChevronRight,
} from 'lucide-react';
import {
  listSopRunsForFirm,
  type SopRunSummary,
} from '../../../actions/sop-actions';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { getPhaseByKey, SOP_REGISTRY } from '../../../lib/sop/registry';
import { ensurePhaseOneSopRunsBySlug } from '../../../lib/sop/auto-start';
import type { PhaseKey, SopKey } from '../../../lib/sop/types';

/**
 * Shared phase page shell. Each of the 7 phase routes
 * (brand-audit-analysis, measurement-monitoring, etc.) is a thin
 * wrapper that renders this with its own phaseKey. The shell does
 * all the data loading + rendering work.
 *
 * The page shows ONLY the workflows for one phase — no overview of
 * other phases, no umbrella "all SOPs" view. The 7 sidebar tabs are
 * the navigation surface.
 */
export async function PhasePageShell({
  firmSlug,
  phaseKey,
}: {
  firmSlug: string;
  phaseKey: PhaseKey;
}) {
  const phase = getPhaseByKey(phaseKey);
  if (!phase) notFound();

  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  // Idempotent: on first visit, create Phase 1 runs anchored to existing
  // scanner data. No-op for subsequent visits.
  await ensurePhaseOneSopRunsBySlug(firmSlug).catch((e) => {
    console.error('[phase:auto-start] failed:', e);
  });

  const allRuns = await listSopRunsForFirm(firmSlug).catch(() => [] as SopRunSummary[]);
  const runsByKey = new Map(allRuns.map((r) => [r.sopKey, r]));
  const phaseRuns = phase.sopKeys.map((k) => ({
    def: SOP_REGISTRY[k],
    run: runsByKey.get(k),
  }));

  const completedCount = phaseRuns.filter((r) => r.run?.status === 'completed').length;
  const inProgressCount = phaseRuns.filter((r) => r.run?.status === 'in_progress' || r.run?.status === 'awaiting_input').length;

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          {phase.name}
        </h1>
        <p className="mt-2 max-w-3xl text-white/55">{phase.description}</p>
        <p className="mt-2 font-[family-name:var(--font-geist-mono)] text-[11px] text-white/40">
          {phase.sopKeys.length} workflow{phase.sopKeys.length === 1 ? '' : 's'} ·{' '}
          {completedCount} completed · {inProgressCount} in progress
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {phaseRuns.map(({ def, run }) => (
          <WorkflowCard key={def.key} firmSlug={firmSlug} sopKey={def.key} run={run} />
        ))}
      </div>
    </div>
  );
}

function WorkflowCard({
  firmSlug,
  sopKey,
  run,
}: {
  firmSlug: string;
  sopKey: SopKey;
  run: SopRunSummary | undefined;
}) {
  const def = SOP_REGISTRY[sopKey];
  const status = run?.status ?? 'not_started';
  const pct = run ? Math.round(((run.currentStep - (status === 'completed' ? 0 : 1)) / run.totalSteps) * 100) : 0;
  const isExecutable = run?.isExecutable ?? false;

  return (
    <Link
      href={`/dashboard/${firmSlug}/workflow/${sopKey}`}
      className="group flex flex-col gap-2 rounded-lg border border-white/10 bg-[var(--bg-secondary)] p-4 transition-colors hover:border-white/30"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-white">{def.name}</div>
          <div className="mt-0.5 text-[11px] text-white/40">{def.timeRequired}</div>
        </div>
        <StatusPill status={status} executable={isExecutable} />
      </div>
      {run && status !== 'not_started' && (
        <div className="mt-1">
          <div className="h-1 overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full bg-[var(--accent)]"
              style={{ width: `${Math.max(pct, 4)}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 font-[family-name:var(--font-geist-mono)] text-[10px] text-white/55">
            <span>
              Step {run.currentStep}/{run.totalSteps}
            </span>
            <span>
              {run.ticketCount} ticket{run.ticketCount === 1 ? '' : 's'} ·{' '}
              {run.deliverableCount} deliverable{run.deliverableCount === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      )}
      {(!run || status === 'not_started') && (
        <div className="mt-1 flex items-center gap-1 text-xs text-white/55 group-hover:text-white">
          {isExecutable ? (
            <>
              Start workflow
              <ArrowRight size={12} strokeWidth={2} />
            </>
          ) : (
            <>
              <ChevronRight size={12} strokeWidth={2} />
              View definition
            </>
          )}
        </div>
      )}
    </Link>
  );
}

function StatusPill({ status, executable }: { status: string; executable: boolean }) {
  if (!executable) {
    return (
      <span className="shrink-0 rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/55">
        Coming soon
      </span>
    );
  }
  const map: Record<string, { tone: string; label: string; Icon: typeof CheckCircle2 }> = {
    not_started: { tone: 'border-white/15 bg-white/5 text-white/55', label: 'Not started', Icon: Circle },
    in_progress: { tone: 'border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--accent)]', label: 'In progress', Icon: Clock },
    awaiting_input: { tone: 'border-[var(--rag-yellow)]/30 bg-[var(--rag-yellow-bg)] text-[var(--rag-yellow)]', label: 'Awaiting input', Icon: AlertCircle },
    completed: { tone: 'border-[var(--rag-green)]/30 bg-[var(--rag-green-bg)] text-[var(--rag-green)]', label: 'Completed', Icon: CheckCircle2 },
    paused: { tone: 'border-white/15 bg-white/5 text-white/55', label: 'Paused', Icon: Circle },
    cancelled: { tone: 'border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] text-[var(--rag-red)]', label: 'Cancelled', Icon: AlertCircle },
  };
  const v = map[status] ?? map.not_started;
  if (!v) return null;
  const Icon = v.Icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${v.tone}`}
    >
      <Icon size={10} strokeWidth={2} />
      {v.label}
    </span>
  );
}
