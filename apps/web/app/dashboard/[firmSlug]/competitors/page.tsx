import { notFound } from 'next/navigation';
import { getFirmBySlug } from '../../../actions/firm-actions';
import {
  listCompetitors,
  getCompetitorShareOfMention,
} from '../../../actions/competitor-actions';
import { CompetitorsClient } from './competitors-client';

export const dynamic = 'force-dynamic';

export default async function CompetitorsPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  // Run both reads in parallel — they're independent and the roster is the
  // only one that's strictly required for the page to render.
  const [roster, share] = await Promise.all([
    listCompetitors(firmSlug).catch(() => []),
    getCompetitorShareOfMention(firmSlug).catch(() => ({
      latestRunId: null,
      latestRunFinishedAt: null,
      rows: [],
    })),
  ]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Competitors
        </h1>
        <p className="mt-2 text-white/55">
          Track which rival firms the LLMs mention for {firm.name}&rsquo;s prospect
          queries. Share-of-mention comes from the latest completed audit.
        </p>
      </div>
      <CompetitorsClient
        firmSlug={firmSlug}
        initialRoster={roster}
        initialShare={share}
      />
    </div>
  );
}
