'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  Circle,
  Clock,
  AlertCircle,
  Loader2,
  Play,
  PauseCircle,
  ChevronRight,
  Sparkles,
  FileDown,
  Inbox,
  HelpCircle,
} from 'lucide-react';
import {
  startSopRun,
  completeStep,
  pauseSopRun,
  resumeSopRun,
  type SopRunDetail,
} from '../../../../actions/sop-actions';
import type { SopStep, SopGate } from '../../../../lib/sop/types';

/**
 * Workflow client — the interactive shell for one SOP run.
 *
 * Left rail: the N steps with status pills and click-to-jump.
 * Main area: the selected step's data inputs / operator actions / gates,
 * plus a Complete Step button that's disabled until required gates pass.
 *
 * The step the operator opens by default is the run's current_step (or
 * step 1 if no run exists yet). They can click any step in the left
 * rail to inspect its definition / output, but only the current step's
 * Complete button is active.
 */
export function SopWorkflowClient({
  firmSlug,
  detail,
}: {
  firmSlug: string;
  detail: SopRunDetail;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const initialStep = detail.run?.currentStep ?? 1;
  const [activeStepNumber, setActiveStepNumber] = useState(initialStep);

  const activeStepDef = detail.def.steps.find((s) => s.number === activeStepNumber);
  const activeStepState = detail.steps.find((s) => s.number === activeStepNumber);
  const isExecutable = detail.def.steps.every((s) => s.process.length > 0);
  const isRunActive = detail.run?.status === 'in_progress' || detail.run?.status === 'awaiting_input';
  const canCompleteCurrent = isRunActive && activeStepNumber === detail.run?.currentStep;

  const handleStart = () => {
    setError(null);
    start(async () => {
      const r = await startSopRun({ firmSlug, sopKey: detail.def.key });
      if (r.ok) {
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  };

  const handlePause = () => {
    if (!detail.run) return;
    const reason = window.prompt('Reason for pausing? (optional)') ?? 'no reason given';
    start(async () => {
      await pauseSopRun({ firmSlug, sopKey: detail.def.key, runId: detail.run!.id, reason });
      router.refresh();
    });
  };

  const handleResume = () => {
    if (!detail.run) return;
    start(async () => {
      await resumeSopRun({ firmSlug, sopKey: detail.def.key, runId: detail.run!.id });
      router.refresh();
    });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      {/* Left rail — steps + run status */}
      <aside className="flex flex-col gap-3">
        <RunStatusCard
          detail={detail}
          isExecutable={isExecutable}
          isPending={isPending}
          onStart={handleStart}
          onPause={handlePause}
          onResume={handleResume}
        />
        <StepRail
          steps={detail.def.steps}
          stepStates={detail.steps}
          activeStepNumber={activeStepNumber}
          currentStep={detail.run?.currentStep ?? 1}
          runStarted={Boolean(detail.run)}
          onSelect={(n) => {
            setError(null);
            setActiveStepNumber(n);
          }}
        />
        {detail.deliverables.length > 0 && <DeliverableList deliverables={detail.deliverables} />}
      </aside>

      {/* Main — selected step detail */}
      <main className="flex flex-col gap-4">
        {!activeStepDef ? (
          <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-6 text-white/55">
            Step not found.
          </div>
        ) : (
          <StepDetail
            firmSlug={firmSlug}
            def={detail.def}
            stepDef={activeStepDef}
            stepState={activeStepState}
            canComplete={canCompleteCurrent}
            isPending={isPending}
            onComplete={(confirmations, notes) => {
              setError(null);
              if (!detail.run) {
                setError('Start the SOP run first');
                return;
              }
              start(async () => {
                const r = await completeStep({
                  firmSlug,
                  sopKey: detail.def.key,
                  runId: detail.run!.id,
                  stepNumber: activeStepNumber,
                  confirmations,
                  notes,
                });
                if (r.ok) {
                  if (r.nextStep) setActiveStepNumber(r.nextStep);
                  router.refresh();
                } else {
                  setError(r.error + (r.missingGates ? ` (${r.missingGates.join(', ')})` : ''));
                }
              });
            }}
          />
        )}
        {error && (
          <div className="rounded-xl border border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] p-3 text-sm text-[var(--rag-red)]">
            {error}
          </div>
        )}
        <TicketCountCard firmSlug={firmSlug} ticketCount={detail.ticketCount} />
      </main>
    </div>
  );
}

// ─── Run status card (top-left) ────────────────────────────────────────────

function RunStatusCard({
  detail,
  isExecutable,
  isPending,
  onStart,
  onPause,
  onResume,
}: {
  detail: SopRunDetail;
  isExecutable: boolean;
  isPending: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const status = detail.run?.status ?? 'not_started';
  const pctComplete = detail.run
    ? Math.round(
        ((detail.steps.filter((s) => s.status === 'completed').length) / detail.def.steps.length) *
          100,
      )
    : 0;

  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-white/40">
        Run status
      </div>
      <div className="text-sm font-semibold text-white">{statusLabel(status)}</div>
      {detail.run && (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full bg-[var(--accent)]"
              style={{ width: `${Math.max(pctComplete, 4)}%` }}
            />
          </div>
          <div className="mt-1.5 font-[family-name:var(--font-geist-mono)] text-[10px] text-white/55">
            {pctComplete}% · Step {detail.run.currentStep}/{detail.def.steps.length}
          </div>
        </>
      )}
      <div className="mt-3 flex flex-col gap-1.5">
        {!detail.run && isExecutable && (
          <button
            type="button"
            onClick={onStart}
            disabled={isPending}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {isPending ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} strokeWidth={2} />}
            Start SOP
          </button>
        )}
        {!detail.run && !isExecutable && (
          <div className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-white/55">
            Workflow body authored on Day 3. The definition is registered;
            execution lands after the Phase 1 work finalizes.
          </div>
        )}
        {detail.run?.status === 'in_progress' && (
          <button
            type="button"
            onClick={onPause}
            disabled={isPending}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/30 hover:text-white"
          >
            <PauseCircle size={12} strokeWidth={2} />
            Pause
          </button>
        )}
        {detail.run?.status === 'paused' && (
          <button
            type="button"
            onClick={onResume}
            disabled={isPending}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            <Play size={12} strokeWidth={2} />
            Resume
          </button>
        )}
      </div>
    </div>
  );
}

function statusLabel(s: string): string {
  return s
    .split('_')
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

// ─── Step rail (left column) ───────────────────────────────────────────────

function StepRail({
  steps,
  stepStates,
  activeStepNumber,
  currentStep,
  runStarted,
  onSelect,
}: {
  steps: SopStep[];
  stepStates: SopRunDetail['steps'];
  activeStepNumber: number;
  currentStep: number;
  runStarted: boolean;
  onSelect: (n: number) => void;
}) {
  return (
    <nav className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-2">
      <div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-white/40">
        Steps ({steps.length})
      </div>
      <ul className="flex flex-col gap-0.5">
        {steps.map((s) => {
          const state = stepStates.find((x) => x.number === s.number);
          const status = state?.status ?? 'not_started';
          const isActive = s.number === activeStepNumber;
          const isCurrent = runStarted && s.number === currentStep;
          const Icon =
            status === 'completed'
              ? CheckCircle2
              : status === 'in_progress'
                ? Clock
                : status === 'awaiting_input'
                  ? AlertCircle
                  : Circle;
          const iconColor =
            status === 'completed'
              ? 'text-[var(--rag-green)]'
              : status === 'in_progress'
                ? 'text-[var(--accent)]'
                : status === 'awaiting_input'
                  ? 'text-[var(--rag-yellow)]'
                  : 'text-white/30';
          return (
            <li key={s.number}>
              <button
                type="button"
                onClick={() => onSelect(s.number)}
                className={`flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${
                  isActive ? 'bg-white/10' : 'hover:bg-white/5'
                }`}
              >
                <Icon size={14} strokeWidth={2} className={`mt-0.5 shrink-0 ${iconColor}`} />
                <div className="min-w-0 flex-1">
                  <div
                    className={`flex items-center gap-1 text-[10px] font-medium uppercase tracking-widest ${
                      isCurrent ? 'text-[var(--accent)]' : 'text-white/40'
                    }`}
                  >
                    Step {s.number}
                    {isCurrent && <span className="text-[var(--accent)]">·</span>}
                    {isCurrent && <span className="lowercase tracking-normal">current</span>}
                  </div>
                  <div className={`mt-0.5 truncate text-sm ${isActive ? 'text-white' : 'text-white/65'}`}>
                    {s.title}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ─── Step detail (main panel) ──────────────────────────────────────────────

function StepDetail({
  firmSlug: _firmSlug,
  def,
  stepDef,
  stepState,
  canComplete,
  isPending,
  onComplete,
}: {
  firmSlug: string;
  def: SopRunDetail['def'];
  stepDef: SopStep;
  stepState: SopRunDetail['steps'][number] | undefined;
  canComplete: boolean;
  isPending: boolean;
  onComplete: (confirmations: Record<string, string | boolean>, notes?: string) => void;
}) {
  const [confirmations, setConfirmations] = useState<Record<string, string | boolean>>(() => {
    const init: Record<string, string | boolean> = {};
    for (const g of stepDef.gates) init[g.key] = false;
    return init;
  });
  const [notes, setNotes] = useState('');

  const requiredGates = stepDef.gates.filter((g) => g.required);
  const allRequiredSatisfied = requiredGates.every((g) => {
    const v = confirmations[g.key];
    if (g.kind === 'free_text') return typeof v === 'string' && v.trim().length > 0;
    return v === true;
  });

  const isStub = stepDef.process.length === 0;

  return (
    <article className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
      <header className="mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
          Step {stepDef.number} of {def.steps.length}
        </div>
        <h2 className="mt-1 font-[family-name:var(--font-jakarta)] text-xl font-bold text-white">
          {stepDef.title}
        </h2>
        <p className="mt-2 text-sm text-white/55">
          <span className="font-semibold text-white/70">Output:</span> {stepDef.output}
        </p>
      </header>

      {isStub ? (
        <div className="rounded-lg border border-white/10 bg-black/20 p-4 text-sm text-white/55">
          <div className="mb-1 flex items-center gap-1.5 font-semibold text-white/70">
            <HelpCircle size={14} strokeWidth={2} />
            Coming soon
          </div>
          This step is registered but its body is authored on Day 3 of the
          build. The data inputs, operator actions, gates, and generators
          for this step will appear here when complete.
        </div>
      ) : (
        <>
          {/* Process bullets */}
          <Section title="Process">
            <ol className="ml-5 list-decimal space-y-1.5 text-sm text-white/70">
              {stepDef.process.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ol>
          </Section>

          {/* Data inputs */}
          {stepDef.dataInputs.length > 0 && (
            <Section title="Auto-populated data">
              <ul className="flex flex-col gap-2">
                {stepDef.dataInputs.map((d) => (
                  <li
                    key={`${d.kind}_${d.label}`}
                    className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-white/10 px-1.5 py-0.5 font-[family-name:var(--font-geist-mono)] text-[10px] uppercase tracking-wider text-white/55">
                        {d.kind}
                      </span>
                      <span className={d.required ? 'text-white/80' : 'text-white/55'}>{d.label}</span>
                      {d.required && (
                        <span className="text-[10px] uppercase tracking-wider text-[var(--rag-red)]">
                          required
                        </span>
                      )}
                    </div>
                    {/* On Day 2 the per-kind data widget renders the live value here. */}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Operator actions */}
          {stepDef.operatorActions.length > 0 && (
            <Section title="Your job">
              <ul className="ml-5 list-disc space-y-1 text-sm text-white/70">
                {stepDef.operatorActions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </Section>
          )}

          {/* Gates */}
          {stepDef.gates.length > 0 && (
            <Section title="Before advancing — confirm">
              <ul className="flex flex-col gap-2">
                {stepDef.gates.map((g) => (
                  <GateRow
                    key={g.key}
                    gate={g}
                    value={confirmations[g.key] ?? false}
                    onChange={(v) => setConfirmations((cur) => ({ ...cur, [g.key]: v }))}
                  />
                ))}
              </ul>
            </Section>
          )}

          {/* Generators preview */}
          {stepDef.generates && (
            <Section title="What this step produces">
              <div className="flex flex-wrap gap-2">
                {stepDef.generates.deliverableKinds?.map((k) => (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-xs text-white/80"
                  >
                    <FileDown size={12} strokeWidth={2} />
                    {k}
                  </span>
                ))}
                {stepDef.generates.ticketsFromFactory && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-xs text-white/80">
                    <Sparkles size={12} strokeWidth={2} />
                    Ticket bundle: {stepDef.generates.ticketsFromFactory}
                  </span>
                )}
              </div>
            </Section>
          )}

          {/* Step output, if completed */}
          {stepState?.status === 'completed' && stepState.outputSummary && (
            <Section title="Output recorded">
              <pre className="overflow-x-auto rounded-lg border border-white/10 bg-black/30 p-3 font-[family-name:var(--font-geist-mono)] text-[11px] text-white/65">
                {JSON.stringify(stepState.outputSummary, null, 2)}
              </pre>
            </Section>
          )}

          {/* Complete step (only enabled when this is the current step + run is active) */}
          {canComplete && stepState?.status !== 'completed' && (
            <div className="mt-5 border-t border-white/10 pt-5">
              <Section title="Notes (optional)">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Anything you want to record for this step?"
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[var(--accent)] focus:outline-none"
                />
              </Section>
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => onComplete(confirmations, notes || undefined)}
                  disabled={isPending || !allRequiredSatisfied}
                  title={!allRequiredSatisfied ? 'Confirm all required gates above first' : undefined}
                  className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isPending ? <Loader2 size={14} className="animate-spin" /> : <ChevronRight size={14} strokeWidth={2} />}
                  Complete Step {stepDef.number}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-white/55">{title}</h3>
      {children}
    </section>
  );
}

function GateRow({
  gate,
  value,
  onChange,
}: {
  gate: SopGate;
  value: string | boolean;
  onChange: (v: string | boolean) => void;
}) {
  if (gate.kind === 'free_text') {
    return (
      <li className="rounded-lg border border-white/10 bg-black/20 p-3">
        <label className="block text-sm text-white/80">
          {gate.label}
          {gate.required && <span className="ml-1 text-[var(--rag-red)]">*</span>}
        </label>
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={gate.hint}
          className="mt-2 w-full rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white placeholder:text-white/30 focus:border-[var(--accent)] focus:outline-none"
        />
      </li>
    );
  }
  return (
    <li className="rounded-lg border border-white/10 bg-black/20 p-3">
      <label className="flex items-start gap-3 text-sm text-white/80">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1 h-4 w-4 accent-[var(--accent)]"
        />
        <span className="flex-1">
          {gate.label}
          {gate.required && <span className="ml-1 text-[var(--rag-red)]">*</span>}
          {gate.hint && <span className="mt-0.5 block text-[11px] text-white/40">{gate.hint}</span>}
        </span>
      </label>
    </li>
  );
}

// ─── Deliverables list (left rail bottom) ──────────────────────────────────

function DeliverableList({ deliverables }: { deliverables: SopRunDetail['deliverables'] }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-3">
      <div className="mb-2 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-widest text-white/55">
        <FileDown size={11} strokeWidth={2} />
        Deliverables
      </div>
      <ul className="flex flex-col gap-1.5">
        {deliverables.map((d) => (
          <li key={d.id} className="rounded-md border border-white/10 bg-black/20 px-2.5 py-1.5">
            <div className="truncate text-xs text-white/80" title={d.name}>
              {d.name}
            </div>
            <div className="font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40">
              {d.kind}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Ticket count card (footer of main panel) ──────────────────────────────

function TicketCountCard({ firmSlug, ticketCount }: { firmSlug: string; ticketCount: number }) {
  if (ticketCount === 0) return null;
  return (
    <a
      href={`/dashboard/${firmSlug}/tickets`}
      className="flex items-center justify-between rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-4 transition-colors hover:border-white/30"
    >
      <div className="flex items-center gap-2.5">
        <div className="rounded-full bg-[var(--accent)]/10 p-2">
          <Inbox size={14} strokeWidth={2} className="text-[var(--accent)]" />
        </div>
        <div>
          <div className="text-sm font-semibold text-white">
            {ticketCount} action item{ticketCount === 1 ? '' : 's'} from this SOP
          </div>
          <div className="text-xs text-white/55">View, assign, and triage in /tickets</div>
        </div>
      </div>
      <ChevronRight size={16} strokeWidth={2} className="text-white/40" />
    </a>
  );
}
