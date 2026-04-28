import { notFound } from 'next/navigation';
import { FileBarChart } from 'lucide-react';
import { getFirmBySlug } from '../../../actions/firm-actions';
import {
  listMonthlyReports,
  getReportTileSummary,
} from '../../../actions/report-actions';
import { ReportsClient } from './reports-client';

export const dynamic = 'force-dynamic';

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const [reports, summary] = await Promise.all([
    listMonthlyReports(firmSlug),
    getReportTileSummary(firmSlug),
  ]);

  return (
    <div>
      <div className="mb-8 flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/5">
          <FileBarChart size={24} strokeWidth={1.5} className="text-[var(--accent)]" />
        </div>
        <div>
          <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
            Monthly Reports
          </h1>
          <p className="mt-2 text-white/55">
            A per-firm month-in-review: audit RAG roll-up, reddit sentiment,
            competitor share-of-voice, suppression queue, and entity
            divergences. Cron generates last month&apos;s report on the 1st
            (05:00 UTC); use &ldquo;Rebuild&rdquo; to backfill a missed month.
          </p>
        </div>
      </div>

      <ReportsClient
        firmSlug={firmSlug}
        initialReports={reports}
        initialSummary={summary}
      />
    </div>
  );
}
