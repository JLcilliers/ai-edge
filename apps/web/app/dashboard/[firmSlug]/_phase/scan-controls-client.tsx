'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Loader2, RefreshCw } from 'lucide-react';

/**
 * The "Run scan" strip at the top of each phase page.
 *
 * Phase 1 wires through to the existing scanner triggers (audit,
 * suppression, entity, AIO). Phases 2-7 disable the button with a
 * "Scanner wiring lands in the next iteration" hint until the
 * underlying scanner is implemented — no fake progress, no placeholder
 * spinner.
 */
export function ScanControlsClient({
  firmSlug,
  phaseKey,
  lastScan,
}: {
  firmSlug: string;
  phaseKey: string;
  lastScan: {
    completedAt: string | null;
    runsByKey: Array<{
      sopKey: string;
      sopName: string;
      status: string;
      currentStep: number;
      totalSteps: number;
    }>;
  };
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();

  // Map phaseKey → which scanner route to invoke. Phase 1 reuses the
  // existing audit + suppression + entity triggers. As we wire scanners
  // for the other phases, add their endpoints here.
  const scannerHref: Record<string, string | null> = {
    'brand-audit-analysis': `/dashboard/${firmSlug}/audits`,
    'measurement-monitoring': null,
    'content-optimization': null,
    'third-party-optimization': `/dashboard/${firmSlug}/entity`,
    'technical-implementation': `/dashboard/${firmSlug}/entity`,
    'content-generation': null,
    'client-services': `/dashboard/${firmSlug}/reports`,
  };
  const scannerHrefForPhase = scannerHref[phaseKey] ?? null;

  const handleRunScan = () => {
    if (!scannerHrefForPhase) return;
    start(() => {
      // Route to the underlying scanner UI. Once scanner triggers are
      // fully wired as a single phase-level action, this gets replaced
      // by a direct server-action call.
      router.push(scannerHrefForPhase);
    });
  };

  const formatRelative = (iso: string | null): string => {
    if (!iso) return 'never';
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.floor(ms / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hr${hr === 1 ? '' : 's'} ago`;
    const day = Math.floor(hr / 24);
    return `${day} day${day === 1 ? '' : 's'} ago`;
  };

  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Activity size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
              Scan status
            </div>
            <div className="mt-0.5 text-sm font-semibold text-white">
              Last scan: {formatRelative(lastScan.completedAt)}
            </div>
          </div>
        </div>
        {scannerHrefForPhase ? (
          <button
            type="button"
            onClick={handleRunScan}
            disabled={isPending}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} strokeWidth={2} />}
            Run scan
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/55">
            Scanner wiring in progress
          </span>
        )}
      </div>

      {lastScan.runsByKey.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {lastScan.runsByKey.map((r) => (
            <ScannerStatusPill key={r.sopKey} run={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function ScannerStatusPill({
  run,
}: {
  run: {
    sopKey: string;
    sopName: string;
    status: string;
    currentStep: number;
    totalSteps: number;
  };
}) {
  const toneClass =
    run.status === 'completed'
      ? 'border-[var(--rag-green)]/30 bg-[var(--rag-green-bg)] text-[var(--rag-green)]'
      : run.status === 'in_progress' || run.status === 'awaiting_input'
        ? 'border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--accent)]'
        : run.status === 'failed' || run.status === 'cancelled'
          ? 'border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] text-[var(--rag-red)]'
          : 'border-white/15 bg-white/5 text-white/55';
  return (
    <div className={`rounded-md border px-3 py-2 ${toneClass}`}>
      <div className="text-[10px] font-semibold uppercase tracking-widest opacity-70">
        {run.status.replace('_', ' ')}
      </div>
      <div className="mt-0.5 truncate text-xs font-medium">{run.sopName}</div>
      {run.totalSteps > 0 && (
        <div className="mt-1 font-[family-name:var(--font-geist-mono)] text-[10px] opacity-70">
          Step {run.currentStep}/{run.totalSteps}
        </div>
      )}
    </div>
  );
}
