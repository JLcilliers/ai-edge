'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import {
  Download,
  RotateCw,
  FileJson,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  Eye,
} from 'lucide-react';
import {
  rebuildMonthlyReport,
  type ReportListItem,
  type ReportTileSummary,
} from '../../../actions/report-actions';

function formatMonth(monthKey: string): string {
  // 'YYYY-MM' → 'Mar 2026'
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return monthKey;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return date.toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Current calendar month in UTC as 'YYYY-MM'. Mirrors monthKeyFromDate
 *  on the server but cheaper than another round-trip — operators only see
 *  this client-side once the page has rendered. */
function currentUtcMonthKey(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function formatDateTime(d: Date): string {
  return new Date(d).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ReportsClient({
  firmSlug,
  initialReports,
  initialSummary,
}: {
  firmSlug: string;
  initialReports: ReportListItem[];
  initialSummary: ReportTileSummary | null;
}) {
  const [reports, setReports] = useState<ReportListItem[]>(initialReports);
  const [summary, setSummary] = useState<ReportTileSummary | null>(
    initialSummary,
  );
  const [busyMonth, setBusyMonth] = useState<string | null>(null);
  const [toast, setToast] = useState<
    { kind: 'ok' | 'error'; message: string } | null
  >(null);
  const [isPending, startTransition] = useTransition();

  const handleRebuild = (monthKey?: string) => {
    const target = monthKey ?? summary?.previousMonthKey ?? '';
    setBusyMonth(target);
    setToast(null);
    startTransition(async () => {
      try {
        const res = await rebuildMonthlyReport(firmSlug, target || undefined);
        if (!res.ok) {
          setToast({ kind: 'error', message: res.error });
        } else {
          setToast({
            kind: 'ok',
            message: `Generated ${formatMonth(res.monthKey)}${res.blobUrl ? ' + uploaded to Blob' : ' (Blob skipped — no token)'}`,
          });
          // Optimistic list update — we'll refresh on next navigation.
          const existing = reports.find((r) => r.monthKey === res.monthKey);
          if (!existing) {
            setReports([
              {
                id: res.reportId,
                monthKey: res.monthKey,
                generatedAt: new Date(),
                blobUrl: res.blobUrl,
                audits: 0,
                redditMentions: 0,
                ragTotals: { red: 0, yellow: 0, green: 0 },
              },
              ...reports,
            ]);
          } else {
            setReports(
              reports.map((r) =>
                r.monthKey === res.monthKey
                  ? { ...r, generatedAt: new Date(), blobUrl: res.blobUrl }
                  : r,
              ),
            );
          }
          setSummary((s) =>
            s
              ? {
                  ...s,
                  previousMonthHasReport:
                    s.previousMonthKey === res.monthKey
                      ? true
                      : s.previousMonthHasReport,
                }
              : s,
          );
        }
      } catch (err) {
        setToast({ kind: 'error', message: String(err) });
      } finally {
        setBusyMonth(null);
      }
    });
  };

  return (
    <>
      {/* Previous-month status banner */}
      {summary && (
        <div
          className={`mb-6 flex items-start gap-3 rounded-xl border p-5 ${
            summary.previousMonthHasReport
              ? 'border-[var(--rag-green)]/30 bg-[var(--bg-secondary)]'
              : 'border-amber-500/40 bg-[var(--bg-secondary)]'
          }`}
        >
          {summary.previousMonthHasReport ? (
            <CheckCircle2
              size={20}
              strokeWidth={1.5}
              className="mt-0.5 shrink-0 text-[var(--rag-green)]"
            />
          ) : (
            <AlertTriangle
              size={20}
              strokeWidth={1.5}
              className="mt-0.5 shrink-0 text-amber-300"
            />
          )}
          <div className="flex-1">
            <p
              className={`font-semibold ${
                summary.previousMonthHasReport
                  ? 'text-[var(--rag-green)]'
                  : 'text-amber-300'
              }`}
            >
              {summary.previousMonthHasReport
                ? `${formatMonth(summary.previousMonthKey)} report ready`
                : `${formatMonth(summary.previousMonthKey)} report not generated yet`}
            </p>
            <p className="mt-1 text-sm text-white/55">
              {summary.previousMonthHasReport
                ? 'Download the JSON payload or view the full breakdown below.'
                : 'Cron fires on the 1st of each month. Click "Rebuild" to trigger manually.'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {summary.previousMonthHasReport && (
              <Link
                href={`/dashboard/${firmSlug}/reports/${summary.previousMonthKey}`}
                className="flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-sm text-white transition-colors hover:border-[var(--accent)]"
              >
                <Eye size={14} />
                View
              </Link>
            )}
            <button
              type="button"
              onClick={() => handleRebuild(summary.previousMonthKey)}
              disabled={isPending}
              className="flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-sm text-white transition-colors hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCw
                size={14}
                className={
                  isPending && busyMonth === summary.previousMonthKey
                    ? 'animate-spin'
                    : ''
                }
              />
              Rebuild
            </button>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`mb-4 rounded-xl border p-4 text-sm ${
            toast.kind === 'ok'
              ? 'border-[var(--rag-green)]/30 text-[var(--rag-green)]'
              : 'border-red-500/40 text-red-300'
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Reports list */}
      {reports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 bg-[var(--bg-secondary)] p-10 text-center">
          <Calendar
            size={28}
            strokeWidth={1.5}
            className="mx-auto mb-3 text-white/30"
          />
          <p className="mx-auto max-w-xl text-sm text-white/55">
            No reports yet. The cron generates the previous month&apos;s
            report on the 1st (05:00 UTC). For a freshly-created firm with
            no historical audits, generate the <em>current</em> month
            instead — that&apos;ll capture everything the firm has done so
            far this month.
          </p>
          <div className="mt-5 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => handleRebuild(currentUtcMonthKey())}
              disabled={isPending}
              className="flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCw
                size={14}
                className={
                  isPending && busyMonth === currentUtcMonthKey()
                    ? 'animate-spin'
                    : ''
                }
              />
              Generate {formatMonth(currentUtcMonthKey())} report
            </button>
            {summary && !summary.previousMonthHasReport && (
              <button
                type="button"
                onClick={() => handleRebuild(summary.previousMonthKey)}
                disabled={isPending}
                className="flex items-center gap-2 rounded-full border border-white/10 px-5 py-2 text-sm text-white transition-colors hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RotateCw
                  size={14}
                  className={
                    isPending && busyMonth === summary.previousMonthKey
                      ? 'animate-spin'
                      : ''
                  }
                />
                Or generate {formatMonth(summary.previousMonthKey)}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-[var(--bg-secondary)]">
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-4 border-b border-white/5 bg-[var(--bg-tertiary)] px-5 py-3 text-[10px] font-medium uppercase tracking-widest text-white/55">
            <span>Month</span>
            <span>Audits</span>
            <span>RAG</span>
            <span>Reddit</span>
            <span>Actions</span>
          </div>

          {reports.map((r) => {
            const total = r.ragTotals.red + r.ragTotals.yellow + r.ragTotals.green;
            return (
              <div
                key={r.id}
                className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-4 border-b border-white/5 px-5 py-4 text-sm last:border-b-0"
              >
                <div>
                  <div className="font-[family-name:var(--font-jakarta)] text-base font-semibold text-white">
                    {formatMonth(r.monthKey)}
                  </div>
                  <div
                    className="mt-0.5 font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40"
                    suppressHydrationWarning
                  >
                    generated {formatDateTime(r.generatedAt)}
                  </div>
                </div>
                <span className="text-white/70">{r.audits}</span>
                <span className="font-[family-name:var(--font-geist-mono)] text-xs">
                  {total > 0 ? (
                    <span className="flex gap-2">
                      {r.ragTotals.red > 0 && (
                        <span className="text-[var(--rag-red)]">
                          {r.ragTotals.red}R
                        </span>
                      )}
                      {r.ragTotals.yellow > 0 && (
                        <span className="text-[var(--rag-yellow)]">
                          {r.ragTotals.yellow}Y
                        </span>
                      )}
                      {r.ragTotals.green > 0 && (
                        <span className="text-[var(--rag-green)]">
                          {r.ragTotals.green}G
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-white/30">—</span>
                  )}
                </span>
                <span className="text-white/70">{r.redditMentions}</span>
                <div className="flex items-center gap-2">
                  <Link
                    href={`/dashboard/${firmSlug}/reports/${r.monthKey}`}
                    className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs text-white transition-colors hover:border-[var(--accent)]"
                    title="Open full report breakdown"
                  >
                    <Eye size={12} />
                    View
                  </Link>
                  {r.blobUrl && (
                    <a
                      href={r.blobUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs text-white transition-colors hover:border-[var(--accent)]"
                      title="Download JSON from Vercel Blob"
                    >
                      <Download size={12} />
                      JSON
                    </a>
                  )}
                  {!r.blobUrl && (
                    <span
                      className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/40"
                      title="Blob not configured — payload is in Postgres only"
                    >
                      <FileJson size={12} />
                      DB only
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRebuild(r.monthKey)}
                    disabled={isPending}
                    className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs text-white transition-colors hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RotateCw
                      size={12}
                      className={
                        isPending && busyMonth === r.monthKey
                          ? 'animate-spin'
                          : ''
                      }
                    />
                    Rebuild
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
