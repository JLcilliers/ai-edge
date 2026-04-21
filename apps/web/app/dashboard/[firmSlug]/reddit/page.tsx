import { notFound } from 'next/navigation';
import {
  getRedditMentions,
  getLatestRedditRun,
} from '../../../actions/reddit-actions';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { RedditListClient } from './reddit-list-client';

export const dynamic = 'force-dynamic';

export default async function RedditPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const [mentions, latestRun] = await Promise.all([
    getRedditMentions(firmSlug).catch(() => []),
    getLatestRedditRun(firmSlug).catch(() => null),
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
      />
    </div>
  );
}
