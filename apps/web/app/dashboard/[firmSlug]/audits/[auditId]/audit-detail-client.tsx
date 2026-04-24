'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, ChevronDown, GitCompare, AlertTriangle } from 'lucide-react';

type Result = {
  queryText: string;
  provider: string;
  model: string;
  mentioned: boolean;
  toneScore: number | null;
  ragLabel: string;
  gapReasons: string[];
  factualErrors: string[];
  citationUrls: string[];
  responsePreview: string;
  fullResponse: string;
  // Self-consistency: k samples per (query, provider), variance = fraction
  // of samples whose `mentioned` vote disagreed with the majority.
  // Surfaced only when k > 1 so legacy k=1 rows stay visually unchanged.
  k: number;
  variance: number;
};

type Detail = {
  run: {
    id: string;
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
  };
  results: Result[];
  summary: { red: number; yellow: number; green: number };
};

const RAG_BADGE: Record<string, string> = {
  red: 'bg-[--rag-red-bg] text-[--rag-red]',
  yellow: 'bg-[--rag-yellow-bg] text-[--rag-yellow]',
  green: 'bg-[--rag-green-bg] text-[--rag-green]',
};

export function AuditDetailClient({
  firmSlug,
  detail,
  auditId,
}: {
  firmSlug: string;
  detail: Detail;
  auditId: string;
}) {
  const { run, results, summary } = detail;
  const [filter, setFilter] = useState<'all' | 'red' | 'yellow' | 'green'>('all');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const filtered = filter === 'all' ? results : results.filter((r) => r.ragLabel === filter);
  const total = summary.red + summary.yellow + summary.green;

  // CSV download is a plain GET against the public-shape /api route —
  // no client-side conversion, Content-Disposition triggers the
  // browser's native save dialog, and operators can share the URL.
  const csvHref = `/api/audits/${auditId}/export.csv`;

  const dateStr = run.startedAt ? new Date(run.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const durationSec = run.finishedAt && run.startedAt
    ? Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
    : null;

  return (
    <div>
      {/* Back + header */}
      <Link href={`/dashboard/${firmSlug}/audits`} className="mb-4 inline-flex items-center gap-1.5 text-xs text-white/40 transition hover:text-white/70">
        <ArrowLeft size={14} /> Back to audits
      </Link>

      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
            Audit Results — {dateStr}
          </h1>
          <p className="mt-2 text-white/55">
            Red = missing or wrong. Yellow = mentioned but off-brand. Green = on-brand.
          </p>
          <div className="mt-2 flex gap-4 font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
            <span>{run.status}</span>
            {durationSec !== null && <span>{durationSec}s</span>}
            <span>{total} results</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/dashboard/${firmSlug}/audits/${auditId}/diff`}
            className="flex items-center gap-2 rounded-full border border-white/10 bg-transparent px-5 py-2.5 text-sm text-white transition-colors hover:border-[--accent]"
          >
            <GitCompare size={16} strokeWidth={1.5} />
            Compare to previous
          </Link>
          <a
            href={csvHref}
            className="flex items-center gap-2 rounded-full border border-white/10 bg-transparent px-5 py-2.5 text-sm text-white transition-colors hover:border-[--accent]"
          >
            <Download size={16} strokeWidth={1.5} />
            Export CSV
          </a>
        </div>
      </div>

      {/* RAG summary stats */}
      <div className="mb-6 grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-6">
          <span className="text-xs font-medium uppercase tracking-widest text-white/55">Red</span>
          <p className="mt-1 font-[family-name:var(--font-geist-mono)] text-3xl font-bold tracking-tight text-[--rag-red]">{summary.red}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-6">
          <span className="text-xs font-medium uppercase tracking-widest text-white/55">Yellow</span>
          <p className="mt-1 font-[family-name:var(--font-geist-mono)] text-3xl font-bold tracking-tight text-[--rag-yellow]">{summary.yellow}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-6">
          <span className="text-xs font-medium uppercase tracking-widest text-white/55">Green</span>
          <p className="mt-1 font-[family-name:var(--font-geist-mono)] text-3xl font-bold tracking-tight text-[--rag-green]">{summary.green}</p>
        </div>
      </div>

      {/* RAG distribution bar */}
      {total > 0 && (
        <div className="mb-8 flex h-3 overflow-hidden rounded-full bg-white/5">
          {summary.red > 0 && <div className="bg-[--rag-red]" style={{ width: `${(summary.red / total) * 100}%` }} />}
          {summary.yellow > 0 && <div className="bg-[--rag-yellow]" style={{ width: `${(summary.yellow / total) * 100}%` }} />}
          {summary.green > 0 && <div className="bg-[--rag-green]" style={{ width: `${(summary.green / total) * 100}%` }} />}
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 flex gap-2">
        {(['all', 'red', 'yellow', 'green'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-4 py-1.5 text-xs font-medium uppercase tracking-wider transition-colors ${
              filter === f
                ? 'bg-white/10 text-white'
                : 'text-white/40 hover:text-white/70'
            }`}
          >
            {f === 'all' ? `All (${total})` : `${f} (${summary[f]})`}
          </button>
        ))}
      </div>

      {/* Results */}
      <div className="overflow-hidden rounded-xl border border-white/10 bg-[--bg-secondary]">
        {/* Table header */}
        <div className="flex items-center gap-4 bg-[--bg-tertiary] px-5 py-3 text-xs font-medium uppercase tracking-widest text-white/55">
          <span className="w-16">Label</span>
          <span className="flex-1">Query</span>
          <span className="w-24">Provider</span>
          <span className="w-20 text-right">Score</span>
          <span className="w-8" />
        </div>

        {filtered.length === 0 && (
          <p className="py-12 text-center text-sm text-white/30">No results for this filter.</p>
        )}

        {filtered.map((r, i) => {
          // Variance > 0 at k=3 means at least one sample disagreed with
          // the majority `mentioned` vote — a reliability warning the
          // operator wants to see before trusting the row.
          const showVariance = r.k > 1;
          const variancePct = Math.round(r.variance * 100);
          const hasDissent = showVariance && r.variance > 0;
          return (
          <div key={i} className="border-t border-white/5">
            <button
              type="button"
              onClick={() => setExpandedRow(expandedRow === i ? null : i)}
              className="flex w-full items-center gap-4 px-5 py-3.5 text-left text-sm transition-colors hover:bg-white/[0.02]"
            >
              <span className={`w-16 rounded-full px-3 py-1 text-center text-xs font-medium uppercase tracking-wider ${RAG_BADGE[r.ragLabel] ?? 'bg-white/10 text-white/55'}`}>
                {r.ragLabel}
              </span>
              <span className="flex-1 truncate text-white/80">
                {r.queryText}
                {hasDissent && (
                  <span
                    className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wider text-amber-300"
                    title={`Provider samples disagreed — ${variancePct}% variance across k=${r.k} samples`}
                  >
                    <AlertTriangle size={10} strokeWidth={2} />
                    {variancePct}%
                  </span>
                )}
              </span>
              <span className="w-24 font-[family-name:var(--font-geist-mono)] text-xs text-white/40">{r.provider}</span>
              <span className="w-20 text-right font-[family-name:var(--font-geist-mono)] text-sm text-white/60">
                {r.toneScore !== null ? `${r.toneScore}/10` : '—'}
              </span>
              <ChevronDown size={16} className={`text-white/30 transition-transform ${expandedRow === i ? 'rotate-180' : ''}`} />
            </button>

            {expandedRow === i && (
              <div className="border-t border-white/5 bg-[--bg-tertiary] p-6">
                <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/40">
                  <span>{r.mentioned ? '✓ Mentioned' : '✗ Not mentioned'}</span>
                  <span>Provider: {r.provider}</span>
                  <span>Model: {r.model}</span>
                  <span>{r.citationUrls.length} citations</span>
                  {showVariance && (
                    <span
                      className={hasDissent ? 'text-amber-300' : undefined}
                      title="Self-consistency: multiple samples drawn from each provider and majority-voted. Variance = fraction of samples that disagreed with the majority."
                    >
                      Self-consistency: k={r.k}{hasDissent ? `, ${variancePct}% dissent` : ', unanimous'}
                    </span>
                  )}
                </div>

                <div className="mb-4">
                  <span className="text-xs font-medium uppercase tracking-widest text-white/55">Response</span>
                  <p className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-black/30 p-4 font-[family-name:var(--font-geist-mono)] text-sm leading-relaxed text-white/70">
                    {r.fullResponse}
                  </p>
                </div>

                {r.gapReasons.length > 0 && (
                  <div className="mb-4">
                    <span className="text-xs font-medium uppercase tracking-widest text-white/55">Gap Reasons</span>
                    <ul className="mt-2 list-inside list-disc text-sm text-[--rag-yellow]">
                      {r.gapReasons.map((g, j) => <li key={j}>{g}</li>)}
                    </ul>
                  </div>
                )}

                {r.factualErrors.length > 0 && (
                  <div className="mb-4">
                    <span className="text-xs font-medium uppercase tracking-widest text-white/55">Factual Errors</span>
                    <ul className="mt-2 list-inside list-disc text-sm text-[--rag-red]">
                      {r.factualErrors.map((e, j) => <li key={j}>{e}</li>)}
                    </ul>
                  </div>
                )}

                {r.citationUrls.length > 0 && (
                  <div>
                    <span className="text-xs font-medium uppercase tracking-widest text-white/55">Citations</span>
                    <ul className="mt-2 list-inside list-disc text-sm text-[--accent]">
                      {r.citationUrls.map((url, j) => (
                        <li key={j}>
                          <a href={url} target="_blank" rel="noopener noreferrer" className="underline">{url}</a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}
