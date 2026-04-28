'use client';

import { useState, useTransition, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  FileText,
  FileX,
  Wand2,
} from 'lucide-react';
import {
  startSuppressionScan,
  getSuppressionScanStatus,
  type SuppressionFindingRow,
  type SuppressionSummary,
} from '../../../actions/suppression-actions';

type LatestRun = {
  id: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
} | null;

export function SuppressionClient({
  firmSlug,
  initialFindings,
  initialLatestRun,
  initialSummary,
}: {
  firmSlug: string;
  initialFindings: SuppressionFindingRow[];
  initialLatestRun: LatestRun;
  initialSummary: SuppressionSummary;
}) {
  const [isPending, startTransition] = useTransition();
  const [runningId, setRunningId] = useState<string | null>(
    initialLatestRun?.status === 'running' ? initialLatestRun.id : null,
  );
  const [error, setError] = useState<string | null>(initialLatestRun?.error ?? null);
  const router = useRouter();

  // Poll status while a scan is running. Suppression scans take 1-5 minutes
  // on a ~75-page site — slower than audits but well under the Fluid Compute
  // 300s wall-clock ceiling.
  useEffect(() => {
    if (!runningId) return;
    const interval = setInterval(async () => {
      const status = await getSuppressionScanStatus(runningId);
      if (status.status !== 'running') {
        setRunningId(null);
        if (status.error) setError(status.error);
        router.refresh();
        clearInterval(interval);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [runningId, router]);

  const handleStartScan = () => {
    setError(null);
    startTransition(async () => {
      const result = await startSuppressionScan(firmSlug);
      if ('error' in result) {
        setError(result.error);
      } else {
        setRunningId(result.runId);
        router.refresh();
      }
    });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={handleStartScan}
          disabled={isPending || !!runningId}
          className="rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {isPending
            ? 'Starting...'
            : runningId
            ? 'Scan Running...'
            : 'Run Suppression Scan'}
        </button>
        {initialLatestRun?.finishedAt && (
          <span
            className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40"
            suppressHydrationWarning
          >
            Last scanned {new Date(initialLatestRun.finishedAt).toLocaleString()}
          </span>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/15 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {runningId && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-3">
          <div className="h-3 w-3 animate-pulse rounded-full bg-[var(--accent)]" />
          <span className="text-sm text-[var(--accent)]">
            Crawling sitemap + embedding pages... polling every 5s
          </span>
        </div>
      )}

      {/* Summary tiles */}
      {initialSummary.totalPages > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="Pages Scanned"
            value={initialSummary.totalPages}
            tone="gray"
          />
          <StatCard
            label="Aligned"
            value={initialSummary.alignedCount}
            tone="green"
          />
          <StatCard
            label="Rewrite"
            value={initialSummary.rewriteCount}
            tone="yellow"
          />
          <StatCard
            label="Noindex"
            value={initialSummary.noindexCount}
            tone="red"
          />
        </div>
      )}

      {/* Findings table */}
      <div className="mt-8 flex flex-col gap-2">
        {initialFindings.length === 0 && !runningId && initialSummary.totalPages === 0 && (
          <EmptyState onStart={handleStartScan} disabled={isPending || !!runningId} />
        )}

        {initialFindings.length === 0 &&
          !runningId &&
          initialSummary.totalPages > 0 && <AllAligned count={initialSummary.totalPages} />}

        {initialFindings.map((f) => (
          <FindingRow key={f.findingId} firmSlug={firmSlug} finding={f} />
        ))}
      </div>
    </div>
  );
}

function FindingRow({
  firmSlug,
  finding,
}: {
  firmSlug: string;
  finding: SuppressionFindingRow;
}) {
  // Whole row links to the detail page. The external-page link uses
  // stopPropagation so clicking it opens the live page without also
  // navigating into the detail view.
  return (
    <Link
      href={`/dashboard/${firmSlug}/suppression/${finding.findingId}`}
      className="group flex items-start justify-between gap-4 rounded-xl border border-white/10 bg-[var(--bg-secondary)] px-5 py-4 transition-colors hover:border-[var(--accent)]/30"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <ActionBadge action={finding.action} />
          <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/55">
            d = {finding.semanticDistance.toFixed(3)}
          </span>
          {finding.wordCount !== null && (
            <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
              {finding.wordCount} words
            </span>
          )}
          {finding.ticketDueAt && (
            <span
              className="font-[family-name:var(--font-geist-mono)] text-xs text-white/30"
              suppressHydrationWarning
            >
              Due {new Date(finding.ticketDueAt).toLocaleDateString()}
            </span>
          )}
          {finding.ticketStatus && finding.ticketStatus !== 'open' && (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/55">
              {finding.ticketStatus}
            </span>
          )}
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="break-all text-sm font-medium text-white/90 group-hover:text-white">
            {finding.title ?? finding.url}
          </span>
          <a
            href={finding.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-white/70"
          >
            open page
            <ExternalLink size={10} strokeWidth={1.5} />
          </a>
        </div>
        {finding.rationale && (
          <p className="mt-1 line-clamp-2 text-xs text-white/55">{finding.rationale}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-2 pt-1 text-[var(--accent)]/70 group-hover:text-[var(--accent)]">
        {finding.action === 'rewrite' ? (
          <Wand2 size={14} strokeWidth={1.5} />
        ) : null}
        <ArrowRight size={16} strokeWidth={1.5} />
      </div>
    </Link>
  );
}

function ActionBadge({ action }: { action: string }) {
  const styles: Record<string, string> = {
    noindex: 'bg-[var(--rag-red-bg)] text-[var(--rag-red)]',
    redirect: 'bg-[var(--rag-red-bg)] text-[var(--rag-red)]',
    rewrite: 'bg-[var(--rag-yellow-bg)] text-[var(--rag-yellow)]',
  };
  return (
    <span
      className={`rounded-full px-3 py-1 text-[10px] font-medium uppercase tracking-wider ${
        styles[action] ?? 'bg-white/10 text-white/55'
      }`}
    >
      {action}
    </span>
  );
}

function EmptyState({ onStart, disabled }: { onStart: () => void; disabled: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <FileText className="mb-4 h-12 w-12 text-white/20" strokeWidth={1.5} />
      <h3 className="mb-2 text-lg font-semibold text-white/60">No scan yet</h3>
      <p className="mb-6 max-w-md text-sm text-white/40">
        Run a suppression scan to crawl your sitemap and flag pages that have
        drifted from your Brand Truth. Each flagged page becomes a remediation
        ticket — noindex for the worst drift, rewrite for borderline cases.
      </p>
      <button
        onClick={onStart}
        disabled={disabled}
        className="rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
      >
        Run First Scan
      </button>
    </div>
  );
}

function AllAligned({ count }: { count: number }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <CheckCircle2 className="mb-4 h-12 w-12 text-[var(--rag-green)]" strokeWidth={1.5} />
      <h3 className="mb-2 text-lg font-semibold text-white/70">All pages aligned</h3>
      <p className="max-w-md text-sm text-white/40">
        The latest scan found no pages drifting from your Brand Truth across{' '}
        {count} scanned {count === 1 ? 'page' : 'pages'}. Re-run after major
        site changes to keep this current.
      </p>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'green' | 'red' | 'yellow' | 'gray';
}) {
  const color =
    tone === 'green'
      ? 'text-[var(--rag-green)]'
      : tone === 'red'
      ? 'text-[var(--rag-red)]'
      : tone === 'yellow'
      ? 'text-[var(--rag-yellow)]'
      : 'text-white/60';
  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] px-4 py-3">
      <div className="flex items-center gap-2">
        {tone === 'red' && <FileX size={14} className="text-[var(--rag-red)]" strokeWidth={1.5} />}
        {tone === 'gray' && <FileText size={14} className="text-white/40" strokeWidth={1.5} />}
        <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      </div>
      <div className={`mt-1 font-[family-name:var(--font-jakarta)] text-2xl font-bold ${color}`}>
        {value}
      </div>
    </div>
  );
}
