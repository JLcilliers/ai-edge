import { getRedditMentions, getLatestRedditRun } from '../../actions/reddit-actions';
import { RedditListClient } from './reddit-list-client';

export const dynamic = 'force-dynamic';

export default async function RedditPage() {
  const [mentions, latestRun] = await Promise.all([
    getRedditMentions().catch(() => []),
    getLatestRedditRun().catch(() => null),
  ]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Reddit Sentiment
        </h1>
        <p className="mt-2 text-white/55">
          What Redditors say about you — and what prospects are asking.
          Reddit is a high-weight LLM citation source.
        </p>
      </div>
      <RedditListClient initialMentions={mentions} initialLatestRun={latestRun} />
    </div>
  );
}
