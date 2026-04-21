'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  ChevronDown,
  ExternalLink,
  MessageSquare,
  ClipboardCheck,
  Inbox,
} from 'lucide-react';
import {
  updateTicketStatus,
  updateTicketOwner,
  type TicketRow,
  type TicketStatus,
} from '../../../actions/remediation-actions';

type Filter = 'open' | 'in_progress' | 'done' | 'wont_fix' | 'all';

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  done: 'Done',
  wont_fix: "Won't Fix",
};

const STATUS_STYLE: Record<TicketStatus, string> = {
  open: 'bg-[--rag-red-bg] text-[--rag-red]',
  in_progress: 'bg-[--accent]/15 text-[--accent]',
  done: 'bg-[--rag-green-bg] text-[--rag-green]',
  wont_fix: 'bg-white/10 text-white/55',
};

const STATUS_ORDER: TicketStatus[] = ['open', 'in_progress', 'done', 'wont_fix'];

export function RemediationListClient({
  firmSlug,
  initialTickets,
}: {
  firmSlug: string;
  initialTickets: TicketRow[];
}) {
  const [filter, setFilter] = useState<Filter>('open');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Client-side counts so filter chips always reflect current list size.
  const counts = useMemo(() => {
    const acc: Record<TicketStatus, number> = {
      open: 0,
      in_progress: 0,
      done: 0,
      wont_fix: 0,
    };
    for (const t of initialTickets) acc[t.status]++;
    return acc;
  }, [initialTickets]);
  const total = initialTickets.length;

  const filtered =
    filter === 'all' ? initialTickets : initialTickets.filter((t) => t.status === filter);

  return (
    <div>
      {/* Stat strip */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STATUS_ORDER.map((s) => (
          <StatCard key={s} label={STATUS_LABEL[s]} value={counts[s]} status={s} />
        ))}
      </div>

      {/* Filter chips */}
      <div className="mb-4 flex flex-wrap gap-2">
        {(['open', 'in_progress', 'done', 'wont_fix', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-4 py-1.5 text-xs font-medium uppercase tracking-wider transition-colors ${
              filter === f
                ? 'bg-white/10 text-white'
                : 'text-white/40 hover:text-white/70'
            }`}
          >
            {f === 'all'
              ? `All (${total})`
              : `${STATUS_LABEL[f as TicketStatus]} (${counts[f as TicketStatus]})`}
          </button>
        ))}
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-[--bg-secondary] py-16 text-center">
          <Inbox className="mb-4 h-10 w-10 text-white/20" strokeWidth={1.5} />
          <p className="text-sm text-white/55">
            {filter === 'open' || filter === 'all'
              ? 'No tickets yet. Run an audit or Reddit scan — red findings open tickets automatically.'
              : `No ${STATUS_LABEL[filter as TicketStatus].toLowerCase()} tickets.`}
          </p>
        </div>
      )}

      {/* Ticket list */}
      <div className="flex flex-col gap-2">
        {filtered.map((t) => (
          <TicketCard
            key={t.id}
            firmSlug={firmSlug}
            ticket={t}
            expanded={expandedId === t.id}
            onToggleExpand={() =>
              setExpandedId((prev) => (prev === t.id ? null : t.id))
            }
          />
        ))}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  status,
}: {
  label: string;
  value: number;
  status: TicketStatus;
}) {
  const color =
    status === 'open'
      ? 'text-[--rag-red]'
      : status === 'in_progress'
      ? 'text-[--accent]'
      : status === 'done'
      ? 'text-[--rag-green]'
      : 'text-white/60';
  return (
    <div className="rounded-xl border border-white/10 bg-[--bg-secondary] px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div
        className={`mt-1 font-[family-name:var(--font-jakarta)] text-2xl font-bold ${color}`}
      >
        {value}
      </div>
    </div>
  );
}

function TicketCard({
  firmSlug,
  ticket,
  expanded,
  onToggleExpand,
}: {
  firmSlug: string;
  ticket: TicketRow;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<TicketStatus>(ticket.status);
  const [owner, setOwner] = useState(ticket.owner ?? '');
  const [ownerSaved, setOwnerSaved] = useState(ticket.owner ?? '');
  const [error, setError] = useState<string | null>(null);

  const handleStatusChange = (next: TicketStatus) => {
    setError(null);
    const prev = status;
    setStatus(next); // optimistic
    startTransition(async () => {
      const result = await updateTicketStatus({
        firmSlug,
        ticketId: ticket.id,
        status: next,
      });
      if (!result.ok) {
        setStatus(prev);
        setError(result.error);
      }
    });
  };

  const handleOwnerBlur = () => {
    if (owner === ownerSaved) return;
    setError(null);
    startTransition(async () => {
      const result = await updateTicketOwner({
        firmSlug,
        ticketId: ticket.id,
        owner,
      });
      if (!result.ok) {
        setError(result.error);
      } else {
        setOwnerSaved(owner);
      }
    });
  };

  const isAudit = ticket.sourceType === 'audit' || ticket.sourceType === 'alignment';
  const isReddit = ticket.sourceType === 'reddit';
  const SourceIcon = isReddit ? MessageSquare : ClipboardCheck;
  const headline =
    ticket.audit?.queryText ??
    (ticket.reddit ? `r/${ticket.reddit.subreddit} — ${ticket.reddit.sentiment ?? 'mention'}` : 'Ticket');
  const subline = isAudit
    ? ticket.audit?.responsePreview.slice(0, 160)
    : ticket.reddit?.text?.slice(0, 160);
  const dueStr = ticket.dueAt
    ? `due ${new Date(ticket.dueAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })}`
    : null;

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[--bg-secondary]">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleExpand();
          }
        }}
        className="flex cursor-pointer items-start gap-4 px-5 py-4 transition-colors hover:bg-white/[0.02]"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5">
          <SourceIcon size={16} strokeWidth={1.5} className="text-[--accent]" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-3 py-0.5 text-[10px] font-medium uppercase tracking-wider ${STATUS_STYLE[status]}`}
            >
              {STATUS_LABEL[status]}
            </span>
            <span className="font-[family-name:var(--font-geist-mono)] text-[10px] uppercase tracking-wider text-white/40">
              {isReddit ? 'reddit' : 'audit'}
            </span>
            {ticket.playbookStep && (
              <span className="font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40">
                · {ticket.playbookStep}
              </span>
            )}
            {dueStr && (
              <span className="font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40">
                · {dueStr}
              </span>
            )}
          </div>
          <p className="mt-1.5 truncate text-sm font-medium text-white/90">
            {headline}
          </p>
          {subline && (
            <p className="mt-0.5 line-clamp-1 text-xs text-white/50">{subline}</p>
          )}
        </div>

        <ChevronDown
          size={16}
          strokeWidth={1.5}
          className={`mt-2 shrink-0 text-white/30 transition-transform ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </div>

      {expanded && (
        <div className="border-t border-white/5 bg-black/20 p-6">
          {/* Controls row */}
          <div className="mb-5 flex flex-wrap items-end gap-4">
            <div>
              <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-widest text-white/55">
                Status
              </label>
              <select
                value={status}
                onChange={(e) => handleStatusChange(e.target.value as TicketStatus)}
                disabled={isPending}
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white focus:border-[--accent] focus:outline-none disabled:opacity-50"
              >
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-widest text-white/55">
                Owner
              </label>
              <input
                type="text"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                onBlur={handleOwnerBlur}
                placeholder="unassigned"
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[--accent] focus:outline-none"
              />
            </div>
            <div className="ml-auto font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40">
              opened {new Date(ticket.createdAt).toLocaleString()}
            </div>
          </div>

          {error && (
            <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/15 px-4 py-2.5 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Audit detail */}
          {isAudit && ticket.audit && (
            <div className="space-y-4">
              <div>
                <span className="text-[10px] font-medium uppercase tracking-widest text-white/55">
                  Query
                </span>
                <p className="mt-1 text-sm text-white/80">{ticket.audit.queryText}</p>
              </div>

              <div className="flex flex-wrap gap-4 text-xs text-white/50">
                <span>
                  {ticket.audit.mentioned ? 'Mentioned' : 'Not mentioned'}
                </span>
                <span>
                  Tone:{' '}
                  {ticket.audit.toneScore !== null
                    ? `${ticket.audit.toneScore}/10`
                    : '—'}
                </span>
                <span className="uppercase">{ticket.audit.ragLabel}</span>
              </div>

              <div>
                <span className="text-[10px] font-medium uppercase tracking-widest text-white/55">
                  Model response
                </span>
                <p className="mt-1 max-h-48 overflow-y-auto rounded-lg bg-black/30 p-3 font-[family-name:var(--font-geist-mono)] text-xs leading-relaxed text-white/70">
                  {ticket.audit.responsePreview || '(no response captured)'}
                </p>
              </div>

              {ticket.audit.gapReasons.length > 0 && (
                <div>
                  <span className="text-[10px] font-medium uppercase tracking-widest text-white/55">
                    Gap reasons
                  </span>
                  <ul className="mt-1 list-inside list-disc text-sm text-[--rag-yellow]">
                    {ticket.audit.gapReasons.map((g, i) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </div>
              )}

              {ticket.audit.factualErrors.length > 0 && (
                <div>
                  <span className="text-[10px] font-medium uppercase tracking-widest text-white/55">
                    Factual errors
                  </span>
                  <ul className="mt-1 list-inside list-disc text-sm text-[--rag-red]">
                    {ticket.audit.factualErrors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}

              <Link
                href={`/dashboard/${firmSlug}/audits/${ticket.audit.auditRunId}`}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-[--accent] hover:underline"
              >
                View full audit run
                <ExternalLink size={14} strokeWidth={2} />
              </Link>
            </div>
          )}

          {/* Reddit detail */}
          {isReddit && ticket.reddit && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-4 text-xs text-white/50">
                <span className="font-[family-name:var(--font-geist-mono)]">
                  r/{ticket.reddit.subreddit}
                </span>
                {ticket.reddit.author && (
                  <span className="font-[family-name:var(--font-geist-mono)]">
                    u/{ticket.reddit.author}
                  </span>
                )}
                <span>{ticket.reddit.karma ?? 0} karma</span>
                <span className="uppercase">{ticket.reddit.sentiment ?? '—'}</span>
                {ticket.reddit.postedAt && (
                  <span>
                    {new Date(ticket.reddit.postedAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                )}
              </div>

              {ticket.reddit.text && (
                <div>
                  <span className="text-[10px] font-medium uppercase tracking-widest text-white/55">
                    Post
                  </span>
                  <p className="mt-1 max-h-48 overflow-y-auto rounded-lg bg-black/30 p-3 text-sm leading-relaxed text-white/70">
                    {ticket.reddit.text}
                  </p>
                </div>
              )}

              <a
                href={ticket.reddit.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-[--accent] hover:underline"
              >
                Open on Reddit
                <ExternalLink size={14} strokeWidth={2} />
              </a>
            </div>
          )}

          {!isAudit && !isReddit && (
            <p className="text-sm text-white/50">
              Source type <code>{ticket.sourceType}</code> not yet wired for
              drill-down.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
