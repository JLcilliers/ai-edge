import { notFound } from 'next/navigation';
import {
  getSuppressionFindings,
  getLatestSuppressionRun,
  getSuppressionSummary,
} from '../../../actions/suppression-actions';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { SuppressionClient } from './suppression-client';

export const dynamic = 'force-dynamic';

export default async function SuppressionPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  // Parallel fetch — the three queries are independent (summary counts the
  // same page table the findings query joins, but they're two round trips
  // regardless, so kick them off together).
  const [findings, latestRun, summary] = await Promise.all([
    getSuppressionFindings(firmSlug).catch(() => []),
    getLatestSuppressionRun(firmSlug).catch(() => null),
    getSuppressionSummary(firmSlug).catch(() => ({
      totalPages: 0,
      noindexCount: 0,
      rewriteCount: 0,
      alignedCount: 0,
      avgDistance: null,
    })),
  ]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Legacy Content Suppression
        </h1>
        <p className="mt-2 text-white/55">
          Scans {firm.name}&apos;s site for pages that drift from the Brand Truth.
          Pages that diverge hurt LLM alignment — suppress or rewrite them so
          your current positioning is what surfaces in AI answers.
        </p>
      </div>
      <SuppressionClient
        firmSlug={firmSlug}
        initialFindings={findings}
        initialLatestRun={latestRun}
        initialSummary={summary}
      />
    </div>
  );
}
