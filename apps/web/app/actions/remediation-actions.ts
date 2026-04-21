'use server';

import {
  getDb,
  firms,
  remediationTickets,
  alignmentScores,
  consensusResponses,
  queries as queriesTable,
  redditMentions,
} from '@ai-edge/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export type TicketStatus = 'open' | 'in_progress' | 'done' | 'wont_fix';
export type TicketSourceType = 'audit' | 'reddit' | 'legacy' | 'entity' | 'alignment';

const TICKET_STATUSES: ReadonlySet<TicketStatus> = new Set([
  'open',
  'in_progress',
  'done',
  'wont_fix',
]);

export type TicketRow = {
  id: string;
  sourceType: TicketSourceType;
  sourceId: string;
  status: TicketStatus;
  owner: string | null;
  playbookStep: string | null;
  dueAt: Date | null;
  createdAt: Date;
  // Exactly one of audit/reddit is populated based on sourceType. Legacy + entity
  // don't emit tickets yet (modules not built), but the type admits them.
  audit: {
    queryText: string;
    mentioned: boolean;
    toneScore: number | null;
    ragLabel: string;
    gapReasons: string[];
    factualErrors: string[];
    responsePreview: string;
    auditRunId: string; // link back to full audit drill-down
  } | null;
  reddit: {
    subreddit: string;
    author: string | null;
    karma: number | null;
    sentiment: string | null;
    url: string;
    text: string | null;
    postedAt: Date | null;
  } | null;
};

async function resolveFirmId(slug: string): Promise<string> {
  const db = getDb();
  const [row] = await db
    .select({ id: firms.id })
    .from(firms)
    .where(eq(firms.slug, slug))
    .limit(1);
  if (!row) throw new Error(`Firm not found: ${slug}`);
  return row.id;
}

/**
 * All remediation tickets for a firm, enriched with source details.
 * Open + in_progress first, then done + wont_fix. Newest-first within status.
 */
export async function listTickets(firmSlug: string): Promise<TicketRow[]> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  const tickets = await db
    .select({
      id: remediationTickets.id,
      source_type: remediationTickets.source_type,
      source_id: remediationTickets.source_id,
      status: remediationTickets.status,
      owner: remediationTickets.owner,
      playbook_step: remediationTickets.playbook_step,
      due_at: remediationTickets.due_at,
      created_at: remediationTickets.created_at,
    })
    .from(remediationTickets)
    .where(eq(remediationTickets.firm_id, firmId))
    .orderBy(
      sql`CASE ${remediationTickets.status}
            WHEN 'open' THEN 0
            WHEN 'in_progress' THEN 1
            WHEN 'done' THEN 2
            WHEN 'wont_fix' THEN 3
            ELSE 4
          END`,
      desc(remediationTickets.created_at),
    );

  if (tickets.length === 0) return [];

  // Source-id sets, de-duped. Both 'audit' (current run-audit.ts value) and the
  // schema's nominal 'alignment' tag point to alignment_score rows.
  const auditIds = Array.from(
    new Set(
      tickets
        .filter((t) => t.source_type === 'audit' || t.source_type === 'alignment')
        .map((t) => t.source_id),
    ),
  );
  const redditIds = Array.from(
    new Set(
      tickets.filter((t) => t.source_type === 'reddit').map((t) => t.source_id),
    ),
  );

  // Join alignment → consensus → query to recover the user-visible query text,
  // the response snippet the judge scored, and the audit run id for drill-down.
  const auditRows =
    auditIds.length > 0
      ? await db
          .select({
            alignment_id: alignmentScores.id,
            mentioned: alignmentScores.mentioned,
            tone_1_10: alignmentScores.tone_1_10,
            rag_label: alignmentScores.rag_label,
            gap_reasons: alignmentScores.gap_reasons,
            factual_errors: alignmentScores.factual_errors,
            query_text: queriesTable.text,
            audit_run_id: queriesTable.audit_run_id,
            majority_answer: consensusResponses.majority_answer,
          })
          .from(alignmentScores)
          .innerJoin(
            consensusResponses,
            eq(alignmentScores.consensus_response_id, consensusResponses.id),
          )
          .innerJoin(queriesTable, eq(consensusResponses.query_id, queriesTable.id))
          .where(inArray(alignmentScores.id, auditIds))
      : [];

  const auditById = new Map(auditRows.map((r) => [r.alignment_id, r]));

  const redditRows =
    redditIds.length > 0
      ? await db
          .select({
            id: redditMentions.id,
            subreddit: redditMentions.subreddit,
            author: redditMentions.author,
            karma: redditMentions.karma,
            sentiment: redditMentions.sentiment,
            url: redditMentions.url,
            text: redditMentions.text,
            posted_at: redditMentions.posted_at,
          })
          .from(redditMentions)
          .where(inArray(redditMentions.id, redditIds))
      : [];

  const redditById = new Map(redditRows.map((r) => [r.id, r]));

  return tickets.map((t): TicketRow => {
    const sourceType = t.source_type as TicketSourceType;
    const auditDetail = auditById.get(t.source_id);
    const redditDetail = redditById.get(t.source_id);
    return {
      id: t.id,
      sourceType,
      sourceId: t.source_id,
      status: TICKET_STATUSES.has(t.status as TicketStatus)
        ? (t.status as TicketStatus)
        : 'open',
      owner: t.owner,
      playbookStep: t.playbook_step,
      dueAt: t.due_at,
      createdAt: t.created_at,
      audit: auditDetail
        ? {
            queryText: auditDetail.query_text,
            mentioned: !!auditDetail.mentioned,
            toneScore: auditDetail.tone_1_10,
            ragLabel: auditDetail.rag_label ?? 'red',
            gapReasons: (auditDetail.gap_reasons as string[] | null) ?? [],
            factualErrors:
              (auditDetail.factual_errors as string[] | null) ?? [],
            responsePreview: (auditDetail.majority_answer ?? '').slice(0, 400),
            auditRunId: auditDetail.audit_run_id,
          }
        : null,
      reddit: redditDetail
        ? {
            subreddit: redditDetail.subreddit,
            author: redditDetail.author,
            karma: redditDetail.karma,
            sentiment: redditDetail.sentiment,
            url: redditDetail.url,
            text: redditDetail.text,
            postedAt: redditDetail.posted_at,
          }
        : null,
    };
  });
}

/** Open + in_progress ticket count for the firm. Used on profile + client list tiles. */
export async function getOpenTicketCount(firmSlug: string): Promise<number> {
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
}

/** Update ticket status. */
export async function updateTicketStatus(input: {
  firmSlug: string;
  ticketId: string;
  status: TicketStatus;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!TICKET_STATUSES.has(input.status)) {
    return { ok: false, error: 'Invalid status' };
  }
  const db = getDb();
  const firmId = await resolveFirmId(input.firmSlug);

  const result = await db
    .update(remediationTickets)
    .set({ status: input.status })
    .where(
      and(
        eq(remediationTickets.id, input.ticketId),
        eq(remediationTickets.firm_id, firmId),
      ),
    )
    .returning({ id: remediationTickets.id });

  if (result.length === 0) {
    return { ok: false, error: 'Ticket not found' };
  }

  revalidatePath(`/dashboard/${input.firmSlug}/remediation`);
  revalidatePath(`/dashboard/${input.firmSlug}`);
  revalidatePath('/dashboard');
  return { ok: true };
}

/** Assign an owner (free-form string). Pass empty to unassign. */
export async function updateTicketOwner(input: {
  firmSlug: string;
  ticketId: string;
  owner: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getDb();
  const firmId = await resolveFirmId(input.firmSlug);
  const owner = input.owner.trim();

  const result = await db
    .update(remediationTickets)
    .set({ owner: owner === '' ? null : owner })
    .where(
      and(
        eq(remediationTickets.id, input.ticketId),
        eq(remediationTickets.firm_id, firmId),
      ),
    )
    .returning({ id: remediationTickets.id });

  if (result.length === 0) {
    return { ok: false, error: 'Ticket not found' };
  }

  revalidatePath(`/dashboard/${input.firmSlug}/remediation`);
  return { ok: true };
}
