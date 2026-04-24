import { getDb, auditRuns } from '@ai-edge/db';
import { and, eq, lt } from 'drizzle-orm';
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
 *   cold-boot recycle, platform-side crash), the `audit_run` row stays in
 *   `status='running'` forever. That pollutes the dashboard "last audit"
 *   signal, blocks any UI check that says "an audit is already in flight,"
 *   and hides real ops failures inside what looks like a healthy metric.
 *
 *   Vercel functions top out at 300s of wall-clock (and with our current
 *   fan-out the real upper bound is ~2-3 min per audit). So any run still
 *   marked `running` after an hour is definitively dead — nothing could
 *   still be executing against it. Mark those rows failed so they stop
 *   looking alive.
 *
 * Threshold rationale:
 *   5×  function max-duration gives comfortable headroom against clock
 *   skew between the DB and the function. A tighter threshold (say 10 min)
 *   would recover faster but risks racing a legitimately-slow run if we
 *   ever raise maxDuration.
 *
 * No writes outside audit_runs. The cost row already captured real spend
 * via `recordRunCost` before the crash; leaving it is correct — that's
 * money that actually went out to the providers.
 */
const STALE_THRESHOLD_MINUTES = 60;
const STALE_ERROR_MESSAGE =
  'Stale: process crashed or deployment cycled before the run could finish. Marked failed by audit-sweep.';

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedResponse();

  return recordCronRun('audit-sweep', async () => {
    console.log('[cron:audit-sweep] start');

    const db = getDb();
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000);

    // Snapshot candidates first so we can log + report ids. A single UPDATE
    // with RETURNING would be cheaper, but this gives the admin cron log a
    // clear audit trail of exactly which runs were reaped.
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
        body: { swept: 0, cutoff: cutoff.toISOString() },
        summary: { swept: 0, cutoff: cutoff.toISOString() },
      };
    }

    // Single UPDATE — safe under concurrent writes because we re-check
    // status='running' in the WHERE so a run that raced back to 'completed'
    // or 'failed' between the snapshot and the update is left alone.
    const now = new Date();
    const updated = await db
      .update(auditRuns)
      .set({
        status: 'failed',
        finished_at: now,
        error: STALE_ERROR_MESSAGE,
      })
      .where(
        and(
          eq(auditRuns.status, 'running'),
          lt(auditRuns.started_at, cutoff),
        ),
      )
      .returning({ id: auditRuns.id });

    console.log(
      `[cron:audit-sweep] swept ${updated.length} stale run(s) (cutoff=${cutoff.toISOString()})`,
    );

    const summary = {
      swept: updated.length,
      cutoff: cutoff.toISOString(),
      ids: updated.map((r) => r.id),
    };
    return {
      body: summary,
      summary,
    };
  });
}
