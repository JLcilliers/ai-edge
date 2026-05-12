/**
 * ensureSopRun — find-or-create the firm's sop_run for a given SopKey,
 * idempotently. Used by the legacy scanner code paths (run-audit.ts,
 * suppression/scan.ts, entity/scan.ts, entity/cross-source-scan.ts,
 * reddit/scan.ts) so every remediation_ticket they insert can carry a
 * valid sop_run_id.
 *
 * Why this exists: those four code paths predate the SOP engine and
 * insert into remediation_ticket directly with no sop_run_id, which
 * means the per-phase sidebar count + the new phase-page execution-
 * task list silently miss them. The phase page joins through sop_run,
 * so a NULL sop_run_id = invisible ticket.
 *
 * This helper keeps the legacy paths short: one new line ahead of the
 * insert (`const sopRunId = await ensureSopRun(firmId, 'X', 'scanner:Y');`)
 * + adding `sop_run_id: sopRunId` to the insert payload. No structural
 * rewrite of the legacy scanners.
 *
 * Idempotency: reuses an existing non-cancelled sop_run; only creates
 * one when none exists. Status defaults to 'in_progress' on creation —
 * the legacy scanners typically wrap their own auditRuns row for
 * status tracking, so the sop_run.status is informational, not the
 * source of truth.
 */

import { getDb, sopRuns, sopStepStates } from '@ai-edge/db';
import { and, desc, eq } from 'drizzle-orm';
import { getSopDefinition } from './registry';
import type { SopKey } from './types';

export async function ensureSopRun(
  firmId: string,
  sopKey: SopKey,
  createdBy: string,
): Promise<string> {
  const db = getDb();
  const def = getSopDefinition(sopKey);

  const [existing] = await db
    .select({ id: sopRuns.id, status: sopRuns.status })
    .from(sopRuns)
    .where(and(eq(sopRuns.firm_id, firmId), eq(sopRuns.sop_key, sopKey)))
    .orderBy(desc(sopRuns.created_at))
    .limit(1);

  if (existing && existing.status !== 'cancelled') return existing.id;

  const now = new Date();
  const [inserted] = await db
    .insert(sopRuns)
    .values({
      firm_id: firmId,
      sop_key: sopKey,
      phase: def.phase,
      status: 'in_progress',
      current_step: 1,
      started_at: now,
      meta: { scanner_managed: true, source: 'ensureSopRun', createdBy },
      created_by: createdBy,
    })
    .returning({ id: sopRuns.id });
  const runId = inserted!.id;

  await db.insert(sopStepStates).values(
    def.steps.map((s) => ({
      sop_run_id: runId,
      step_number: s.number,
      step_key: s.key,
      status: 'not_started' as const,
    })),
  );
  return runId;
}
