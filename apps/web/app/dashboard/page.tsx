import Link from 'next/link';
import Image from 'next/image';
import {
  Plus,
  Building2,
  Scale,
  Stethoscope,
  Megaphone,
  HelpCircle,
  Shield,
  Inbox,
  MessageSquare,
  DollarSign,
  AlertTriangle,
  FileX,
} from 'lucide-react';
import { listFirms, type FirmType } from '../actions/firm-actions';
import {
  getFirmHealthSnapshot,
  type FirmHealthRow,
} from '../actions/admin-actions';

export const dynamic = 'force-dynamic';

const FIRM_TYPE_LABEL: Record<FirmType, string> = {
  law_firm: 'Law Firm',
  dental_practice: 'Dental Practice',
  marketing_agency: 'Marketing Agency',
  other: 'Other',
};

const FIRM_TYPE_ICON: Record<FirmType, typeof Building2> = {
  law_firm: Scale,
  dental_practice: Stethoscope,
  marketing_agency: Megaphone,
  other: HelpCircle,
};

/**
 * Workspace client list.
 *
 * Two parallel fetches:
 *   1. listFirms()               — firm metadata (name, slug, firm_type)
 *   2. getFirmHealthSnapshot()   — one batched query returning actionable
 *                                  signals for every firm in the workspace
 *                                  (open tickets, open mentions, budget,
 *                                  audit error count, brand truth version,
 *                                  last audit, monthly report presence).
 *
 * Previously this page called getFirmSummary() in a per-firm loop. Swapping
 * to the batched snapshot gives us richer data with strictly fewer round
 * trips regardless of firm count, and lets us surface the "which client
 * needs attention" signals right on the card rather than making operators
 * drill in blindly.
 */
export default async function ClientListPage() {
  const [firms, snapshot] = await Promise.all([
    listFirms(),
    // Snapshot swallows into [] so a DB hiccup can't crash the whole list —
    // the cards degrade to "no health signal" but still render.
    getFirmHealthSnapshot().catch(() => [] as FirmHealthRow[]),
  ]);

  const snapshotBySlug = new Map(snapshot.map((s) => [s.slug, s]));
  const aggregate = computeAggregate(snapshot);

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      {/* Header */}
      <div className="mb-10 flex items-start justify-between">
        <div className="flex items-center">
          <Image
            src="/clixsy-logo.svg"
            alt="Clixsy"
            width={220}
            height={92}
            priority
          />
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard/admin"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[var(--bg-secondary)] px-4 py-2.5 text-sm font-medium text-white/75 transition-colors hover:border-white/20 hover:text-white"
            title="Workspace observability — cron health, firm triage, workspace spend"
          >
            <Shield size={16} strokeWidth={2} />
            Admin
          </Link>
          <Link
            href="/dashboard/new-client"
            className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)]"
          >
            <Plus size={16} strokeWidth={2} />
            Add Client
          </Link>
        </div>
      </div>

      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Clients
        </h1>
        <p className="mt-2 text-white/55">
          Pick a client to run audits, edit Brand Truth, or check Reddit sentiment.
        </p>
      </div>

      {/* Workspace aggregate strip — only when we have firms + some signal.
          Surfaces the counts worth acting on right now without forcing the
          operator to scan every card individually. Nothing here is clickable;
          it's a summary ribbon, not a dispatcher. Drill-through happens by
          picking a specific card. */}
      {firms.length > 0 && aggregate && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-[var(--bg-secondary)] px-5 py-3 text-xs text-white/70">
          <span className="text-[10px] font-medium uppercase tracking-widest text-white/40">
            Workspace
          </span>
          <AggregateChip
            icon={Inbox}
            label="open tickets"
            value={aggregate.openTickets}
            tone={aggregate.openTickets > 0 ? 'accent' : 'muted'}
          />
          <AggregateChip
            icon={MessageSquare}
            label="mentions to triage"
            value={aggregate.openMentions}
            tone={aggregate.openMentions > 0 ? 'accent' : 'muted'}
          />
          <AggregateChip
            icon={DollarSign}
            label="over budget"
            value={aggregate.overBudgetCount}
            tone={aggregate.overBudgetCount > 0 ? 'danger' : 'muted'}
          />
          <AggregateChip
            icon={AlertTriangle}
            label="audit errors (30d)"
            value={aggregate.auditErrors30d}
            tone={aggregate.auditErrors30d > 0 ? 'warning' : 'muted'}
          />
          <AggregateChip
            icon={FileX}
            label="brand truth missing"
            value={aggregate.missingBt}
            tone={aggregate.missingBt > 0 ? 'warning' : 'muted'}
          />
        </div>
      )}

      {/* Empty state */}
      {firms.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-[var(--bg-secondary)] py-20 text-center">
          <Building2 className="mb-4 h-12 w-12 text-white/20" strokeWidth={1.5} />
          <h2 className="mb-2 text-lg font-semibold text-white/60">No clients yet</h2>
          <p className="mb-6 max-w-md text-sm text-white/40">
            Add your first client to start monitoring their AI search visibility
            and brand alignment.
          </p>
          <Link
            href="/dashboard/new-client"
            className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)]"
          >
            <Plus size={16} strokeWidth={2} />
            Add Your First Client
          </Link>
        </div>
      )}

      {/* Client cards */}
      {firms.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {firms.map((firm) => (
            <ClientCard
              key={firm.id}
              firm={firm}
              health={snapshotBySlug.get(firm.slug) ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Aggregate strip ────────────────────────────────────────────

type Aggregate = {
  openTickets: number;
  openMentions: number;
  overBudgetCount: number;
  auditErrors30d: number;
  missingBt: number;
};

function computeAggregate(snapshot: FirmHealthRow[]): Aggregate | null {
  if (snapshot.length === 0) return null;
  const agg: Aggregate = {
    openTickets: 0,
    openMentions: 0,
    overBudgetCount: 0,
    auditErrors30d: 0,
    missingBt: 0,
  };
  for (const row of snapshot) {
    agg.openTickets += row.openTicketCount;
    agg.openMentions += row.openMentionCount;
    if (row.budget.overBudget) agg.overBudgetCount += 1;
    agg.auditErrors30d += row.lastAuditErrorCount30d;
    if (row.brandTruthVersion == null) agg.missingBt += 1;
  }
  return agg;
}

function AggregateChip({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Inbox;
  label: string;
  value: number;
  tone: 'accent' | 'warning' | 'danger' | 'muted';
}) {
  const toneClass =
    tone === 'danger'
      ? 'text-red-300'
      : tone === 'warning'
        ? 'text-amber-300'
        : tone === 'accent'
          ? 'text-[var(--accent)]'
          : 'text-white/40';
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon size={13} strokeWidth={1.75} className={toneClass} />
      <span className={`font-[family-name:var(--font-geist-mono)] font-semibold ${toneClass}`}>
        {value}
      </span>
      <span className="text-white/40">{label}</span>
    </span>
  );
}

// ─── Client card ────────────────────────────────────────────────

/**
 * Health priority (highest tone wins, visually shown as a single top-right dot):
 *
 *   over-budget       → danger   (scans paused — must act to resume)
 *   errors > 0        → warning  (signal broken)
 *   tickets > 0       → warning  (triage backlog)
 *   no brand truth    → warning  (can't audit without it)
 *   mentions > 0      → accent   (informational — work to do but not broken)
 *   otherwise         → null     (healthy)
 *
 * Keeping the dot single-tone (not a stack) lets the operator visually scan
 * the grid and pick out the worst firms without parsing a row of icons per
 * card.
 */
function resolveHealthDot(health: FirmHealthRow | null):
  | { tone: 'danger' | 'warning' | 'accent'; label: string }
  | null {
  if (!health) return null;
  if (health.budget.overBudget) {
    return {
      tone: 'danger',
      label: `over budget — audits paused (${health.budget.spentThisMonthUsd.toFixed(2)} of ${health.budget.monthlyCapUsd.toFixed(2)})`,
    };
  }
  if (health.lastAuditErrorCount30d > 0) {
    return {
      tone: 'warning',
      label: `${health.lastAuditErrorCount30d} audit error${health.lastAuditErrorCount30d === 1 ? '' : 's'} in last 30d`,
    };
  }
  if (health.openTicketCount > 0) {
    return {
      tone: 'warning',
      label: `${health.openTicketCount} open ticket${health.openTicketCount === 1 ? '' : 's'}`,
    };
  }
  if (health.brandTruthVersion == null) {
    return {
      tone: 'warning',
      label: 'Brand Truth not set — audits blocked',
    };
  }
  if (health.openMentionCount > 0) {
    return {
      tone: 'accent',
      label: `${health.openMentionCount} mention${health.openMentionCount === 1 ? '' : 's'} to triage`,
    };
  }
  return null;
}

function formatDate(d: Date | null | undefined) {
  if (!d) return 'never';
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function ClientCard({
  firm,
  health,
}: {
  firm: {
    id: string;
    slug: string;
    name: string;
    firm_type: FirmType;
  };
  health: FirmHealthRow | null;
}) {
  const Icon = FIRM_TYPE_ICON[firm.firm_type];
  const dot = resolveHealthDot(health);
  const dotClass =
    dot?.tone === 'danger'
      ? 'bg-red-400'
      : dot?.tone === 'warning'
        ? 'bg-amber-400'
        : dot?.tone === 'accent'
          ? 'bg-[var(--accent)]'
          : '';

  const budgetPct =
    health?.budget && health.budget.monthlyCapUsd > 0
      ? Math.round(health.budget.utilizationPct)
      : null;

  const budgetTone: 'danger' | 'warning' | 'normal' = health?.budget.overBudget
    ? 'danger'
    : budgetPct != null && budgetPct >= 90
      ? 'warning'
      : 'normal';

  const budgetClass =
    budgetTone === 'danger'
      ? 'border-red-500/30 text-red-300'
      : budgetTone === 'warning'
        ? 'border-amber-500/30 text-amber-300'
        : 'border-white/10 text-white/55';

  return (
    <Link
      href={`/dashboard/${firm.slug}`}
      className="group relative flex flex-col gap-4 rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-6 transition-colors hover:border-[var(--accent)]/30"
    >
      {/* Top-right health dot — single-tone, title-tooltip for context */}
      {dot && (
        <span
          title={dot.label}
          className={`absolute right-4 top-4 inline-block h-2 w-2 rounded-full ${dotClass}`}
        />
      )}

      <div className="flex items-start justify-between">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/5">
          <Icon size={20} strokeWidth={1.5} className="text-[var(--accent)]" />
        </div>
        <span className="rounded-full border border-white/10 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/55">
          {FIRM_TYPE_LABEL[firm.firm_type]}
        </span>
      </div>

      <div>
        <h2 className="font-[family-name:var(--font-jakarta)] text-lg font-bold text-white group-hover:text-[var(--accent)]">
          {firm.name}
        </h2>
        <p className="mt-1 font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
          /{firm.slug}
        </p>
      </div>

      {/* Health pills — tickets + mentions + budget. Rendered as pills rather
          than a second stat grid so they read as "actionable" vs the more
          neutral "last known" stats below. Mentions pill hidden when zero to
          keep the row concise for healthy firms. */}
      {health && (
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-[family-name:var(--font-geist-mono)] ${
              health.openTicketCount > 0
                ? 'border-[var(--accent)]/30 text-[var(--accent)]'
                : 'border-white/10 text-white/40'
            }`}
            title="Open remediation tickets (audit / legacy / entity / reddit)"
          >
            <Inbox size={10} strokeWidth={2} />
            {health.openTicketCount} open
          </span>
          {health.openMentionCount > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)]/30 px-2 py-0.5 font-[family-name:var(--font-geist-mono)] text-[var(--accent)]"
              title="Reddit mentions awaiting triage"
            >
              <MessageSquare size={10} strokeWidth={2} />
              {health.openMentionCount} to triage
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-[family-name:var(--font-geist-mono)] ${budgetClass}`}
            title={
              budgetTone === 'danger'
                ? 'Over monthly LLM cap — scans paused'
                : budgetTone === 'warning'
                  ? 'Within 10% of monthly LLM cap'
                  : 'Monthly LLM spend'
            }
          >
            <DollarSign size={10} strokeWidth={2} />
            {budgetPct != null ? `${budgetPct}%` : '—'}
          </span>
        </div>
      )}

      {/* Last-known stats — neutral tone, complements the health pills above */}
      <div className="mt-auto grid grid-cols-2 gap-3 border-t border-white/5 pt-4 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-white/40">
            Brand Truth
          </div>
          <div className="mt-0.5 text-white/70">
            {health?.brandTruthVersion
              ? `v${health.brandTruthVersion}`
              : 'not set'}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-white/40">
            Last Audit
          </div>
          <div className="mt-0.5 text-white/70">
            {formatDate(health?.lastAudit?.startedAt ?? null)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-white/40">
            Report
          </div>
          <div className="mt-0.5 text-white/70">
            {health?.monthlyReportGenerated ? '✓ this month' : '—'}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-white/40">
            Errors 30d
          </div>
          <div
            className={`mt-0.5 ${
              (health?.lastAuditErrorCount30d ?? 0) > 0
                ? 'text-red-300'
                : 'text-white/70'
            }`}
          >
            {health?.lastAuditErrorCount30d ?? 0}
          </div>
        </div>
      </div>
    </Link>
  );
}
