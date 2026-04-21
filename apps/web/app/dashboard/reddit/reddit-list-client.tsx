'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare, ExternalLink } from 'lucide-react';
import {
  startRedditScan,
  getRedditScanStatus,
  type RedditMentionRow,
} from '../../actions/reddit-actions';

type LatestRun = {
  id: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
} | null;

export function RedditListClient({
  initialMentions,
  initialLatestRun,
}: {
  initialMentions: RedditMentionRow[];
  initialLatestRun: LatestRun;
}) {
  const [isPending, startTransition] = useTransition();
  const [runningId, setRunningId] = useState<string | null>(
    initialLatestRun?.status === 'running' ? initialLatestRun.id : null,
  );
  const [error, setError] = useState<string | null>(initialLatestRun?.error ?? null);
  const router = useRouter();

  useEffect(() => {
    if (!runningId) return;
    const interval = setInterval(async () => {
      const status = await getRedditScanStatus(runningId);
      if (status.status !== 'running') {
        setRunningId(null);
        if (status.error) setError(status.error);
        router.refresh();
        clearInterval(interval);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [runningId, router]);

  const handleStartScan = () => {
    setError(null);
    startTransition(async () => {
      const result = await startRedditScan();
      if ('error' in result) {
        setError(result.error);
      } else {
        setRunningId(result.runId);
        router.refresh();
      }
    });
  };

  const counts = summarize(initialMentions);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={handleStartScan}
          disabled={isPending || !!runningId}
          className="rounded-full bg-[--accent] px-6 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[--accent-hover] disabled:opacity-50"
        >
          {isPending ? 'Starting...' : runningId ? 'Scan Running...' : 'Run Reddit Scan'}
        </button>
        {initialLatestRun?.finishedAt && (
          <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
            Last scanned {new Date(initialLatestRun.finishedAt).toLocaleString()}
          </span>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/15 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {runningId && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-[--accent]/30 bg-[--accent]/10 px-4 py-3">
          <div className="h-3 w-3 animate-pulse rounded-full bg-[--accent]" />
          <span className="text-sm text-[--accent]">Scanning Reddit... polling every 5s</span>
        </div>
      )}

      {/* Sentiment counts strip */}
      {initialMentions.length > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Praise" value={counts.praise} tone="green" />
          <StatCard label="Complaint" value={counts.complaint} tone="red" />
          <StatCard label="Rec Request" value={counts.recommendation_request} tone="accent" />
          <StatCard label="Neutral" value={counts.neutral} tone="gray" />
        </div>
      )}

      <div className="mt-8 flex flex-col gap-2">
        {initialMentions.length === 0 && !runningId && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <MessageSquare className="mb-4 h-12 w-12 text-white/20" strokeWidth={1.5} />
            <h3 className="mb-2 text-lg font-semibold text-white/60">No Reddit mentions yet</h3>
            <p className="mb-6 max-w-md text-sm text-white/40">
              Run a scan to surface recent posts mentioning your firm. Complaints with 10+ karma
              auto-open a remediation ticket.
            </p>
          </div>
        )}

        {initialMentions.map((m) => (
          <a
            key={m.id}
            href={m.url}
            target="_blank"
            rel="noreferrer"
            className="group flex items-start justify-between gap-4 rounded-xl border border-white/10 bg-[--bg-secondary] px-5 py-4 transition-colors hover:border-white/20"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <SentimentBadge sentiment={m.sentiment} />
                <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/55">
                  r/{m.subreddit}
                </span>
                {m.author && (
                  <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
                    u/{m.author}
                  </span>
                )}
                <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/30">
                  {m.karma ?? 0} karma
                </span>
                {m.postedAt && (
                  <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/30">
                    {new Date(m.postedAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                )}
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-white/80">{m.text ?? ''}</p>
            </div>
            <ExternalLink
              size={16}
              strokeWidth={1.5}
              className="mt-1 shrink-0 text-white/30 transition-colors group-hover:text-white/60"
            />
          </a>
        ))}
      </div>
    </div>
  );
}

function summarize(mentions: RedditMentionRow[]) {
  const counts = { praise: 0, complaint: 0, recommendation_request: 0, neutral: 0 };
  for (const m of mentions) {
    const s = (m.sentiment ?? 'neutral') as keyof typeof counts;
    if (s in counts) counts[s]++;
    else counts.neutral++;
  }
  return counts;
}

function SentimentBadge({ sentiment }: { sentiment: string | null }) {
  const label = sentiment ?? 'neutral';
  const styles: Record<string, string> = {
    praise: 'bg-[--rag-green-bg] text-[--rag-green]',
    complaint: 'bg-[--rag-red-bg] text-[--rag-red]',
    recommendation_request: 'bg-[--accent]/15 text-[--accent]',
    neutral: 'bg-white/10 text-white/55',
  };
  const display =
    label === 'recommendation_request' ? 'rec request' : label;
  return (
    <span
      className={`rounded-full px-3 py-1 text-[10px] font-medium uppercase tracking-wider ${
        styles[label] ?? 'bg-white/10 text-white/55'
      }`}
    >
      {display}
    </span>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'green' | 'red' | 'accent' | 'gray';
}) {
  const color =
    tone === 'green'
      ? 'text-[--rag-green]'
      : tone === 'red'
      ? 'text-[--rag-red]'
      : tone === 'accent'
      ? 'text-[--accent]'
      : 'text-white/60';
  return (
    <div className="rounded-xl border border-white/10 bg-[--bg-secondary] px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className={`mt-1 font-[family-name:var(--font-jakarta)] text-2xl font-bold ${color}`}>
        {value}
      </div>
    </div>
  );
}
