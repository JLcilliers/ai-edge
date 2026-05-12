'use server';

import {
  getDb,
  firms,
  remediationTickets,
  alignmentScores,
  consensusResponses,
  queries,
  pages,
  legacyFindings,
  redditMentions,
} from '@ai-edge/db';
import { and, eq, inArray, desc, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
// Runtime consts + type unions live in a sibling module so they can be
// shared with client components without violating Next 16's "use server"
// export rule (async functions only). Imports here are used for runtime
// validation in updateTicketStatus; re-exports to clients are at
// app/actions/remediation-constants.ts.
import {
  TICKET_SOURCES,
  TICKET_STATUSES,
  type TicketSource,
  type TicketStatus,
} from './remediation-constants';

/**
 * Unified remediation queue.
 *
 * `remediation_ticket` is a single append-only table written by four
 * scanners — audit (alignment-score red rows), legacy (suppression-scan
 * findings above threshold), entity (missing Google KG / BBB / etc.),
 * and reddit (karma ≥ 10 complaints). Each row stores `source_type` +
 * `source_id` and a human-readable `playbook_step`; this module joins
 * those pointers back to their source rows so the UI can show "why this
 * ticket exists" without the operator needing to jump between pages.
 *
 * Source-type → source_id mapping:
 *   audit   → alignment_score.id     (via consensus_response → query.text)
 *   legacy  → legacy_finding.id      (via page.url)
 *   reddit  → reddit_mention.id      (subreddit + text + permalink)
 *   entity  → audit_run.id           (entity scan — context is the
 *                                     playbook_step string itself)
 */

// TICKET_SOURCES, TICKET_STATUSES, TicketSource, TicketStatus moved to
// ./remediation-constants.ts (Next 16 "use server" export restriction).

export type RemediationTicketRow = {
  id: string;
  sourceType: TicketSource;
  sourceId: string;
  status: TicketStatus;
  playbookStep: string | null;
  owner: string | null;
  dueAt: Date | null;
  createdAt: Date;
  overdue: boolean;
  // Execution-tier prescription columns from migration 0014 — null on
  // legacy tickets, populated on scanner-produced tickets going forward.
  title: string | null;
  description: string | null;
  priorityRank: number | null;
  automationTier: 'auto' | 'assist' | 'manual' | null;
  executeUrl: string | null;
  executeLabel: string | null;
  manualReason: string | null;
  remediationCopy: string | null;
  /**
   * Human-readable context resolved from the source row. Shape depends on
   * sourceType — the UI renders per-type but each variant is small and
   * self-contained so we don't need four separate return types.
   */
  context:
    | { kind: 'audit'; queryText: string | null; ragLabel: string | null; gapReasons: string[] }
    | { kind: 'legacy'; pageUrl: string | null; action: string | null; rationale: string | null }
    | {
        kind: 'reddit';
        subreddit: string | null;
        text: string | null;
        url: string | null;
        sentiment: string | null;
      }
    | { kind: 'entity'; note: string }
    | { kind: 'unknown'; note: string };
};

async function resolveFirmId(slug: string): Promise<string> {
  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id })
    .from(firms)
    .where(eq(firms.slug, slug))
    .limit(1);
  if (!firm) throw new Error(`Firm not found: ${slug}`);
  return firm.id;
}

function normalizeSource(raw: string | null | undefined): TicketSource {
  if (raw && (TICKET_SOURCES as readonly string[]).includes(raw)) {
    return raw as TicketSource;
  }
  // Legacy rows written as 'alignment' before we pinned the vocab — treat as audit.
  if (raw === 'alignment') return 'audit';
  return 'audit';
}

function normalizeStatus(raw: string | null | undefined): TicketStatus {
  if (raw && (TICKET_STATUSES as readonly string[]).includes(raw)) {
    return raw as TicketStatus;
  }
  return 'open';
}

/**
 * Batched context lookup for a set of tickets. We run one query per
 * source type — each returns at most O(tickets) rows — then splice the
 * results back into a Map keyed by source_id. Avoids the N+1 trap of
 * joining against every source table in the list query itself (which
 * drizzle's typechecker doesn't love on four different joined shapes).
 */
async function loadContexts(
  tickets: Array<{ sourceType: TicketSource; sourceId: string }>,
): Promise<Map<string, RemediationTicketRow['context']>> {
  const db = getDb();
  const contexts = new Map<string, RemediationTicketRow['context']>();

  const byType = new Map<TicketSource, string[]>();
  for (const t of tickets) {
    const list = byType.get(t.sourceType) ?? [];
    list.push(t.sourceId);
    byType.set(t.sourceType, list);
  }

  const auditIds = byType.get('audit') ?? [];
  const legacyIds = byType.get('legacy') ?? [];
  const redditIds = byType.get('reddit') ?? [];
  const entityIds = byType.get('entity') ?? [];

  const [auditRows, legacyRows, redditRows] = await Promise.all([
    auditIds.length > 0
      ? db
          .select({
            id: alignmentScores.id,
            ragLabel: alignmentScores.rag_label,
            gapReasons: alignmentScores.gap_reasons,
            queryText: queries.text,
          })
          .from(alignmentScores)
          .innerJoin(
            consensusResponses,
            eq(consensusResponses.id, alignmentScores.consensus_response_id),
          )
          .innerJoin(queries, eq(queries.id, consensusResponses.query_id))
          .where(inArray(alignmentScores.id, auditIds))
      : Promise.resolve([]),
    legacyIds.length > 0
      ? db
          .select({
            id: legacyFindings.id,
            action: legacyFindings.action,
            rationale: legacyFindings.rationale,
            pageUrl: pages.url,
          })
          .from(legacyFindings)
          .innerJoin(pages, eq(pages.id, legacyFindings.page_id))
          .where(inArray(legacyFindings.id, legacyIds))
      : Promise.resolve([]),
    redditIds.length > 0
      ? db
          .select({
            id: redditMentions.id,
            subreddit: redditMentions.subreddit,
            text: redditMentions.text,
            url: redditMentions.url,
            sentiment: redditMentions.sentiment,
          })
          .from(redditMentions)
          .where(inArray(redditMentions.id, redditIds))
      : Promise.resolve([]),
  ]);

  for (const r of auditRows) {
    contexts.set(r.id, {
      kind: 'audit',
      queryText: r.queryText ?? null,
      ragLabel: r.ragLabel ?? null,
      gapReasons: Array.isArray(r.gapReasons) ? (r.gapReasons as string[]) : [],
    });
  }
  for (const r of legacyRows) {
    contexts.set(r.id, {
      kind: 'legacy',
      pageUrl: r.pageUrl ?? null,
      action: r.action ?? null,
      rationale: r.rationale ?? null,
    });
  }
  for (const r of redditRows) {
    contexts.set(r.id, {
      kind: 'reddit',
      subreddit: r.subreddit ?? null,
      text: r.text ? r.text.slice(0, 280) : null,
      url: r.url ?? null,
      sentiment: r.sentiment ?? null,
    });
  }
  // Entity tickets: source_id = audit_run id, which isn't especially useful
  // as a link target. The playbook_step ("entity:bbb:claim", etc.) carries
  // the actual meaning, so we surface that in the UI and skip a lookup.
  for (const id of entityIds) {
    contexts.set(id, { kind: 'entity', note: 'See playbook step for action' });
  }

  return contexts;
}

export type TicketFilter = {
  status?: TicketStatus;
  sourceType?: TicketSource;
};

/** Full ticket list for a firm, newest-first, with context resolved. */
export async function listRemediationTickets(
  firmSlug: string,
  filter: TicketFilter = {},
): Promise<RemediationTicketRow[]> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  const conditions = [eq(remediationTickets.firm_id, firmId)];
  if (filter.status) {
    conditions.push(eq(remediationTickets.status, filter.status));
  }
  if (filter.sourceType) {
    // Accept the legacy `'alignment'` alias for audit tickets so historical
    // rows are still findable via the "audit" filter.
    if (filter.sourceType === 'audit') {
      conditions.push(
        inArray(remediationTickets.source_type, ['audit', 'alignment']),
      );
    } else {
      conditions.push(eq(remediationTickets.source_type, filter.sourceType));
    }
  }

  const rawRows = await db
    .select({
      id: remediationTickets.id,
      sourceType: remediationTickets.source_type,
      sourceId: remediationTickets.source_id,
      status: remediationTickets.status,
      playbookStep: remediationTickets.playbook_step,
      owner: remediationTickets.owner,
      dueAt: remediationTickets.due_at,
      createdAt: remediationTickets.created_at,
      title: remediationTickets.title,
      description: remediationTickets.description,
      priorityRank: remediationTickets.priority_rank,
      automationTier: remediationTickets.automation_tier,
      executeUrl: remediationTickets.execute_url,
      executeLabel: remediationTickets.execute_label,
      manualReason: remediationTickets.manual_reason,
      remediationCopy: remediationTickets.remediation_copy,
    })
    .from(remediationTickets)
    .where(and(...conditions))
    .orderBy(desc(remediationTickets.created_at))
    .limit(300);

  const typed = rawRows.map((r) => ({
    id: r.id,
    sourceType: normalizeSource(r.sourceType),
    sourceId: r.sourceId,
    status: normalizeStatus(r.status),
    playbookStep: r.playbookStep,
    owner: r.owner,
    dueAt: r.dueAt,
    createdAt: r.createdAt,
    title: r.title,
    description: r.description,
    priorityRank: r.priorityRank,
    automationTier: r.automationTier as 'auto' | 'assist' | 'manual' | null,
    executeUrl: r.executeUrl,
    executeLabel: r.executeLabel,
    manualReason: r.manualReason,
    remediationCopy: r.remediationCopy,
  }));

  const contexts = await loadContexts(
    typed.map((t) => ({ sourceType: t.sourceType, sourceId: t.sourceId })),
  );

  const now = Date.now();
  return typed.map((t) => ({
    ...t,
    overdue: t.status !== 'closed' && t.dueAt != null && t.dueAt.getTime() < now,
    context: contexts.get(t.sourceId) ?? {
      kind: 'unknown',
      note: 'Source row missing — may have been deleted',
    },
  }));
}

/** Counts per (status × source_type) + totals, for filter pills. */
export type TicketStats = {
  total: number;
  byStatus: Record<TicketStatus, number>;
  bySource: Record<TicketSource, number>;
  openOverdue: number;
};

/**
 * Faceted counts for the filter pills + stat strip.
 *
 * Each metric respects every active filter EXCEPT the axis it represents:
 *   • `byStatus[s]` and `total` and `openOverdue` respect `filter.sourceType`
 *     only — the status pill swaps the status axis, so its count holds
 *     source constant and shows "tickets if I switch status to s".
 *   • `bySource[src]` respects `filter.status` only — the source pill
 *     swaps the source axis, so its count holds status constant.
 *
 * Without this, the source pills displayed lifetime totals (e.g. "Audit 16")
 * even when the operator was on `?status=closed`, where the actual closed
 * audit count was 1.
 */
export async function getTicketStats(
  firmSlug: string,
  filter: TicketFilter = {},
): Promise<TicketStats> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  // Pull every ticket for the firm — we need two cross-cutting aggregations
  // (status × source filter holding the other constant) and page load is
  // dominated by the context joins in `listRemediationTickets`, not this.
  const rows = await db
    .select({
      status: remediationTickets.status,
      sourceType: remediationTickets.source_type,
      dueAt: remediationTickets.due_at,
    })
    .from(remediationTickets)
    .where(eq(remediationTickets.firm_id, firmId));

  const stats: TicketStats = {
    total: 0,
    byStatus: { open: 0, in_progress: 0, closed: 0 },
    bySource: { audit: 0, legacy: 0, reddit: 0, entity: 0 },
    openOverdue: 0,
  };

  const now = Date.now();
  for (const r of rows) {
    const status = normalizeStatus(r.status);
    const source = normalizeSource(r.sourceType);
    const overdue =
      status !== 'closed' && r.dueAt != null && r.dueAt.getTime() < now;

    const matchesSourceFilter =
      !filter.sourceType || filter.sourceType === source;
    const matchesStatusFilter =
      !filter.status || filter.status === status;

    if (matchesSourceFilter) {
      stats.byStatus[status] += 1;
      stats.total += 1;
      if (overdue) stats.openOverdue += 1;
    }
    if (matchesStatusFilter) {
      stats.bySource[source] += 1;
    }
  }

  return stats;
}

/** Unfiltered open+in_progress count — drives the sidebar nav badge. */
export async function getOpenTicketCount(firmSlug: string): Promise<number> {
  try {
    const db = getDb();
    const firmId = await resolveFirmId(firmSlug);
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(remediationTickets)
      .where(
        and(
          eq(remediationTickets.firm_id, firmId),
          inArray(remediationTickets.status, ['open', 'in_progress']),
        ),
      );
    return row?.count ?? 0;
  } catch {
    // Sidebar shouldn't crash the layout if the DB hiccups — fall back to 0.
    return 0;
  }
}

/**
 * Move a ticket between statuses. Idempotent — re-writing the same status
 * is a no-op but still revalidates so the UI reconciles if a stale client
 * got out of sync.
 */
export async function updateTicketStatus(
  firmSlug: string,
  ticketId: string,
  status: TicketStatus,
): Promise<{ ok: true } | { error: string }> {
  try {
    if (!(TICKET_STATUSES as readonly string[]).includes(status)) {
      return { error: `Invalid status: ${status}` };
    }

    const db = getDb();
    const firmId = await resolveFirmId(firmSlug);

    // Firm-scope guard.
    const [existing] = await db
      .select({ id: remediationTickets.id })
      .from(remediationTickets)
      .where(
        and(
          eq(remediationTickets.id, ticketId),
          eq(remediationTickets.firm_id, firmId),
        ),
      )
      .limit(1);
    if (!existing) return { error: 'Ticket not found for this firm' };

    await db
      .update(remediationTickets)
      .set({ status })
      .where(eq(remediationTickets.id, ticketId));

    revalidatePath(`/dashboard/${firmSlug}/tickets`);
    revalidatePath(`/dashboard/${firmSlug}`);
    revalidatePath(`/dashboard/admin`);
    return { ok: true };
  } catch (err) {
    return { error: String(err) };
  }
}

/** Bulk-close every ticket currently in open/in_progress for a source type. */
export async function bulkCloseBySource(
  firmSlug: string,
  sourceType: TicketSource,
): Promise<{ closed: number } | { error: string }> {
  try {
    const db = getDb();
    const firmId = await resolveFirmId(firmSlug);

    const sourceFilter =
      sourceType === 'audit'
        ? inArray(remediationTickets.source_type, ['audit', 'alignment'])
        : eq(remediationTickets.source_type, sourceType);

    const rows = await db
      .update(remediationTickets)
      .set({ status: 'closed' })
      .where(
        and(
          eq(remediationTickets.firm_id, firmId),
          sourceFilter,
          inArray(remediationTickets.status, ['open', 'in_progress']),
        ),
      )
      .returning({ id: remediationTickets.id });

    revalidatePath(`/dashboard/${firmSlug}/tickets`);
    revalidatePath(`/dashboard/${firmSlug}`);
    revalidatePath(`/dashboard/admin`);
    return { closed: rows.length };
  } catch (err) {
    return { error: String(err) };
  }
}
