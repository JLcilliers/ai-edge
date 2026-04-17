'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { exportAuditCsv } from '../../../actions/audit-actions';

type Result = {
  queryText: string;
  provider: string;
  model: string;
  mentioned: boolean;
  toneScore: number | null;
  ragLabel: string;
  gapReasons: string[];
  citationUrls: string[];
  responsePreview: string;
  fullResponse: string;
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

const RAG_COLORS: Record<string, string> = {
  red: 'bg-red-600 text-white',
  yellow: 'bg-yellow-500 text-black',
  green: 'bg-green-600 text-white',
};

export function AuditDetailClient({
  detail,
  auditId,
}: {
  detail: Detail;
  auditId: string;
}) {
  const { run, results, summary } = detail;
  const [filter, setFilter] = useState<'all' | 'red' | 'yellow' | 'green'>('all');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [isExporting, startExport] = useTransition();

  const filtered = filter === 'all' ? results : results.filter((r) => r.ragLabel === filter);
  const total = summary.red + summary.yellow + summary.green;

  const handleExport = () => {
    startExport(async () => {
      const csv = await exportAuditCsv(auditId);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-${auditId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link href="/dashboard/audits" className="text-xs text-neutral-500 hover:text-neutral-300">
            &larr; Back to audits
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">Audit Detail</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {run.status} &middot;{' '}
            {run.startedAt ? new Date(run.startedAt).toLocaleString() : 'pending'}{' '}
            {run.finishedAt && run.startedAt && (
              <span>
                &middot;{' '}
                {Math.round(
                  (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000,
                )}
                s
              </span>
            )}
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={isExporting}
          className="rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-2 text-sm text-neutral-200 transition hover:bg-neutral-700 disabled:opacity-50"
        >
          {isExporting ? 'Exporting...' : 'Export CSV'}
        </button>
      </div>

      {/* RAG summary bar */}
      <div className="mt-6">
        <div className="flex gap-4 text-sm">
          <span className="text-red-400">{summary.red} Red</span>
          <span className="text-yellow-400">{summary.yellow} Yellow</span>
          <span className="text-green-400">{summary.green} Green</span>
          <span className="text-neutral-500">{total} total</span>
        </div>
        {total > 0 && (
          <div className="mt-2 flex h-4 overflow-hidden rounded-full">
            {summary.red > 0 && (
              <div className="bg-red-600" style={{ width: `${(summary.red / total) * 100}%` }} />
            )}
            {summary.yellow > 0 && (
              <div className="bg-yellow-500" style={{ width: `${(summary.yellow / total) * 100}%` }} />
            )}
            {summary.green > 0 && (
              <div className="bg-green-600" style={{ width: `${(summary.green / total) * 100}%` }} />
            )}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="mt-6 flex gap-2">
        {(['all', 'red', 'yellow', 'green'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition ${
              filter === f
                ? 'bg-neutral-700 text-white'
                : 'bg-neutral-900 text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)} ({f === 'all' ? total : summary[f]})
          </button>
        ))}
      </div>

      {/* Results table */}
      <div className="mt-4 flex flex-col gap-1">
        {filtered.length === 0 && (
          <p className="py-8 text-center text-sm text-neutral-600">No results for this filter.</p>
        )}

        {filtered.map((r, i) => (
          <div key={i} className="rounded-lg border border-neutral-800 bg-neutral-900">
            <button
              type="button"
              onClick={() => setExpandedRow(expandedRow === i ? null : i)}
              className="flex w-full items-center gap-4 px-4 py-3 text-left text-sm hover:bg-neutral-800/50"
            >
              <span
                className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${RAG_COLORS[r.ragLabel] ?? 'bg-neutral-600 text-white'}`}
              >
                {r.ragLabel.toUpperCase()}
              </span>
              <span className="flex-1 truncate text-neutral-200">{r.queryText}</span>
              <span className="text-xs text-neutral-500">{r.provider}</span>
              <span className="text-xs text-neutral-500">{r.mentioned ? 'Mentioned' : 'Not mentioned'}</span>
              <span className="w-12 text-right text-xs text-neutral-500">
                {r.toneScore !== null ? `${r.toneScore}/10` : '—'}
              </span>
              <span className="text-xs text-neutral-600">{r.citationUrls.length} cites</span>
            </button>

            {expandedRow === i && (
              <div className="border-t border-neutral-800 px-4 py-4 text-sm">
                <div className="mb-3">
                  <span className="text-xs font-medium text-neutral-400">Full Response:</span>
                  <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-neutral-300">
                    {r.fullResponse}
                  </p>
                </div>
                {r.gapReasons.length > 0 && (
                  <div className="mb-3">
                    <span className="text-xs font-medium text-neutral-400">Gap Reasons:</span>
                    <ul className="mt-1 list-inside list-disc text-xs text-yellow-300">
                      {r.gapReasons.map((g, j) => (
                        <li key={j}>{g}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {r.citationUrls.length > 0 && (
                  <div>
                    <span className="text-xs font-medium text-neutral-400">Citations:</span>
                    <ul className="mt-1 list-inside list-disc text-xs text-blue-300">
                      {r.citationUrls.map((url, j) => (
                        <li key={j}>
                          <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
                            {url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
