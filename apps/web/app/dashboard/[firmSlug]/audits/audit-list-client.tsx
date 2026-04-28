'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { BarChart3, AlertCircle } from 'lucide-react';
import { startAudit, getAuditRunStatus, cancelAudit } from '../../../actions/audit-actions';
import type { FirmBudgetStatus } from '../../../lib/audit/budget';

type Run = {
  id: string;
  status: string;
  kind: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
};

export function AuditListClient({
  firmSlug,
  initialRuns,
  // `budget` is fetched server-side in page.tsx so the panel renders with
  // the same data the server-side gate in startAudit uses. `null` means
  // the fetch failed at SSR time — we fall back to rendering without the
  // panel rather than blocking the whole audit surface on a budget query.
  budget,
}: {
  firmSlug: string;
  initialRuns: Run[];
  budget: FirmBudgetStatus | null;
}) {
  const [runs, setRuns] = useState(initialRuns);
  const [isPending, startTransition] = useTransition();
  const [runningId, setRunningId] = useState<string | null>(null);
  // Live-progress snapshot from the poll loop so the running banner can
  // render real motion ("12 queries · $0.48 spent") rather than a timeless
  // spinner. Reset to null when runningId clears.
  const [progress, setProgress] = useState<{
    queriesCompleted: number;
    spentUsd: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!runningId) {
      setProgress(null);
      return;
    }
    const interval = setInterval(async () => {
      const status = await getAuditRunStatus(runningId);
      // Capture progress every tick so the banner updates in flight.
      setProgress({
        queriesCompleted: status.queriesCompleted,
        spentUsd: status.spentUsd,
      });
      if (status.status !== 'running') {
        setRunningId(null);
        setProgress(null);
        router.refresh();
        clearInterval(interval);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [runningId, router]);

  const handleStartAudit = () => {
    setError(null);
    startTransition(async () => {
      const result = await startAudit(firmSlug);
      if ('error' in result) {
        setError(result.error);
      } else {
        setRunningId(result.auditRunId);
        router.refresh();
      }
    });
  };

  // Cancel the in-flight audit. The server action flips audit_run.status
  // to 'cancelled' immediately (atomic UPDATE gated on status='running');
  // the run-audit loop picks that up at the top of the next iteration
  // and exits without writing a completion row. Latency: bounded by one
  // query's duration, because we let the current iteration finish rather
  // than interrupt a live provider call mid-flight.
  const [cancelPending, setCancelPending] = useState(false);
  const handleCancelAudit = async () => {
    if (!runningId || cancelPending) return;
    setCancelPending(true);
    setError(null);
    try {
      const result = await cancelAudit(runningId);
      if (!result.ok) {
        if (result.reason === 'not_running') {
          // Race: run finished before we could cancel it. Harmless — the
          // poll loop will pick up the terminal status next tick. Don't
          // show an error; just let the natural flow play out.
        } else {
          setError(result.message ?? 'Could not cancel audit');
        }
      }
      router.refresh();
    } finally {
      setCancelPending(false);
    }
  };

  // Pre-emptively disable the button when the server-side pre-flight gate
  // in startAudit would refuse it. We duplicate the check client-side so
  // the UI state matches reality without a round trip — the server-side
  // gate (batch 15) is still authoritative; this is just UX polish.
  const overBudget = budget?.overBudget ?? false;
  const disabled = isPending || !!runningId || overBudget;

  return (
    <div>
      {budget && <BudgetPanel budget={budget} firmSlug={firmSlug} />}

      <button
        onClick={handleStartAudit}
        disabled={disabled}
        title={overBudget ? 'Monthly budget cap reached — adjust in Settings to run another audit.' : undefined}
        className="rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? 'Starting...' : runningId ? 'Audit Running...' : overBudget ? 'Over Budget' : 'Run New Audit'}
      </button>

      {error && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/15 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {runningId && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="h-3 w-3 animate-pulse rounded-full bg-[var(--accent)]" />
            <span className="text-sm text-[var(--accent)]">
              Audit in progress
              {progress && progress.queriesCompleted > 0 && (
                <>
                  {' · '}
                  <span className="font-[family-name:var(--font-geist-mono)]">
                    {progress.queriesCompleted} {progress.queriesCompleted === 1 ? 'query' : 'queries'}
                  </span>
                  {progress.spentUsd > 0 && (
                    <>
                      {' · '}
                      <span className="font-[family-name:var(--font-geist-mono)]">
                        ${progress.spentUsd.toFixed(2)} spent
                      </span>
                    </>
                  )}
                </>
              )}
              <span className="ml-2 text-[var(--accent)]/70">polling every 5s</span>
            </span>
          </div>
          <button
            type="button"
            onClick={handleCancelAudit}
            disabled={cancelPending}
            title="Stop the audit at the end of the current query. Already-scored queries are kept."
            className="rounded-full border border-red-500/30 px-3 py-1 text-xs font-medium uppercase tracking-wider text-red-400 transition-colors hover:border-red-500/60 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelPending ? 'Cancelling...' : 'Cancel'}
          </button>
        </div>
      )}

      <div className="mt-8 flex flex-col gap-2">
        {runs.length === 0 && !runningId && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <BarChart3 className="mb-4 h-12 w-12 text-white/20" strokeWidth={1.5} />
            <h3 className="mb-2 text-lg font-semibold text-white/60">No audits yet</h3>
            <p className="mb-6 max-w-md text-sm text-white/40">
              Run your first Trust Alignment Audit to see how AI models describe your brand.
            </p>
          </div>
        )}

        {runs.map((run) => (
          <Link
            key={run.id}
            href={`/dashboard/${firmSlug}/audits/${run.id}`}
            className="flex items-center justify-between rounded-xl border border-white/10 bg-[var(--bg-secondary)] px-5 py-4 transition-colors hover:border-white/20"
          >
            <div className="flex items-center gap-3">
              <StatusBadge status={run.status} />
              <div>
                <span className="text-sm font-medium text-white">{run.kind} audit</span>
                <span
                  className="ml-3 font-[family-name:var(--font-geist-mono)] text-xs text-white/40"
                  suppressHydrationWarning
                >
                  {run.startedAt
                    ? new Date(run.startedAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : 'pending'}
                </span>
              </div>
            </div>
            <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/30">{run.id.slice(0, 8)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: 'bg-[var(--rag-green-bg)] text-[var(--rag-green)]',
    completed_budget_truncated: 'bg-amber-500/15 text-amber-300',
    running: 'bg-[var(--accent)]/15 text-[var(--accent)] animate-pulse',
    failed: 'bg-[var(--rag-red-bg)] text-[var(--rag-red)]',
    cancelled: 'bg-white/10 text-white/60',
    pending: 'bg-white/10 text-white/55',
  };
  // The DB stores snake_case status strings; render with spaces for UX.
  const label = status.replaceAll('_', ' ');
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wider ${styles[status] ?? 'bg-white/10 text-white/55'}`}>
      {label}
    </span>
  );
}

/**
 * Compact spend-vs-cap panel rendered above the Run Audit button. Same
 * data the server-side pre-flight gate uses (getFirmBudgetStatus), so
 * the visible state and the accept/refuse decision never disagree.
 *
 * Three visual states keyed off booleans from FirmBudgetStatus:
 *   - overBudget   → red border + red bar + inline explanation
 *   - nearCap      → amber border + amber bar + soft warning
 *   - otherwise    → neutral border + accent bar
 *
 * `source='default'` means the firm is using the env-default cap — we
 * surface that so operators know it hasn't been configured yet.
 */
function BudgetPanel({
  budget,
  firmSlug,
}: {
  budget: FirmBudgetStatus;
  firmSlug: string;
}) {
  const pct = budget.monthlyCapUsd > 0
    ? Math.min(100, (budget.spentThisMonthUsd / budget.monthlyCapUsd) * 100)
    : 0;

  const tone: 'red' | 'amber' | 'neutral' = budget.overBudget
    ? 'red'
    : budget.nearCap
      ? 'amber'
      : 'neutral';

  const containerClass =
    tone === 'red'
      ? 'border-red-500/30 bg-red-500/5'
      : tone === 'amber'
        ? 'border-amber-500/30 bg-amber-500/5'
        : 'border-white/10 bg-[var(--bg-secondary)]';

  const barClass =
    tone === 'red'
      ? 'bg-red-500'
      : tone === 'amber'
        ? 'bg-amber-400'
        : 'bg-[var(--accent)]';

  const labelToneClass =
    tone === 'red'
      ? 'text-red-400'
      : tone === 'amber'
        ? 'text-amber-300'
        : 'text-white/55';

  return (
    <div className={`mb-4 rounded-xl border p-4 ${containerClass}`}>
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          {tone !== 'neutral' && (
            <AlertCircle
              size={14}
              strokeWidth={2}
              className={tone === 'red' ? 'text-red-400' : 'text-amber-300'}
            />
          )}
          <span className={`font-medium uppercase tracking-widest ${labelToneClass}`}>
            Monthly LLM Budget
          </span>
          {budget.source === 'default' && (
            <span
              className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/40"
              title="Using the workspace default cap — set a per-firm cap in Settings to override."
            >
              default
            </span>
          )}
        </div>
        <span className="font-[family-name:var(--font-geist-mono)] text-white/70">
          ${budget.spentThisMonthUsd.toFixed(2)} / ${budget.monthlyCapUsd.toFixed(2)}
        </span>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
        <div className={`h-full ${barClass}`} style={{ width: `${pct}%` }} />
      </div>

      {tone !== 'neutral' && (
        <p className={`mt-2 text-xs ${tone === 'red' ? 'text-red-400' : 'text-amber-300'}`}>
          {tone === 'red'
            ? 'Cap reached — new audits are blocked until next month or the cap is raised.'
            : `Within 10% of cap — ${budget.remainingUsd.toFixed(2)} USD remaining this month.`}{' '}
          <Link href={`/dashboard/${firmSlug}/settings`} className="underline hover:no-underline">
            Adjust in Settings
          </Link>
          .
        </p>
      )}
    </div>
  );
}
