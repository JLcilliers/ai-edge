import {
  getDb,
  auditRuns,
  queries as queriesTable,
  consensusResponses,
} from '@ai-edge/db';
import { and, eq, lt, inArray, sql } from 'drizzle-orm';
import { isAuthorizedCronRequest, unauthorizedResponse } from '../../../lib/cron/auth';
import { recordCronRun } from '../../../lib/cron/log';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Stale audit-run sweeper (declared in vercel.ts at `15 * * * *` — every
 * hour on :15 so it doesn't collide with the 0-minute audit crons).
 *
 * Motivation:
 *   Audit runs live inside a single serverless function invocation with
 *   maxDuration=300s. If the process is killed mid-run (deploy cycle, OOM,
 *   cold-boot recycle, platform-side crash, or a hung upstream LLM), the
 *   `audit_run` row stays in `status='running'` forever. That pollutes the
 *   dashboard "last audit" signal, blocks the Visibility / Competitors tabs
 *   from hydrating (they gate on `status IN (completed, completed_partial,
 *   completed_budget_truncated)`), and hides real ops failures inside what
 *   looks like a healthy metric.
 *
 *   Vercel functions top out at 300s of wall-clock (5×60s) and with our
 *   current fan-out the real upper bound is ~2-3 min per audit. So any run
 *   still marked `running` after 15 minutes is definitively dead — nothing
 *   could still be executing against it.
 *
 * Threshold rationale:
 *   3× function max-duration. The previous 60-minute threshold was
 *   needlessly pessimistic — operators were waiting an hour for the
 *   dashboard to recover after a hung provider, and the Visibility tab
 *   stayed in empty-state the whole time. 15 minutes still gives 3×
 *   maxDuration of headroom which covers any sane clock skew.
 *
 * Result-aware status assignment:
 *   When we sweep a stale run, we look at how much actually got done before
 *   it crashed. If at least one query produced a consensus_response row the
 *   audit pipeline successfully scored at least one (query × provider) cell
 *   — those rows are real signal we shouldn't throw away. We mark the run
 *   `completed_partial` so Visibility / Share-of-Voice / Drift / etc. can
 *   read from it, and the operator at least sees the data the audit got
 *   through before crashing. If zero consensus_responses were written, the
 *   audit died before any useful work happened — we mark it `failed`.
 *
 * No writes outside audit_runs. Cost rows already captured real spend via
 * `recordRunCost` before the crash; leaving them is correct — that's money
 * that actually went out to the providers.
 */
const STALE_THRESHOLD_MINUTES = 15;
const STALE_ERROR_PARTIAL =
  'Stale: process crashed or deployment cycled before the run could finish. Audit-sweep promoted to completed_partial because at least one query was scored; operators can read the rows that landed.';
const STALE_ERROR_FAILED =
  'Stale: process crashed or deployment cycled before the run could finish. No queries were scored, so this run carries no usable signal.';

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedResponse();

  return recordCronRun('audit-sweep', async () => {
    console.log('[cron:audit-sweep] start');

    const db = getDb();
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000);

    // Snapshot candidates first so we can log + report ids. A single UPDATE
    // with RETURNING would be cheaper, but this gives the admin cron log a
    // clear audit trail of exactly which runs were reaped, and we need the
    // ids anyway to subdivide them into the partial-vs-failed buckets.
    const stale = await db
      .select({
        id: auditRuns.id,
        firm_id: auditRuns.firm_id,
        kind: auditRuns.kind,
        started_at: auditRuns.started_at,
      })
      .from(auditRuns)
      .where(
        and(
          eq(auditRuns.status, 'running'),
          lt(auditRuns.started_at, cutoff),
        ),
      );

    if (stale.length === 0) {
      console.log('[cron:audit-sweep] no stale runs');
      return {
        body: { swept: 0, partial: 0, failed: 0, cutoff: cutoff.toISOString() },
        summary: { swept: 0, partial: 0, failed: 0, cutoff: cutoff.toISOString() },
      };
    }

    // Subdivide: which stale runs have at least one consensus_response, and
    // which produced nothing? Single SELECT joining queries × consensus.
    const staleIds = stale.map((r) => r.id);
    const withResults = await db
      .select({
        audit_run_id: queriesTable.audit_run_id,
        scored_count: sql<number>`COUNT(${consensusResponses.id})::int`,
      })
      .from(queriesTable)
      .innerJoin(
        consensusResponses,
        eq(consensusResponses.query_id, queriesTable.id),
      )
      .where(inArray(queriesTable.audit_run_id, staleIds))
      .groupBy(queriesTable.audit_run_id);

    const resultsByRun = new Map<string, number>();
    for (const row of withResults) {
      resultsByRun.set(row.audit_run_id, row.scored_count);
    }

    const partialIds: string[] = [];
    const failedIds: string[] = [];
    for (const id of staleIds) {
      if ((resultsByRun.get(id) ?? 0) > 0) {
        partialIds.push(id);
      } else {
        failedIds.push(id);
      }
    }

    const now = new Date();

    // Two UPDATEs (partial + failed) instead of one. Both keep the
    // status='running' WHERE clause as a belt-and-braces guard against a
    // race with the audit pipeline's own final UPDATE — if a run flipped
    // back to 'completed' between snapshot and write, leave it alone.
    let partialUpdated: { id: string }[] = [];
    if (partialIds.length > 0) {
      partialUpdated = await db
        .update(auditRuns)
        .set({
          status: 'completed_partial',
          finished_at: now,
          error: STALE_ERROR_PARTIAL,
        })
        .where(
          and(
            eq(auditRuns.status, 'running'),
            inArray(auditRuns.id, partialIds),
          ),
        )
        .returning({ id: auditRuns.id });
    }

    let failedUpdated: { id: string }[] = [];
    if (failedIds.length > 0) {
      failedUpdated = await db
        .update(auditRuns)
        .set({
          status: 'failed',
          finished_at: now,
          error: STALE_ERROR_FAILED,
        })
        .where(
          and(
            eq(auditRuns.status, 'running'),
            inArray(auditRuns.id, failedIds),
          ),
        )
        .returning({ id: auditRuns.id });
    }

    console.log(
      `[cron:audit-sweep] swept ${
        partialUpdated.length + failedUpdated.length
      } stale run(s) — partial=${partialUpdated.length} failed=${
        failedUpdated.length
      } (cutoff=${cutoff.toISOString()})`,
    );

    const summary = {
      swept: partialUpdated.length + failedUpdated.length,
      partial: partialUpdated.length,
      failed: failedUpdated.length,
      cutoff: cutoff.toISOString(),
      partialIds: partialUpdated.map((r) => r.id),
      failedIds: failedUpdated.map((r) => r.id),
    };
    return {
      body: summary,
      summary,
    };
  });
}
