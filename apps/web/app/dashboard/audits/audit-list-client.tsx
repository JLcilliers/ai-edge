'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { BarChart3 } from 'lucide-react';
import { startAudit, getAuditRunStatus } from '../../actions/audit-actions';

type Run = {
  id: string;
  status: string;
  kind: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
};

export function AuditListClient({ initialRuns }: { initialRuns: Run[] }) {
  const [runs, setRuns] = useState(initialRuns);
  const [isPending, startTransition] = useTransition();
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!runningId) return;
    const interval = setInterval(async () => {
      const status = await getAuditRunStatus(runningId);
      if (status.status !== 'running') {
        setRunningId(null);
        router.refresh();
        clearInterval(interval);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [runningId, router]);

  const handleStartAudit = () => {
    setError(null);
    startTransition(async () => {
      const result = await startAudit();
      if ('error' in result) {
        setError(result.error);
      } else {
        setRunningId(result.auditRunId);
        router.refresh();
      }
    });
  };

  return (
    <div>
      <button
        onClick={handleStartAudit}
        disabled={isPending || !!runningId}
        className="rounded-full bg-[--accent] px-6 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[--accent-hover] disabled:opacity-50"
      >
        {isPending ? 'Starting...' : runningId ? 'Audit Running...' : 'Run New Audit'}
      </button>

      {error && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/15 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {runningId && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-[--accent]/30 bg-[--accent]/10 px-4 py-3">
          <div className="h-3 w-3 animate-pulse rounded-full bg-[--accent]" />
          <span className="text-sm text-[--accent]">Audit in progress... polling every 5s</span>
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
            href={`/dashboard/audits/${run.id}`}
            className="flex items-center justify-between rounded-xl border border-white/10 bg-[--bg-secondary] px-5 py-4 transition-colors hover:border-white/20"
          >
            <div className="flex items-center gap-3">
              <StatusBadge status={run.status} />
              <div>
                <span className="text-sm font-medium text-white">{run.kind} audit</span>
                <span className="ml-3 font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
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
    completed: 'bg-[--rag-green-bg] text-[--rag-green]',
    running: 'bg-[--accent]/15 text-[--accent] animate-pulse',
    failed: 'bg-[--rag-red-bg] text-[--rag-red]',
    pending: 'bg-white/10 text-white/55',
  };
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wider ${styles[status] ?? 'bg-white/10 text-white/55'}`}>
      {status}
    </span>
  );
}
