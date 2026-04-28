'use client';

import { useState, useTransition, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  MessageSquare,
  ExternalLink,
  X,
  AlertTriangle,
  RotateCcw,
  Eye,
} from 'lucide-react';
import {
  startRedditScan,
  getRedditScanStatus,
  updateRedditMentionTriage,
  bulkDismissOpenBySentiment,
  type RedditMentionRow,
} from '../../../actions/reddit-actions';
import {
  TRIAGE_STATUSES,
  type TriageStatus,
} from '../../../actions/reddit-constants';

type LatestRun = {
  id: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
} | null;

type TriageCounts = Record<TriageStatus | 'all', number>;

type FilterKey = TriageStatus | 'all';

export function RedditListClient({
  firmSlug,
  initialMentions,
  initialLatestRun,
  counts,
  activeFilter,
}: {
  firmSlug: string;
  initialMentions: RedditMentionRow[];
  initialLatestRun: LatestRun;
  counts: TriageCounts;
  activeFilter: TriageStatus | null;
}) {
  const [isPending, startTransition] = useTransition();
  const [runningId, setRunningId] = useState<string | null>(
    initialLatestRun?.status === 'running' ? initialLatestRun.id : null,
  );
  const [error, setError] = useState<string | null>(initialLatestRun?.error ?? null);
  // Optimistic triage: the moment an operator clicks "dismiss" we flip the
  // status in local state so the row visually moves/fades immediately. The
  // server action revalidates afterward and refresh() reconciles.
  const [optimistic, setOptimistic] = useState<Map<string, TriageStatus>>(
    () => new Map(),
  );
  const [pendingRowId, setPendingRowId] = useState<string | null>(null);
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
      const result = await startRedditScan(firmSlug);
      if ('error' in result) {
        setError(result.error);
      } else {
        setRunningId(result.runId);
        router.refresh();
      }
    });
  };

  const handleTriage = (mentionId: string, status: TriageStatus) => {
    setError(null);
    setOptimistic((prev) => {
      const next = new Map(prev);
      next.set(mentionId, status);
      return next;
    });
    setPendingRowId(mentionId);
    startTransition(async () => {
      const result = await updateRedditMentionTriage(firmSlug, mentionId, {
        status,
      });
      if ('error' in result) {
        setError(result.error);
        // Roll back optimistic flip.
        setOptimistic((prev) => {
          const next = new Map(prev);
          next.delete(mentionId);
          return next;
        });
      } else {
        router.refresh();
      }
      setPendingRowId(null);
    });
  };

  const handleBulkDismissNeutral = () => {
    setError(null);
    startTransition(async () => {
      const result = await bulkDismissOpenBySentiment(firmSlug, 'neutral');
      if ('error' in result) {
        setError(result.error);
      } else {
        router.refresh();
      }
    });
  };

  // Merge optimistic overrides onto the server-provided list so the UI
  // responds instantly. If the optimistic status doesn't match the active
  // filter, the row stays visible for a beat (until refresh()) — this is
  // fine and makes the action feel less jumpy.
  const mentions = useMemo(
    () =>
      initialMentions.map((m) => ({
        ...m,
        triageStatus: optimistic.get(m.id) ?? m.triageStatus,
      })),
    [initialMentions, optimistic],
  );

  const sentimentCounts = summarize(mentions);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={handleStartScan}
          disabled={isPending || !!runningId}
          className="rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {isPending && !pendingRowId
            ? 'Starting...'
            : runningId
            ? 'Scan Running...'
            : 'Run Reddit Scan'}
        </button>
        {initialLatestRun?.finishedAt && (
          <span
            className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40"
            suppressHydrationWarning
          >
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
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-3">
          <div className="h-3 w-3 animate-pulse rounded-full bg-[var(--accent)]" />
          <span className="text-sm text-[var(--accent)]">Scanning Reddit... polling every 5s</span>
        </div>
      )}

      {/* Sentiment counts strip */}
      {initialMentions.length > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Praise" value={sentimentCounts.praise} tone="green" />
          <StatCard label="Complaint" value={sentimentCounts.complaint} tone="red" />
          <StatCard
            label="Rec Request"
            value={sentimentCounts.recommendation_request}
            tone="accent"
          />
          <StatCard label="Neutral" value={sentimentCounts.neutral} tone="gray" />
        </div>
      )}

      {/* Triage filter pills */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <FilterPill
          href={`/dashboard/${firmSlug}/reddit`}
          label="All"
          count={counts.all}
          active={activeFilter === null}
        />
        {TRIAGE_STATUSES.map((s) => (
          <FilterPill
            key={s}
            href={`/dashboard/${firmSlug}/reddit?status=${s}`}
            label={TRIAGE_LABEL[s]}
            count={counts[s]}
            active={activeFilter === s}
            tone={s}
          />
        ))}
        <div className="ml-auto">
          {counts.open > 0 && (
            <button
              onClick={handleBulkDismissNeutral}
              disabled={isPending}
              className="rounded-full border border-white/10 bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:border-white/20 hover:text-white disabled:opacity-50"
              title="Dismiss every open mention with sentiment = neutral"
            >
              Dismiss all neutral
            </button>
          )}
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-2">
        {mentions.length === 0 && !runningId && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <MessageSquare className="mb-4 h-12 w-12 text-white/20" strokeWidth={1.5} />
            <h3 className="mb-2 text-lg font-semibold text-white/60">
              {activeFilter
                ? `No ${TRIAGE_LABEL[activeFilter].toLowerCase()} mentions`
                : 'No Reddit mentions yet'}
            </h3>
            <p className="mb-6 max-w-md text-sm text-white/40">
              {activeFilter
                ? 'Try a different filter, or run a fresh scan to surface new posts.'
                : 'Run a scan to surface recent posts mentioning your firm. Complaints with 10+ karma auto-open a remediation ticket.'}
            </p>
          </div>
        )}

        {mentions.map((m) => (
          <MentionRow
            key={m.id}
            mention={m}
            pending={pendingRowId === m.id}
            onTriage={(status) => handleTriage(m.id, status)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────

function MentionRow({
  mention,
  pending,
  onTriage,
}: {
  mention: RedditMentionRow;
  pending: boolean;
  onTriage: (status: TriageStatus) => void;
}) {
  const isOpen = mention.triageStatus === 'open';
  return (
    <div
      className={`group flex flex-col gap-3 rounded-xl border bg-[var(--bg-secondary)] px-5 py-4 transition-colors ${
        mention.triageStatus === 'dismissed'
          ? 'border-white/5 opacity-60'
          : mention.triageStatus === 'escalated'
          ? 'border-red-500/30'
          : mention.triageStatus === 'acknowledged'
          ? 'border-amber-500/30'
          : 'border-white/10 hover:border-white/20'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SentimentBadge sentiment={mention.sentiment} />
            <TriageBadge status={mention.triageStatus} />
            <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/55">
              r/{mention.subreddit}
            </span>
            {mention.author && (
              <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
                u/{mention.author}
              </span>
            )}
            <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/30">
              {mention.karma ?? 0} karma
            </span>
            {mention.postedAt && (
              <span
                className="font-[family-name:var(--font-geist-mono)] text-xs text-white/30"
                suppressHydrationWarning
              >
                {new Date(mention.postedAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
            )}
          </div>
          <p className="mt-2 line-clamp-3 text-sm text-white/80">{mention.text ?? ''}</p>
        </div>
        <a
          href={mention.url}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:border-white/20 hover:text-white"
          title="Open on Reddit"
        >
          <ExternalLink size={12} strokeWidth={1.75} />
          Open
        </a>
      </div>

      {/* Triage action bar */}
      <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
        {isOpen ? (
          <>
            <TriageButton
              icon={<Eye size={12} strokeWidth={2} />}
              label="Acknowledge"
              onClick={() => onTriage('acknowledged')}
              disabled={pending}
              tone="amber"
            />
            <TriageButton
              icon={<X size={12} strokeWidth={2} />}
              label="Dismiss"
              onClick={() => onTriage('dismissed')}
              disabled={pending}
              tone="gray"
            />
            <TriageButton
              icon={<AlertTriangle size={12} strokeWidth={2} />}
              label="Escalate"
              onClick={() => onTriage('escalated')}
              disabled={pending}
              tone="red"
            />
          </>
        ) : (
          <>
            <TriageButton
              icon={<RotateCcw size={12} strokeWidth={2} />}
              label="Reopen"
              onClick={() => onTriage('open')}
              disabled={pending}
              tone="gray"
            />
            {mention.triageStatus !== 'escalated' && (
              <TriageButton
                icon={<AlertTriangle size={12} strokeWidth={2} />}
                label="Escalate"
                onClick={() => onTriage('escalated')}
                disabled={pending}
                tone="red"
              />
            )}
            {mention.triageStatus !== 'dismissed' && (
              <TriageButton
                icon={<X size={12} strokeWidth={2} />}
                label="Dismiss"
                onClick={() => onTriage('dismissed')}
                disabled={pending}
                tone="gray"
              />
            )}
          </>
        )}
        {mention.triagedAt && !isOpen && (
          <span
            className="ml-auto font-[family-name:var(--font-geist-mono)] text-[10px] text-white/30"
            suppressHydrationWarning
          >
            Triaged {new Date(mention.triagedAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}

function TriageButton({
  icon,
  label,
  onClick,
  disabled,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
  tone: 'amber' | 'red' | 'gray';
}) {
  const styles = {
    amber:
      'border-amber-500/20 text-amber-300 hover:bg-amber-500/10 hover:border-amber-500/40',
    red: 'border-red-500/20 text-red-300 hover:bg-red-500/10 hover:border-red-500/40',
    gray: 'border-white/10 text-white/60 hover:bg-white/5 hover:border-white/20',
  }[tone];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${styles}`}
    >
      {icon}
      {label}
    </button>
  );
}

// ── Pills + badges ──────────────────────────────────────────

const TRIAGE_LABEL: Record<TriageStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  dismissed: 'Dismissed',
  escalated: 'Escalated',
};

function FilterPill({
  href,
  label,
  count,
  active,
  tone,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
  tone?: TriageStatus;
}) {
  const activeRing = active
    ? tone === 'escalated'
      ? 'border-red-500/60 bg-red-500/15 text-red-300'
      : tone === 'acknowledged'
      ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
      : tone === 'dismissed'
      ? 'border-white/40 bg-white/10 text-white/80'
      : tone === 'open'
      ? 'border-[var(--accent)]/60 bg-[var(--accent)]/15 text-[var(--accent)]'
      : 'border-white/40 bg-white/10 text-white'
    : 'border-white/10 bg-[var(--bg-secondary)] text-white/60 hover:border-white/20 hover:text-white';
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${activeRing}`}
    >
      {label}
      <span className="font-[family-name:var(--font-geist-mono)] text-[10px] text-white/50">
        {count}
      </span>
    </Link>
  );
}

function TriageBadge({ status }: { status: TriageStatus }) {
  if (status === 'open') return null; // "Open" is the default — no need to clutter the row
  const styles: Record<TriageStatus, string> = {
    open: '',
    acknowledged: 'bg-amber-500/15 text-amber-300',
    dismissed: 'bg-white/10 text-white/50',
    escalated: 'bg-red-500/15 text-red-300',
  };
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${styles[status]}`}
    >
      {TRIAGE_LABEL[status]}
    </span>
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
    praise: 'bg-[var(--rag-green-bg)] text-[var(--rag-green)]',
    complaint: 'bg-[var(--rag-red-bg)] text-[var(--rag-red)]',
    recommendation_request: 'bg-[var(--accent)]/15 text-[var(--accent)]',
    neutral: 'bg-white/10 text-white/55',
  };
  const display = label === 'recommendation_request' ? 'rec request' : label;
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
      ? 'text-[var(--rag-green)]'
      : tone === 'red'
      ? 'text-[var(--rag-red)]'
      : tone === 'accent'
      ? 'text-[var(--accent)]'
      : 'text-white/60';
  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className={`mt-1 font-[family-name:var(--font-jakarta)] text-2xl font-bold ${color}`}>
        {value}
      </div>
    </div>
  );
}

