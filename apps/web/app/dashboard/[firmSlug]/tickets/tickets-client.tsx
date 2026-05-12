'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ClipboardCheck,
  FileX,
  MessageSquare,
  Database,
  ExternalLink,
  CheckCircle2,
  Circle,
  CircleDashed,
  RotateCcw,
  AlertTriangle,
  Inbox,
} from 'lucide-react';
import {
  updateTicketStatus,
  bulkCloseBySource,
  type RemediationTicketRow,
  type TicketStats,
} from '../../../actions/remediation-actions';
import {
  TICKET_SOURCES,
  TICKET_STATUSES,
  type TicketSource,
  type TicketStatus,
} from '../../../actions/remediation-constants';

export function TicketsClient({
  firmSlug,
  initialTickets,
  stats,
  activeStatus,
  activeSource,
}: {
  firmSlug: string;
  initialTickets: RemediationTicketRow[];
  stats: TicketStats;
  activeStatus: TicketStatus | null;
  activeSource: TicketSource | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Optimistic status flips — the server revalidates + router.refresh()
  // reconciles afterward, but the row should respond instantly.
  const [optimistic, setOptimistic] = useState<Map<string, TicketStatus>>(
    () => new Map(),
  );
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [bulkSource, setBulkSource] = useState<TicketSource | null>(null);

  const handleUpdate = (ticketId: string, nextStatus: TicketStatus) => {
    setError(null);
    setOptimistic((prev) => {
      const next = new Map(prev);
      next.set(ticketId, nextStatus);
      return next;
    });
    setPendingId(ticketId);
    startTransition(async () => {
      const result = await updateTicketStatus(firmSlug, ticketId, nextStatus);
      if ('error' in result) {
        setError(result.error);
        setOptimistic((prev) => {
          const next = new Map(prev);
          next.delete(ticketId);
          return next;
        });
      } else {
        router.refresh();
      }
      setPendingId(null);
    });
  };

  const handleBulkClose = (source: TicketSource) => {
    setError(null);
    setBulkSource(source);
    startTransition(async () => {
      const result = await bulkCloseBySource(firmSlug, source);
      if ('error' in result) {
        setError(result.error);
      } else {
        router.refresh();
      }
      setBulkSource(null);
    });
  };

  const tickets = useMemo(
    () =>
      initialTickets.map((t) => ({
        ...t,
        status: optimistic.get(t.id) ?? t.status,
      })),
    [initialTickets, optimistic],
  );

  const openCount = stats.byStatus.open + stats.byStatus.in_progress;

  return (
    <div>
      {/* Stats strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total" value={stats.total} tone="gray" />
        <StatCard label="Open" value={stats.byStatus.open} tone="accent" />
        <StatCard
          label="In progress"
          value={stats.byStatus.in_progress}
          tone="amber"
        />
        <StatCard
          label="Overdue"
          value={stats.openOverdue}
          tone={stats.openOverdue > 0 ? 'red' : 'gray'}
        />
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/15 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Status filter pills */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <FilterPill
          href={buildHref(firmSlug, { source: activeSource })}
          label="All"
          count={stats.total}
          active={activeStatus === null}
        />
        {TICKET_STATUSES.map((s) => (
          <FilterPill
            key={s}
            href={buildHref(firmSlug, { status: s, source: activeSource })}
            label={STATUS_LABEL[s]}
            count={stats.byStatus[s]}
            active={activeStatus === s}
            tone={s}
          />
        ))}
      </div>

      {/* Source filter pills */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <SourcePill
          href={buildHref(firmSlug, { status: activeStatus })}
          label="All sources"
          active={activeSource === null}
        />
        {TICKET_SOURCES.map((src) => (
          <SourcePill
            key={src}
            href={buildHref(firmSlug, { status: activeStatus, source: src })}
            label={SOURCE_LABEL[src]}
            icon={SOURCE_ICON[src]}
            count={stats.bySource[src]}
            active={activeSource === src}
          />
        ))}
        {activeSource && openCount > 0 && (
          <button
            onClick={() => handleBulkClose(activeSource)}
            disabled={isPending}
            className="ml-auto rounded-full border border-white/10 bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:border-white/20 hover:text-white disabled:opacity-50"
            title={`Close every open or in-progress ${SOURCE_LABEL[activeSource]} ticket`}
          >
            {bulkSource === activeSource
              ? 'Closing...'
              : `Close all ${SOURCE_LABEL[activeSource]}`}
          </button>
        )}
      </div>

      {/* Per-source explainer — surfaces only when a specific source filter
          is active so the operator knows what the underlying scanner is
          flagging and what the typical action is. */}
      {activeSource && <SourceExplainer source={activeSource} />}

      {/* Ticket list */}
      <div className="mt-6 flex flex-col gap-2">
        {tickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Inbox className="mb-4 h-12 w-12 text-white/20" strokeWidth={1.5} />
            <h3 className="mb-2 text-lg font-semibold text-white/60">
              {activeStatus || activeSource
                ? 'No tickets match this filter'
                : 'No tickets yet'}
            </h3>
            <p className="mb-6 max-w-md text-sm text-white/40">
              {activeStatus || activeSource
                ? 'Try a different status or source filter.'
                : 'Scanners create tickets automatically. Run an audit, legacy scan, entity check, or Reddit scan to populate this queue.'}
            </p>
          </div>
        ) : (
          tickets.map((t) => (
            <TicketRow
              key={t.id}
              ticket={t}
              pending={pendingId === t.id}
              onUpdate={(next) => handleUpdate(t.id, next)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────

function TicketRow({
  ticket,
  pending,
  onUpdate,
}: {
  ticket: RemediationTicketRow;
  pending: boolean;
  onUpdate: (next: TicketStatus) => void;
}) {
  const isClosed = ticket.status === 'closed';
  const borderClass = isClosed
    ? 'border-white/5 opacity-60'
    : ticket.overdue
    ? 'border-red-500/30'
    : ticket.status === 'in_progress'
    ? 'border-amber-500/30'
    : 'border-white/10 hover:border-white/20';

  return (
    <div
      className={`group flex flex-col gap-3 rounded-xl border bg-[var(--bg-secondary)] px-5 py-4 transition-colors ${borderClass}`}
    >
      {/* Header row: source badge + status + meta */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge source={ticket.sourceType} />
            <StatusBadge status={ticket.status} />
            {ticket.automationTier && <TierBadge tier={ticket.automationTier} />}
            {ticket.priorityRank != null && (
              <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-[family-name:var(--font-geist-mono)] text-[10px] font-semibold uppercase tracking-wider text-white/65">
                #{ticket.priorityRank}
              </span>
            )}
            {ticket.overdue && !isClosed && (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-red-300">
                <AlertTriangle size={10} strokeWidth={2.5} />
                Overdue
              </span>
            )}
            {ticket.owner && (
              <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
                @{ticket.owner}
              </span>
            )}
            {/*
              `toLocaleDateString` is locale + TZ sensitive: a UTC timestamp
              near midnight prints a different calendar day on the server
              (UTC) vs the client (local), which throws hydration mismatches.
              `suppressHydrationWarning` is the React-blessed escape hatch for
              this exact case — the client value is the one we actually want.
            */}
            <span
              className="font-[family-name:var(--font-geist-mono)] text-xs text-white/30"
              suppressHydrationWarning
            >
              {new Date(ticket.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
            {ticket.dueAt && !isClosed && (
              <span
                className={`font-[family-name:var(--font-geist-mono)] text-xs ${
                  ticket.overdue ? 'text-red-400' : 'text-white/40'
                }`}
                suppressHydrationWarning
              >
                Due {new Date(ticket.dueAt).toLocaleDateString()}
              </span>
            )}
          </div>

          {/* Playbook step — the system's suggested action */}
          {ticket.playbookStep && (
            <p className="mt-2 font-[family-name:var(--font-geist-mono)] text-xs text-white/70">
              {ticket.playbookStep}
            </p>
          )}

          {/* Source-specific context */}
          <TicketContext context={ticket.context} />
        </div>
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
        {ticket.status === 'open' && (
          <>
            <ActionButton
              icon={<Circle size={12} strokeWidth={2} />}
              label="Start"
              onClick={() => onUpdate('in_progress')}
              disabled={pending}
              tone="amber"
            />
            <ActionButton
              icon={<CheckCircle2 size={12} strokeWidth={2} />}
              label="Close"
              onClick={() => onUpdate('closed')}
              disabled={pending}
              tone="green"
            />
          </>
        )}
        {ticket.status === 'in_progress' && (
          <>
            <ActionButton
              icon={<CheckCircle2 size={12} strokeWidth={2} />}
              label="Close"
              onClick={() => onUpdate('closed')}
              disabled={pending}
              tone="green"
            />
            <ActionButton
              icon={<CircleDashed size={12} strokeWidth={2} />}
              label="Reopen"
              onClick={() => onUpdate('open')}
              disabled={pending}
              tone="gray"
            />
          </>
        )}
        {ticket.status === 'closed' && (
          <ActionButton
            icon={<RotateCcw size={12} strokeWidth={2} />}
            label="Reopen"
            onClick={() => onUpdate('open')}
            disabled={pending}
            tone="gray"
          />
        )}
      </div>
    </div>
  );
}

function TicketContext({ context }: { context: RemediationTicketRow['context'] }) {
  if (context.kind === 'audit') {
    return (
      <div className="mt-2 space-y-1">
        {context.queryText && (
          <p className="text-sm text-white/80">“{context.queryText}”</p>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {context.ragLabel && (
            <span
              className={`rounded-full px-2.5 py-0.5 font-medium uppercase tracking-wider ${
                context.ragLabel.toLowerCase() === 'red'
                  ? 'bg-[var(--rag-red-bg)] text-[var(--rag-red)]'
                  : context.ragLabel.toLowerCase() === 'amber'
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-[var(--rag-green-bg)] text-[var(--rag-green)]'
              }`}
            >
              {context.ragLabel}
            </span>
          )}
          {context.gapReasons.slice(0, 3).map((reason, i) => (
            <span
              key={i}
              className="rounded-full bg-white/5 px-2 py-0.5 text-white/60"
            >
              {reason}
            </span>
          ))}
        </div>
      </div>
    );
  }
  if (context.kind === 'legacy') {
    return (
      <div className="mt-2 space-y-1">
        {context.pageUrl && (
          <a
            href={context.pageUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-[var(--accent)] hover:underline"
          >
            {shortenUrl(context.pageUrl)}
            <ExternalLink size={11} strokeWidth={2} />
          </a>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {context.action && (
            <span className="rounded-full bg-white/10 px-2.5 py-0.5 font-medium uppercase tracking-wider text-white/70">
              {context.action}
            </span>
          )}
          {context.rationale && (
            <span className="text-white/55">{context.rationale}</span>
          )}
        </div>
      </div>
    );
  }
  if (context.kind === 'reddit') {
    return (
      <div className="mt-2 space-y-1">
        {context.text && <p className="text-sm text-white/80">{context.text}</p>}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {context.subreddit && (
            <span className="font-[family-name:var(--font-geist-mono)] text-white/55">
              r/{context.subreddit}
            </span>
          )}
          {context.sentiment && (
            <span
              className={`rounded-full px-2 py-0.5 font-medium ${
                context.sentiment === 'complaint'
                  ? 'bg-[var(--rag-red-bg)] text-[var(--rag-red)]'
                  : context.sentiment === 'praise'
                  ? 'bg-[var(--rag-green-bg)] text-[var(--rag-green)]'
                  : 'bg-white/10 text-white/55'
              }`}
            >
              {context.sentiment}
            </span>
          )}
          {context.url && (
            <a
              href={context.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
            >
              View thread
              <ExternalLink size={10} strokeWidth={2} />
            </a>
          )}
        </div>
      </div>
    );
  }
  if (context.kind === 'entity' || context.kind === 'unknown') {
    return <p className="mt-2 text-xs text-white/50">{context.note}</p>;
  }
  return null;
}

// ── Shared pieces ───────────────────────────────────────────

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'green' | 'red' | 'amber' | 'accent' | 'gray';
}) {
  const color = {
    green: 'text-[var(--rag-green)]',
    red: 'text-[var(--rag-red)]',
    amber: 'text-amber-300',
    accent: 'text-[var(--accent)]',
    gray: 'text-white/80',
  }[tone];
  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] px-4 py-3">
      <div className="font-[family-name:var(--font-geist-mono)] text-[10px] uppercase tracking-widest text-white/40">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

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
  tone?: TicketStatus;
}) {
  const activeRing = active
    ? tone === 'open'
      ? 'border-[var(--accent)]/60 bg-[var(--accent)]/15 text-[var(--accent)]'
      : tone === 'in_progress'
      ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
      : tone === 'closed'
      ? 'border-white/40 bg-white/10 text-white/80'
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

function SourcePill({
  href,
  label,
  count,
  active,
  icon: Icon,
}: {
  href: string;
  label: string;
  count?: number;
  active: boolean;
  icon?: typeof ClipboardCheck;
}) {
  const activeRing = active
    ? 'border-white/40 bg-white/10 text-white'
    : 'border-white/5 bg-transparent text-white/45 hover:border-white/15 hover:text-white/80';
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${activeRing}`}
    >
      {Icon && <Icon size={11} strokeWidth={2} />}
      {label}
      {typeof count === 'number' && (
        <span className="font-[family-name:var(--font-geist-mono)] text-[10px] text-white/50">
          {count}
        </span>
      )}
    </Link>
  );
}

function SourceBadge({ source }: { source: TicketSource }) {
  const Icon = SOURCE_ICON[source];
  const color = {
    audit: 'bg-[var(--accent)]/15 text-[var(--accent)]',
    legacy: 'bg-purple-500/15 text-purple-300',
    reddit: 'bg-orange-500/15 text-orange-300',
    entity: 'bg-cyan-500/15 text-cyan-300',
  }[source];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${color}`}
    >
      <Icon size={10} strokeWidth={2.5} />
      {SOURCE_LABEL[source]}
    </span>
  );
}

function StatusBadge({ status }: { status: TicketStatus }) {
  const styles: Record<TicketStatus, string> = {
    open: 'bg-[var(--accent)]/15 text-[var(--accent)]',
    in_progress: 'bg-amber-500/15 text-amber-300',
    closed: 'bg-white/10 text-white/50',
  };
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${styles[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Execution-tier badge (column added in migration 0014). Driven by the
 * platform-write-API research:
 *   - auto   = green: tool fixes via API (Wikidata, GBP, CMS w/ creds)
 *   - assist = yellow: tool drafted copy, operator pastes on platform
 *   - manual = red: policy/TOS/human-only (Wikipedia COI, LinkedIn TOS,
 *              SME interview, sales call)
 */
function TierBadge({ tier }: { tier: 'auto' | 'assist' | 'manual' }) {
  const styles: Record<typeof tier, { label: string; cls: string }> = {
    auto: {
      label: 'Auto',
      cls: 'bg-[var(--rag-green)]/15 text-[var(--rag-green)]',
    },
    assist: {
      label: 'Assist',
      cls: 'bg-[var(--rag-yellow-bg)] text-[var(--rag-yellow)]',
    },
    manual: {
      label: 'Manual',
      cls: 'bg-[var(--rag-red-bg)] text-[var(--rag-red)]',
    },
  };
  const s = styles[tier];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

function ActionButton({
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
  tone: 'green' | 'amber' | 'gray';
}) {
  const styles = {
    green:
      'border-green-500/20 text-green-300 hover:bg-green-500/10 hover:border-green-500/40',
    amber:
      'border-amber-500/20 text-amber-300 hover:bg-amber-500/10 hover:border-amber-500/40',
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

// ── Helpers ─────────────────────────────────────────────────

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  closed: 'Closed',
};

const SOURCE_LABEL: Record<TicketSource, string> = {
  audit: 'Audit',
  legacy: 'Legacy',
  reddit: 'Reddit',
  entity: 'Entity',
};

// Operator explainer for each source — what kind of finding lands in
// this filter and what action it usually wants. Renders below the filter
// row when a source is active.
const SOURCE_EXPLAINER: Record<TicketSource, string> = {
  audit:
    'Findings from Trust Alignment Audits — LLM answers that contradicted Brand Truth (banned claim, hallucinated fact, drifted positioning). Typical action: approve a rewrite draft or flag the source the LLM was using.',
  legacy:
    'Findings from the Legacy Content Suppression scan — pages on the firm\'s site whose copy diverges from Brand Truth (semantic distance > 0.55). Typical action: noindex, 301-redirect to the closest aligned page, or rewrite.',
  reddit:
    'Findings from Reddit sentiment scans — high-karma negative mentions or recurring questions where the firm or its competitors are named. Typical action: triage and decide whether to engage on-thread or surface to client comms.',
  entity:
    'Findings from the Entity & Structured Signals scan — schema gaps, Wikidata absence, or Knowledge Graph misses on the home page. Typical action: ship the JSON-LD patch, claim Google Business Profile, or open a Wikidata entry.',
};

function SourceExplainer({ source }: { source: TicketSource }) {
  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-[var(--bg-secondary)]/60 p-4">
      <p className="text-sm leading-relaxed text-white/75">
        <span className="font-medium text-white">{SOURCE_LABEL[source]} tickets. </span>
        {SOURCE_EXPLAINER[source]}
      </p>
    </div>
  );
}

const SOURCE_ICON: Record<TicketSource, typeof ClipboardCheck> = {
  audit: ClipboardCheck,
  legacy: FileX,
  reddit: MessageSquare,
  entity: Database,
};

function buildHref(
  firmSlug: string,
  opts: { status?: TicketStatus | null; source?: TicketSource | null },
): string {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.source) params.set('source', opts.source);
  const qs = params.toString();
  return `/dashboard/${firmSlug}/tickets${qs ? `?${qs}` : ''}`;
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    const trimmed = `${u.host}${path}`;
    return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  } catch {
    return url;
  }
}
