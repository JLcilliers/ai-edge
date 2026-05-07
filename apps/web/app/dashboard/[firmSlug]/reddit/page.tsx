import { notFound } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
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
      <RedditQuotaNotice />
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

/**
 * Operator-facing notice that the Reddit data source is currently quota-
 * blocked. Surfaced above the feed so a stale "0 new mentions" state
 * doesn't get misread as "Reddit is quiet about this firm" — it's
 * actually "we've stopped fetching Reddit until the plan is upgraded."
 *
 * Why this is a static banner rather than a dynamic check on the latest
 * `audit_run.error`: the failure mode is the same for every firm in this
 * workspace right now (shared RapidAPI key, BASIC plan monthly quota).
 * A static banner is the cheapest accurate signal. Once the plan is
 * upgraded (or migrated to a different provider) this component is
 * deleted in one PR.
 */
function RedditQuotaNotice() {
  return (
    <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
      <AlertTriangle
        size={18}
        strokeWidth={2}
        className="mt-0.5 shrink-0 text-amber-300"
      />
      <div className="flex-1 text-sm leading-relaxed">
        <p className="font-semibold text-amber-200">
          Reddit polling paused — RapidAPI plan needs upgrade
        </p>
        <p className="mt-1 text-amber-100/80">
          Our shared RapidAPI Reddit3 key has hit the BASIC tier&apos;s monthly
          request quota. The daily reddit-poll cron is currently failing for
          every firm with a 429 error, and any new mentions are not being
          ingested. Existing mentions remain visible below — but they reflect
          the last successful scan, not today&apos;s Reddit chatter.
        </p>
        <p className="mt-1 text-amber-100/80">
          Fix: upgrade the plan at{' '}
          <a
            href="https://rapidapi.com/sparior/api/reddit3"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:no-underline"
          >
            rapidapi.com/sparior/api/reddit3
          </a>{' '}
          (PRO tier covers our current ~750 calls/month volume). Quota also
          resets on the next billing cycle if you&apos;d rather wait.
        </p>
      </div>
    </div>
  );
}
