import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2,
  Circle,
  Clock,
  AlertCircle,
  ArrowRight,
  Workflow,
  ChevronRight,
} from 'lucide-react';
import {
  listSopRunsForFirm,
  getPhaseGridSummary,
  type SopRunSummary,
} from '../../../actions/sop-actions';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { PHASES, SOP_REGISTRY } from '../../../lib/sop/registry';
import { ensurePhaseOneSopRunsBySlug } from '../../../lib/sop/auto-start';

export const dynamic = 'force-dynamic';

/**
 * Phase grid — the primary SOP entry point.
 *
 * Top-of-page: 7 phase cards with rollup counts.
 * Below: every SOP rendered in its phase row with status pill, progress
 * bar, and ticket/deliverable counts. SOPs with empty step bodies
 * (Phases 2-7 until Day 3) render with a "Coming Soon" pill so the
 * operator can see the full surface without being able to start an
 * empty SOP.
 */
export default async function SopsPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  // Idempotent: on first visit, create Phase 1 SOP runs anchored to
  // existing scanner data (audit_run, legacy_findings, brand_truth).
  // Subsequent visits no-op. Non-blocking failures don't break the page.
  await ensurePhaseOneSopRunsBySlug(firmSlug).catch(() => { /* swallow */ });

  const [runs, summaries] = await Promise.all([
    listSopRunsForFirm(firmSlug).catch(() => [] as SopRunSummary[]),
    getPhaseGridSummary(firmSlug).catch(() => []),
  ]);

  const runsByKey = new Map(runs.map((r) => [r.sopKey, r]));

  return (
    <div>
      <div className="mb-8 flex items-start gap-3">
        <div className="rounded-xl bg-[var(--accent)]/10 p-2">
          <Workflow size={24} strokeWidth={1.5} className="text-[var(--accent)]" />
        </div>
        <div>
          <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
            Standard Operating Procedures
          </h1>
          <p className="mt-2 text-white/55">
            24 SOPs across 7 phases — the Steve Toth AEO Coaching playbook.
            Each SOP is a workflow that turns scanner findings into
            assignable, validated, deliverable work.
          </p>
        </div>
      </div>

      {/* Phase rollup strip */}
      <div className="mb-8 grid gap-3 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-7">
        {summaries.map((s) => {
          const pct = s.total === 0 ? 0 : Math.round((s.completed / s.total) * 100);
          return (
            <div
              key={s.phase}
              className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-4"
            >
              <div className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
                Phase {s.phase}
              </div>
              <div className="mt-1 truncate text-sm font-semibold text-white" title={s.name}>
                {s.name}
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full bg-[var(--rag-green)]"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-2 font-[family-name:var(--font-geist-mono)] text-[10px] text-white/55">
                {s.completed}/{s.total} done · {s.inProgress} active
              </div>
            </div>
          );
        })}
      </div>

      {/* Per-phase SOP lists */}
      <div className="flex flex-col gap-6">
        {PHASES.map((phase) => (
          <PhaseSection
            key={phase.phase}
            firmSlug={firmSlug}
            phaseNumber={phase.phase}
            phaseName={phase.name}
            description={phase.description}
            sops={phase.sopKeys.map((k) => {
              const def = SOP_REGISTRY[k];
              const run = runsByKey.get(k);
              return { def, run };
            })}
          />
        ))}
      </div>
    </div>
  );
}

function PhaseSection({
  firmSlug,
  phaseNumber,
  phaseName,
  description,
  sops,
}: {
  firmSlug: string;
  phaseNumber: number;
  phaseName: string;
  description: string;
  sops: Array<{ def: ReturnType<typeof getDef>; run: SopRunSummary | undefined }>;
}) {
  return (
    <section className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 font-[family-name:var(--font-geist-mono)] text-[10px] font-semibold uppercase tracking-widest text-white/70">
              Phase {phaseNumber}
            </span>
            <h2 className="font-[family-name:var(--font-jakarta)] text-lg font-bold text-white">
              {phaseName}
            </h2>
          </div>
          <p className="mt-1 text-sm text-white/55">{description}</p>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
        {sops.map(({ def, run }) => (
          <SopCard key={def.key} firmSlug={firmSlug} def={def} run={run} />
        ))}
      </div>
    </section>
  );
}

// helper so the type inferred above is correct
function getDef(): (typeof SOP_REGISTRY)[keyof typeof SOP_REGISTRY] {
  // unused at runtime — just for type inference
  throw new Error('compile-only');
}

function SopCard({
  firmSlug,
  def,
  run,
}: {
  firmSlug: string;
  def: (typeof SOP_REGISTRY)[keyof typeof SOP_REGISTRY];
  run: SopRunSummary | undefined;
}) {
  const status = run?.status ?? 'not_started';
  const pct = run ? Math.round(((run.currentStep - (status === 'completed' ? 0 : 1)) / run.totalSteps) * 100) : 0;
  const isExecutable = run?.isExecutable ?? false;
  return (
    <Link
      href={`/dashboard/${firmSlug}/sop/${def.key}`}
      className="group flex flex-col gap-2 rounded-lg border border-white/10 bg-black/20 p-4 transition-colors hover:border-white/30 hover:bg-black/30"
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
