import {
  getDb,
  firms,
  auditRuns,
  queries as queriesTable,
  consensusResponses,
  citations,
  citationDiffs,
} from '@ai-edge/db';
import { eq, desc, and, inArray, sql } from 'drizzle-orm';
import { isAuthorizedCronRequest, unauthorizedResponse } from '../../../lib/cron/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Nightly citation diff (declared in vercel.ts at `0 4 * * *`).
 *
 * For each firm, compare the set of cited DOMAINS between the two most recent
 * completed audit runs. Gains (domains newly cited) and losses (domains that
 * dropped out) are the signal we care about — individual URLs churn too much
 * to be useful directly.
 *
 * Persists gained/lost into `citation_diff` keyed by (firm_id, latest_run_id)
 * so the Visibility dashboard can surface drift over time. Also records a
 * no-op `audit_run` row with `kind='citation-diff'` as a cron heartbeat.
 *
 * The (firm_id, latest_run_id) upsert is idempotent — re-running the cron for
 * the same pair of runs refreshes the row in place rather than creating a
 * duplicate.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedResponse();

  const startedAt = Date.now();
  console.log('[cron:citation-diff] start');

  const db = getDb();
  const allFirms = await db.select({ id: firms.id, slug: firms.slug }).from(firms);

  const results: Array<{
    firmSlug: string;
    status: 'ok' | 'skipped' | 'error';
    gained?: string[];
    lost?: string[];
    reason?: string;
  }> = [];

  for (const firm of allFirms) {
    try {
      // Pull the two most recent completed audit runs (any kind — we diff
      // citation sets across time, not across kind).
      const recentRuns = await db
        .select({ id: auditRuns.id, startedAt: auditRuns.started_at })
        .from(auditRuns)
        .where(
          and(eq(auditRuns.firm_id, firm.id), eq(auditRuns.status, 'completed')),
        )
        .orderBy(desc(auditRuns.started_at))
        .limit(2);

      if (recentRuns.length < 2) {
        console.log(
          `[cron:citation-diff] skip ${firm.slug} — fewer_than_2_runs (${recentRuns.length})`,
        );
        results.push({
          firmSlug: firm.slug,
          status: 'skipped',
          reason: 'fewer_than_2_runs',
        });
        continue;
      }

      const [latest, previous] = recentRuns;

      const [latestDomains, previousDomains] = await Promise.all([
        getDomainsForRun(db, latest!.id),
        getDomainsForRun(db, previous!.id),
      ]);

      const gained = [...latestDomains].filter((d) => !previousDomains.has(d)).sort();
      const lost = [...previousDomains].filter((d) => !latestDomains.has(d)).sort();

      // Persist the diff. Upsert on (firm_id, latest_run_id) so re-running
      // the cron for the same pair refreshes counts/arrays idempotently.
      await db
        .insert(citationDiffs)
        .values({
          firm_id: firm.id,
          latest_run_id: latest!.id,
          previous_run_id: previous!.id,
          gained,
          lost,
          gained_count: gained.length,
          lost_count: lost.length,
        })
        .onConflictDoUpdate({
          target: [citationDiffs.firm_id, citationDiffs.latest_run_id],
          set: {
            previous_run_id: previous!.id,
            gained,
            lost,
            gained_count: gained.length,
            lost_count: lost.length,
            detected_at: sql`now()`,
          },
        });

      // Record a healthy-cron heartbeat run.
      await db.insert(auditRuns).values({
        firm_id: firm.id,
        kind: 'citation-diff',
        status: 'completed',
        started_at: new Date(startedAt),
        finished_at: new Date(),
      });

      console.log(
        `[cron:citation-diff] ok ${firm.slug} — gained=${gained.length} lost=${lost.length}`,
        { gained, lost },
      );
      results.push({ firmSlug: firm.slug, status: 'ok', gained, lost });
    } catch (err) {
      console.error(`[cron:citation-diff] error ${firm.slug}:`, err);
      results.push({ firmSlug: firm.slug, status: 'error', reason: String(err) });
    }
  }

  const durationMs = Date.now() - startedAt;
  const summary = {
    ran: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    errored: results.filter((r) => r.status === 'error').length,
    durationMs,
  };
  console.log('[cron:citation-diff] done', summary);

  return Response.json({ ...summary, results });
}

/**
 * Walk audit_run → queries → consensus_responses → citations to pull the unique
 * set of cited domains for a single run. Two SQL round-trips instead of joining
 * everything because drizzle's select-with-join composition gets unwieldy here
 * and the row counts are small.
 */
async function getDomainsForRun(
  db: ReturnType<typeof getDb>,
  auditRunId: string,
): Promise<Set<string>> {
  const queryRows = await db
    .select({ id: queriesTable.id })
    .from(queriesTable)
    .where(eq(queriesTable.audit_run_id, auditRunId));

  if (queryRows.length === 0) return new Set();

  const queryIds = queryRows.map((q) => q.id);
  const consensusRows = await db
    .select({ id: consensusResponses.id })
    .from(consensusResponses)
    .where(inArray(consensusResponses.query_id, queryIds));

  if (consensusRows.length === 0) return new Set();

  const consensusIds = consensusRows.map((c) => c.id);
  const citationRows = await db
    .select({ domain: citations.domain })
    .from(citations)
    .where(inArray(citations.consensus_response_id, consensusIds));

  const domains = new Set<string>();
  for (const row of citationRows) {
    if (row.domain) domains.add(row.domain.toLowerCase());
  }
  return domains;
}
