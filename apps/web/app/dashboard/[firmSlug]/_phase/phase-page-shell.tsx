import { notFound } from 'next/navigation';
import { CheckCircle2, AlertCircle, Clock, Hand } from 'lucide-react';
import {
  getPhaseExecutionTasks,
  type ExecutionTask,
} from '../../../actions/sop-actions';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { getPhaseByKey } from '../../../lib/sop/registry';
import { ensurePhaseOneSopRunsBySlug } from '../../../lib/sop/auto-start';
import type { PhaseKey } from '../../../lib/sop/types';
import { ScanControlsClient } from './scan-controls-client';
import { ExecutionTaskRow } from './execution-task-row';

/**
 * Phase page shell — scanner output, not a workflow walkthrough.
 *
 * The operator sees:
 *   1. A scan-controls strip: last scan timestamp + "Run scan" button +
 *      status pills for each underlying scanner (BVA / Suppression /
 *      Messaging in Phase 1; the rest of the 7 phases follow the same
 *      pattern as they get wired).
 *   2. A ranked execution-task list — every remediation_ticket the
 *      scanners produced for this phase, sorted by priority and tagged
 *      with its automation tier (auto / assist / manual).
 *
 * The old workflow-cards-with-steps UI is gone. The SOPs are now the
 * scanner specification (in lib/sop/registry.ts), not a UI surface the
 * operator clicks through.
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

  // Idempotent: first visit creates Phase 1 runs anchored to existing
  // scanner data. No-op on subsequent visits.
  await ensurePhaseOneSopRunsBySlug(firmSlug).catch((e) => {
    console.error('[phase:auto-start] failed:', e);
  });

  const detail = await getPhaseExecutionTasks(firmSlug, phaseKey);

  // Group tasks by automation tier so the operator sees "what the tool
  // will fix automatically" separately from "what you need to paste"
  // and "what you have to do by hand."
  const autoTasks = detail.tasks.filter((t) => t.automationTier === 'auto');
  const assistTasks = detail.tasks.filter((t) => t.automationTier === 'assist');
  const manualTasks = detail.tasks.filter((t) => t.automationTier === 'manual');
  const untaggedTasks = detail.tasks.filter((t) => !t.automationTier);

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          {phase.name}
        </h1>
        <p className="mt-2 max-w-3xl text-white/55">{phase.description}</p>
      </div>

      <ScanControlsClient
        firmSlug={firmSlug}
        phaseKey={phaseKey}
        lastScan={{
          completedAt: detail.lastScan.completedAt?.toISOString() ?? null,
          runsByKey: detail.lastScan.runsByKey,
        }}
      />

      {detail.tasks.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="mt-8 flex flex-col gap-6">
          <TaskCountSummary
            total={detail.tasks.length}
            auto={autoTasks.length}
            assist={assistTasks.length}
            manual={manualTasks.length}
          />

          {autoTasks.length > 0 && (
            <TaskGroup
              title="Auto-execute"
              subtitle="The tool can fix these directly via API. Click Apply."
              Icon={CheckCircle2}
              tone="ok"
              tasks={autoTasks}
            />
          )}

          {assistTasks.length > 0 && (
            <TaskGroup
              title="Assist"
              subtitle="No public write API on the platform. The tool drafted the exact copy — click to open the admin UI and paste."
              Icon={Clock}
              tone="warn"
              tasks={assistTasks}
            />
          )}

          {manualTasks.length > 0 && (
            <TaskGroup
              title="Manual handoff"
              subtitle="Automation isn't possible for these (policy, TOS, or human conversation). Tool surfaces why."
              Icon={Hand}
              tone="manual"
              tasks={manualTasks}
            />
          )}

          {untaggedTasks.length > 0 && (
            <TaskGroup
              title="Other"
              subtitle="Pre-existing tickets from legacy scanners. Re-run the relevant scan to re-tag them."
              Icon={AlertCircle}
              tone="neutral"
              tasks={untaggedTasks}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TaskCountSummary({
  total,
  auto,
  assist,
  manual,
}: {
  total: number;
  auto: number;
  assist: number;
  manual: number;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-4">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
        Execution tasks
      </div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-3">
        <span className="font-[family-name:var(--font-jakarta)] text-2xl font-bold text-white">{total}</span>
        <span className="text-xs text-white/55">total · ranked by priority</span>
        <span className="ml-auto flex items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--rag-green)]/15 px-2 py-0.5 text-[var(--rag-green)]">
            {auto} auto
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--rag-yellow-bg)] px-2 py-0.5 text-[var(--rag-yellow)]">
            {assist} assist
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--rag-red-bg)] px-2 py-0.5 text-[var(--rag-red)]">
            {manual} manual
          </span>
        </span>
      </div>
    </div>
  );
}

function TaskGroup({
  title,
  subtitle,
  Icon,
  tone,
  tasks,
}: {
  title: string;
  subtitle: string;
  Icon: typeof CheckCircle2;
  tone: 'ok' | 'warn' | 'manual' | 'neutral';
  tasks: ExecutionTask[];
}) {
  const toneClass = {
    ok: 'text-[var(--rag-green)]',
    warn: 'text-[var(--rag-yellow)]',
    manual: 'text-[var(--rag-red)]',
    neutral: 'text-white/55',
  }[tone];
  return (
    <section className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
      <header className="mb-4 flex items-start gap-2.5">
        <Icon size={16} strokeWidth={2} className={`mt-0.5 shrink-0 ${toneClass}`} />
        <div>
          <h2 className="font-[family-name:var(--font-jakarta)] text-lg font-bold text-white">
            {title} <span className="ml-1 text-sm font-normal text-white/40">({tasks.length})</span>
          </h2>
          <p className="mt-0.5 text-xs text-white/55">{subtitle}</p>
        </div>
      </header>
      <ul className="flex flex-col gap-2">
        {tasks.map((t) => (
          <li key={t.id}>
            <ExecutionTaskRow task={t} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function EmptyState() {
  return (
    <div className="mt-8 rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-6 text-center">
      <p className="text-white/60">
        No execution tasks yet. Click <strong>Run scan</strong> above to scan the site and surface what needs fixing.
      </p>
    </div>
  );
}
