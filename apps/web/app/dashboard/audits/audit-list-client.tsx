'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
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

  // Poll for running audit status
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
    <div className="mt-6">
      <button
        onClick={handleStartAudit}
        disabled={isPending || !!runningId}
        className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
      >
        {isPending ? 'Starting...' : runningId ? 'Audit Running...' : 'Run New Audit'}
      </button>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      {runningId && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-blue-800 bg-blue-950/30 px-4 py-3">
          <div className="h-3 w-3 animate-pulse rounded-full bg-blue-500" />
          <span className="text-sm text-blue-300">
            Audit in progress... polling every 5s
          </span>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-2">
        {runs.length === 0 && !runningId && (
          <p className="text-sm text-neutral-600">No audits yet. Run your first one!</p>
        )}

        {runs.map((run) => (
          <Link
            key={run.id}
            href={`/dashboard/audits/${run.id}`}
            className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 transition hover:border-neutral-700"
          >
            <div className="flex items-center gap-3">
              <StatusBadge status={run.status} />
              <div>
                <span className="text-sm font-medium">{run.kind} audit</span>
                <span className="ml-3 text-xs text-neutral-500">
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
            <span className="text-xs text-neutral-600">{run.id.slice(0, 8)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    completed: 'bg-green-600',
    running: 'bg-blue-600 animate-pulse',
    failed: 'bg-red-600',
    pending: 'bg-neutral-600',
  };
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium text-white ${colors[status] ?? 'bg-neutral-600'}`}
    >
      {status}
    </span>
  );
}
