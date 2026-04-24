import { notFound } from 'next/navigation';
import {
  getRedditMentions,
  getRedditTriageCounts,
  getLatestRedditRun,
} from '../../../actions/reddit-actions';
import {
  TRIAGE_STATUSES,
  type TriageStatus,
} from '../../../actions/reddit-constants';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { RedditListClient } from './reddit-list-client';

export const dynamic = 'force-dynamic';

/**
 * Reddit sentiment page with a triage-aware feed.
 *
 * `?status=<open|acknowledged|dismissed|escalated>` filters the feed to a
 * single triage bucket — the Admin dashboard's "open complaints" cell links
 * straight into `?status=open` so operators land on their queue. Missing or
 * invalid statuses show the full feed.
 */
export default async function RedditPage({
  params,
  searchParams,
}: {
  params: Promise<{ firmSlug: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { firmSlug } = await params;
  const { status } = await searchParams;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const activeFilter: TriageStatus | null =
    status && (TRIAGE_STATUSES as readonly string[]).includes(status)
      ? (status as TriageStatus)
      : null;

  const [mentions, latestRun, counts] = await Promise.all([
    getRedditMentions(firmSlug, activeFilter ? { status: activeFilter } : undefined).catch(
      () => [],
    ),
    getLatestRedditRun(firmSlug).catch(() => null),
    getRedditTriageCounts(firmSlug).catch(() => ({
      all: 0,
      open: 0,
      acknowledged: 0,
      dismissed: 0,
      escalated: 0,
    })),
  ]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Reddit Sentiment
        </h1>
        <p className="mt-2 text-white/55">
          What Redditors say about {firm.name} — and what prospects are asking.
          Reddit is a high-weight LLM citation source.
        </p>
      </div>
      <RedditListClient
        firmSlug={firmSlug}
        initialMentions={mentions}
        initialLatestRun={latestRun}
        counts={counts}
        activeFilter={activeFilter}
      />
    </div>
  );
}
