'use server';

import {
  getDb,
  firms,
  redditMentions,
  remediationTickets,
  auditRuns,
} from '@ai-edge/db';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { runRedditScan } from '../lib/reddit/scan';
// Triage vocabulary lives in a sibling non-'use-server' module so client
// components can import the runtime tuple for filter pills without
// tripping Next 16's async-only export rule.
import { TRIAGE_STATUSES, type TriageStatus } from './reddit-constants';

/** Resolve firm id from URL slug. Throws if the slug doesn't match a firm. */
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

/** Start a new Reddit scan for the firm. Returns the audit_run id. */
export async function startRedditScan(
  firmSlug: string,
): Promise<{ runId: string } | { error: string }> {
  try {
    const firmId = await resolveFirmId(firmSlug);
    const runId = await runRedditScan(firmId);
    return { runId };
  } catch (err) {
    return { error: String(err) };
  }
}

/** Poll status of a Reddit scan. Audit-run id is globally unique. */
export async function getRedditScanStatus(runId: string): Promise<{
  status: string;
  error: string | null;
}> {
  const db = getDb();
  const [run] = await db
    .select({ status: auditRuns.status, error: auditRuns.error })
    .from(auditRuns)
    .where(eq(auditRuns.id, runId))
    .limit(1);
  return run ?? { status: 'unknown', error: null };
}

// TRIAGE_STATUSES + TriageStatus moved to ./reddit-constants.ts (Next 16
// "use server" export restriction — async functions only).

export type RedditMentionRow = {
  id: string;
  subreddit: string;
  author: string | null;
  karma: number | null;
  sentiment: string | null;
  text: string | null;
  url: string;
  postedAt: Date | null;
  ingestedAt: Date;
  triageStatus: TriageStatus;
  triageNote: string | null;
  triagedAt: Date | null;
};

/**
 * Reddit mentions for the firm, newest ingested first.
 *
 * `status` lets the UI filter to a single triage bucket (open/acknowledged/
 * dismissed/escalated) — omit it to show the full feed. Callers should clamp
 * to one of `TRIAGE_STATUSES` before calling; we still guard at the DB layer
 * but a bad string just returns no rows.
 */
export async function getRedditMentions(
  firmSlug: string,
  opts?: { status?: TriageStatus },
): Promise<RedditMentionRow[]> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  const where = opts?.status
    ? and(
        eq(redditMentions.firm_id, firmId),
        eq(redditMentions.triage_status, opts.status),
      )
    : eq(redditMentions.firm_id, firmId);

  const rows = await db
    .select({
      id: redditMentions.id,
      subreddit: redditMentions.subreddit,
      author: redditMentions.author,
      karma: redditMentions.karma,
      sentiment: redditMentions.sentiment,
      text: redditMentions.text,
      url: redditMentions.url,
      postedAt: redditMentions.posted_at,
      ingestedAt: redditMentions.ingested_at,
      triageStatus: redditMentions.triage_status,
      triageNote: redditMentions.triage_note,
      triagedAt: redditMentions.triaged_at,
    })
    .from(redditMentions)
    .where(where)
    .orderBy(desc(redditMentions.ingested_at))
    .limit(200);

  // Coerce the `text` triage_status column to our union at the boundary so
  // client code never has to narrow a wide string.
  return rows.map((r) => ({
    ...r,
    triageStatus: normalizeTriage(r.triageStatus),
  }));
}

function normalizeTriage(raw: string | null | undefined): TriageStatus {
  if (raw && (TRIAGE_STATUSES as readonly string[]).includes(raw)) {
    return raw as TriageStatus;
  }
  return 'open';
}

/** Counts per triage bucket for the firm. Drives the filter-pill badges. */
export async function getRedditTriageCounts(
  firmSlug: string,
): Promise<Record<TriageStatus | 'all', number>> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  const rows = await db
    .select({
      status: redditMentions.triage_status,
    })
    .from(redditMentions)
    .where(eq(redditMentions.firm_id, firmId));

  const counts: Record<TriageStatus | 'all', number> = {
    all: rows.length,
    open: 0,
    acknowledged: 0,
    dismissed: 0,
    escalated: 0,
  };
  for (const r of rows) {
    const s = normalizeTriage(r.status);
    counts[s] += 1;
  }
  return counts;
}

/**
 * Update the triage state of a single mention. Also syncs the corresponding
 * remediation_ticket (if any) so the ticket queue stays consistent:
 *   - acknowledged  → ticket.status = 'in_progress'
 *   - dismissed     → ticket.status = 'closed'
 *   - escalated     → ticket.status = 'open' (re-open if previously closed)
 *   - open          → ticket.status = 'open'
 *
 * We revalidate both the firm dashboard (mention count tile) and the reddit
 * page (feed + counts).
 */
export async function updateRedditMentionTriage(
  firmSlug: string,
  mentionId: string,
  args: { status: TriageStatus; note?: string | null },
): Promise<{ ok: true } | { error: string }> {
  try {
    const db = getDb();
    const firmId = await resolveFirmId(firmSlug);

    if (!(TRIAGE_STATUSES as readonly string[]).includes(args.status)) {
      return { error: `Invalid triage status: ${args.status}` };
    }

    // Firm-scope guard — prevents cross-firm writes if someone fuzzes the
    // client action with a mention id from another firm.
    const [existing] = await db
      .select({ id: redditMentions.id })
      .from(redditMentions)
      .where(
        and(eq(redditMentions.id, mentionId), eq(redditMentions.firm_id, firmId)),
      )
      .limit(1);
    if (!existing) return { error: 'Mention not found for this firm' };

    await db
      .update(redditMentions)
      .set({
        triage_status: args.status,
        triage_note: args.note ?? null,
        triaged_at: new Date(),
      })
      .where(eq(redditMentions.id, mentionId));

    // Sync remediation ticket if one exists.
    const ticketStatus = triageToTicketStatus(args.status);
    await db
      .update(remediationTickets)
      .set({ status: ticketStatus })
      .where(
        and(
          eq(remediationTickets.source_type, 'reddit'),
          eq(remediationTickets.source_id, mentionId),
        ),
      );

    revalidatePath(`/dashboard/${firmSlug}/reddit`);
    revalidatePath(`/dashboard/${firmSlug}`);
    revalidatePath(`/dashboard/admin`);
    return { ok: true };
  } catch (err) {
    return { error: String(err) };
  }
}

/**
 * Bulk-dismiss every mention currently in `open` for a given sentiment bucket.
 * Handy for the "mark all neutral as dismissed" shortcut — neutrals are
 * rarely actionable and accumulate fast on active subreddits.
 *
 * Returns the count of rows actually updated so the UI can confirm.
 */
export async function bulkDismissOpenBySentiment(
  firmSlug: string,
  sentiment: string,
): Promise<{ updated: number } | { error: string }> {
  try {
    const db = getDb();
    const firmId = await resolveFirmId(firmSlug);

    const rows = await db
      .update(redditMentions)
      .set({
        triage_status: 'dismissed',
        triaged_at: new Date(),
      })
      .where(
        and(
          eq(redditMentions.firm_id, firmId),
          eq(redditMentions.sentiment, sentiment),
          eq(redditMentions.triage_status, 'open'),
        ),
      )
      .returning({ id: redditMentions.id });

    if (rows.length > 0) {
      // Close any tickets tied to those mentions.
      await db
        .update(remediationTickets)
        .set({ status: 'closed' })
        .where(
          and(
            eq(remediationTickets.source_type, 'reddit'),
            inArray(
              remediationTickets.source_id,
              rows.map((r) => r.id),
            ),
          ),
        );
    }

    revalidatePath(`/dashboard/${firmSlug}/reddit`);
    revalidatePath(`/dashboard/${firmSlug}`);
    revalidatePath(`/dashboard/admin`);
    return { updated: rows.length };
  } catch (err) {
    return { error: String(err) };
  }
}

function triageToTicketStatus(t: TriageStatus): string {
  switch (t) {
    case 'acknowledged':
      return 'in_progress';
    case 'dismissed':
      return 'closed';
    case 'escalated':
    case 'open':
    default:
      return 'open';
  }
}

/** Most recent Reddit scan audit_run — used to render last-run metadata. */
export async function getLatestRedditRun(firmSlug: string): Promise<{
  id: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
} | null> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  const [run] = await db
    .select({
      id: auditRuns.id,
      status: auditRuns.status,
      startedAt: auditRuns.started_at,
      finishedAt: auditRuns.finished_at,
      error: auditRuns.error,
    })
    .from(auditRuns)
    .where(and(eq(auditRuns.firm_id, firmId), eq(auditRuns.kind, 'reddit')))
    .orderBy(desc(auditRuns.started_at))
    .limit(1);

  return run ?? null;
}
