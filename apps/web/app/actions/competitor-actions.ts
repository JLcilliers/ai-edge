'use server';

import {
  getDb,
  firms,
  competitors,
  competitorMentions,
  queries as queriesTable,
  auditRuns,
} from '@ai-edge/db';
import { eq, desc, and, sql, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

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

export type CompetitorRow = {
  id: string;
  name: string;
  website: string | null;
  notes: string | null;
};

/** All competitors for the firm, alphabetical by name. */
export async function listCompetitors(firmSlug: string): Promise<CompetitorRow[]> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  return db
    .select({
      id: competitors.id,
      name: competitors.name,
      website: competitors.website,
      notes: competitors.notes,
    })
    .from(competitors)
    .where(eq(competitors.firm_id, firmId))
    .orderBy(competitors.name);
}

/**
 * Add a competitor to the firm's roster.
 *
 * `website` is optional but strongly recommended — the detection pass uses both
 * name-substring matching AND domain matching, so a naked firm name like
 * "Smith & Associates" gets a lot fewer false positives when we also know
 * smithandassociates.com.
 */
export async function createCompetitor(input: {
  firmSlug: string;
  name: string;
  website?: string;
  notes?: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Name is required' };
  if (name.length > 200) {
    return { ok: false, error: 'Name must be 200 characters or fewer' };
  }

  const website = input.website?.trim() || null;
  if (website && !/^https?:\/\//i.test(website)) {
    return { ok: false, error: 'Website must start with http:// or https://' };
  }

  try {
    const db = getDb();
    const firmId = await resolveFirmId(input.firmSlug);
    const [row] = await db
      .insert(competitors)
      .values({
        firm_id: firmId,
        name,
        website,
        notes: input.notes?.trim() || null,
      })
      .returning({ id: competitors.id });

    revalidatePath(`/dashboard/${input.firmSlug}/competitors`);
    return { ok: true, id: row!.id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Update a competitor row. `firmSlug` is required to revalidate the right
 * path and to guard against cross-firm edits via direct id (we also re-check
 * the firm_id on the row below).
 */
export async function updateCompetitor(input: {
  firmSlug: string;
  id: string;
  name: string;
  website?: string;
  notes?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Name is required' };

  const website = input.website?.trim() || null;
  if (website && !/^https?:\/\//i.test(website)) {
    return { ok: false, error: 'Website must start with http:// or https://' };
  }

  try {
    const db = getDb();
    const firmId = await resolveFirmId(input.firmSlug);

    // Guard: only update if the row belongs to this firm.
    const result = await db
      .update(competitors)
      .set({
        name,
        website,
        notes: input.notes?.trim() || null,
      })
      .where(and(eq(competitors.id, input.id), eq(competitors.firm_id, firmId)));

    revalidatePath(`/dashboard/${input.firmSlug}/competitors`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Remove a competitor. Cascades to competitor_mention rows via FK. */
export async function deleteCompetitor(input: {
  firmSlug: string;
  id: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const db = getDb();
    const firmId = await resolveFirmId(input.firmSlug);

    await db
      .delete(competitors)
      .where(and(eq(competitors.id, input.id), eq(competitors.firm_id, firmId)));

    revalidatePath(`/dashboard/${input.firmSlug}/competitors`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export type ShareOfMentionRow = {
  competitorId: string;
  competitorName: string;
  mentionCount: number;
  averageShare: number;
  praiseCount: number;
};

/**
 * Share-of-mention aggregation for the firm's most recent completed audit run.
 *
 * For the latest completed audit:
 *   - count how many queries mention each competitor
 *   - average the per-query `share` (roughly: mentions of this competitor /
 *     mentions of {firm + all competitors} within that one response)
 *   - count how many of those mentions were flagged as "praise" by the
 *     detection pass (explicit positive framing by the LLM)
 *
 * Returns rows for every competitor on the roster — including zero-mention
 * ones — so the UI can render a complete table. Rows come back sorted by
 * mentionCount descending so the "who's winning" picture is obvious at a
 * glance.
 */
export async function getCompetitorShareOfMention(
  firmSlug: string,
): Promise<{
  latestRunId: string | null;
  latestRunFinishedAt: Date | null;
  rows: ShareOfMentionRow[];
}> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  // Pull the roster first — we always want a row per competitor even when
  // share is zero, so the UI can show "we're ranked, they aren't" clearly.
  const roster = await db
    .select({
      id: competitors.id,
      name: competitors.name,
    })
    .from(competitors)
    .where(eq(competitors.firm_id, firmId))
    .orderBy(competitors.name);

  if (roster.length === 0) {
    return { latestRunId: null, latestRunFinishedAt: null, rows: [] };
  }

  // Pick the most recent completed audit run — ignore reddit / citation-diff
  // runs which don't populate competitor_mention.
  const [latestRun] = await db
    .select({
      id: auditRuns.id,
      finished_at: auditRuns.finished_at,
    })
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.firm_id, firmId),
        eq(auditRuns.status, 'completed'),
        inArray(auditRuns.kind, ['full', 'daily-priority']),
      ),
    )
    .orderBy(desc(auditRuns.started_at))
    .limit(1);

  if (!latestRun) {
    return {
      latestRunId: null,
      latestRunFinishedAt: null,
      rows: roster.map((c) => ({
        competitorId: c.id,
        competitorName: c.name,
        mentionCount: 0,
        averageShare: 0,
        praiseCount: 0,
      })),
    };
  }

  // Aggregate competitor_mention rows scoped to queries from the latest run.
  // Postgres `AVG` returns string for real-valued columns in pg drivers, so
  // cast both counts and average inline.
  const aggregates = await db
    .select({
      competitorId: competitorMentions.competitor_id,
      mentionCount: sql<number>`count(*)::int`,
      averageShare: sql<number>`coalesce(avg(${competitorMentions.share}), 0)::real`,
      praiseCount: sql<number>`sum(case when ${competitorMentions.praise_flag} then 1 else 0 end)::int`,
    })
    .from(competitorMentions)
    .innerJoin(queriesTable, eq(queriesTable.id, competitorMentions.query_id))
    .where(
      and(
        eq(competitorMentions.firm_id, firmId),
        eq(queriesTable.audit_run_id, latestRun.id),
      ),
    )
    .groupBy(competitorMentions.competitor_id);

  const byId = new Map(aggregates.map((a) => [a.competitorId, a]));

  const rows: ShareOfMentionRow[] = roster.map((c) => {
    const agg = byId.get(c.id);
    return {
      competitorId: c.id,
      competitorName: c.name,
      mentionCount: agg?.mentionCount ?? 0,
      averageShare: Number(agg?.averageShare ?? 0),
      praiseCount: agg?.praiseCount ?? 0,
    };
  });

  // Sort by mentionCount desc, then name — "who's winning" first, alpha for ties.
  rows.sort((a, b) => {
    if (b.mentionCount !== a.mentionCount) return b.mentionCount - a.mentionCount;
    return a.competitorName.localeCompare(b.competitorName);
  });

  return {
    latestRunId: latestRun.id,
    latestRunFinishedAt: latestRun.finished_at,
    rows,
  };
}
