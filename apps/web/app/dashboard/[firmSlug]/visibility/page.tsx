import { notFound } from 'next/navigation';
import { Eye } from 'lucide-react';
import { getFirmBySlug } from '../../../actions/firm-actions';
import {
  getShareOfVoice,
  getCitationSourceGraph,
  getCitationDriftHistory,
  getAlignmentRegression,
} from '../../../actions/visibility-actions';
import {
  listAioCaptures,
  getAioProviderName,
} from '../../../actions/aio-actions';
import { getVisibilityCorrelation } from '../../../actions/visibility-correlation-actions';
import { VisibilityClient } from './visibility-client';

export const dynamic = 'force-dynamic';

/**
 * Brand Visibility dashboard (PLAN §5.2 "Brand Visibility & Citation Mapping").
 *
 * Three views over the latest few completed audit runs:
 *  1. Share of Voice — firm vs each competitor, mention count + pct.
 *  2. Citation Sources — domains LLMs cite when describing the firm,
 *     ranked by frequency (prioritize these for link/PR effort).
 *  3. Citation Drift — gained/lost domains over time, populated by the
 *     nightly citation-diff cron.
 */
export default async function VisibilityPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const [
    shareOfVoice,
    sourceGraph,
    driftHistory,
    regression,
    aioCaptures,
    aioProvider,
    correlation,
  ] = await Promise.all([
    getShareOfVoice(firmSlug),
    getCitationSourceGraph(firmSlug),
    getCitationDriftHistory(firmSlug),
    getAlignmentRegression(firmSlug),
    listAioCaptures(firmSlug).catch(() => []),
    getAioProviderName().catch(() => 'none'),
    getVisibilityCorrelation(firmSlug, 30).catch(() => null),
  ]);

  return (
    <div>
      <div className="mb-8 flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/5">
          <Eye size={24} strokeWidth={1.5} className="text-[--accent]" />
        </div>
        <div>
          <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
            Brand Visibility
          </h1>
          <p className="mt-2 text-white/55">
            How often this firm shows up in LLM answers vs competitors,
            which domains the models cite as sources, and how that citation
            set drifts between runs. Refreshed by the weekly/daily audits
            and the nightly citation-diff cron.
          </p>
        </div>
      </div>

      <VisibilityClient
        firmSlug={firmSlug}
        firmName={firm.name}
        shareOfVoice={shareOfVoice}
        sourceGraph={sourceGraph}
        driftHistory={driftHistory}
        regression={regression}
        aioCaptures={aioCaptures}
        aioProvider={aioProvider}
        correlation={correlation}
      />
    </div>
  );
}
