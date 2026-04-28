import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Download,
  FileBarChart,
  Activity,
  MessageSquare,
  Users,
  FileX,
  Database,
  DollarSign,
} from 'lucide-react';
import { getFirmBySlug } from '../../../../actions/firm-actions';
import { getMonthlyReport, listMonthlyReports } from '../../../../actions/report-actions';
import { ReportDetailView } from './report-detail-view';

export const dynamic = 'force-dynamic';

/**
 * Monthly report detail view.
 *
 * Renders the full `MonthlyReportPayload` as a human-readable page.
 * The reports table links here for each row; the JSON download is still
 * available on this page via the header button for operators who want
 * to hand the raw payload to a downstream tool.
 */
export default async function MonthlyReportDetailPage({
  params,
}: {
  params: Promise<{ firmSlug: string; monthKey: string }>;
}) {
  const { firmSlug, monthKey } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  if (!/^\d{4}-\d{2}$/.test(monthKey)) notFound();

  const [payload, allReports] = await Promise.all([
    getMonthlyReport(firmSlug, monthKey),
    // We need the blob_url for the download button, which isn't on the
    // payload itself. Pulling the full list is cheap enough and avoids
    // adding another per-month action.
    listMonthlyReports(firmSlug),
  ]);

  if (!payload) notFound();

  const row = allReports.find((r) => r.monthKey === monthKey) ?? null;

  return (
    <div>
      <Link
        href={`/dashboard/${firmSlug}/reports`}
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-white/40 transition-colors hover:text-white/70"
      >
        <ArrowLeft size={12} strokeWidth={2} />
        All reports
      </Link>

      <div className="mb-8 flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/5">
          <FileBarChart size={24} strokeWidth={1.5} className="text-[var(--accent)]" />
        </div>
        <div className="flex-1">
          <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
            {formatMonthLong(monthKey)} Report
          </h1>
          <p className="mt-2 text-sm text-white/55">
            {firm.name} · Generated{' '}
            {new Date(payload.generated_at).toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
            {' · '}Payload v{payload.payload_version}
          </p>
        </div>
        {row?.blobUrl && (
          <a
            href={row.blobUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-full border border-white/10 px-4 py-2 text-xs text-white transition-colors hover:border-[var(--accent)]"
            title="Download JSON from Vercel Blob"
          >
            <Download size={14} strokeWidth={1.75} />
            JSON
          </a>
        )}
      </div>

      <ReportDetailView payload={payload} />

      {/* Footer navigation: show icon row for which sections exist. */}
      <div className="mt-10 flex flex-wrap items-center gap-3 border-t border-white/5 pt-5 text-[10px] uppercase tracking-widest text-white/30">
        <SectionIcon icon={Activity} label="audits" />
        <SectionIcon icon={MessageSquare} label="reddit" />
        <SectionIcon icon={Users} label="competitive" />
        <SectionIcon icon={FileX} label="suppression" />
        <SectionIcon icon={Database} label="entity" />
        <SectionIcon icon={DollarSign} label="cost" />
      </div>
    </div>
  );
}

function SectionIcon({
  icon: Icon,
  label,
}: {
  icon: typeof Activity;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon size={11} strokeWidth={1.5} />
      {label}
    </span>
  );
}

function formatMonthLong(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return monthKey;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return d.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
