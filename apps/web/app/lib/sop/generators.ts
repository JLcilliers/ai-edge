/**
 * Generator dispatcher — called by completeStep when a step's
 * `generates` field is set in the registry. Routes to the right
 * ticket factory + deliverable builder.
 *
 * Failures here don't block step completion — they're logged and
 * surfaced as warnings on the step's output_summary. The operator can
 * always retry generation from the step detail page.
 */

import { getDb, sopRuns } from '@ai-edge/db';
import { eq } from 'drizzle-orm';
import type { SopDefinition, SopKey } from './types';
import { generatePriorityActions } from './ticket-factories/priority-actions';

interface DispatchInput {
  firmSlug: string;
  firmId: string;
  sopKey: SopKey;
  runId: string;
  stepNumber: number;
  stepDef: SopDefinition['steps'][number];
}

interface DispatchOutput {
  ticketsCreated: number;
  deliverablesCreated: number;
  warnings: string[];
}

export async function dispatchStepGenerators(input: DispatchInput): Promise<DispatchOutput> {
  const out: DispatchOutput = { ticketsCreated: 0, deliverablesCreated: 0, warnings: [] };
  const gen = input.stepDef.generates;
  if (!gen) return out;

  // Resolve the run's meta so factories can read anchors.
  const db = getDb();
  const [run] = await db
    .select({ meta: sopRuns.meta })
    .from(sopRuns)
    .where(eq(sopRuns.id, input.runId))
    .limit(1);
  const anchors = ((run?.meta as Record<string, unknown> | undefined)?.anchors ?? {}) as Record<string, unknown>;

  // Ticket factories.
  if (gen.ticketsFromFactory === 'priority_actions_from_visibility_audit') {
    const auditRunId = typeof anchors.auditRunId === 'string' ? anchors.auditRunId : undefined;
    if (!auditRunId) {
      out.warnings.push('priority_actions: no auditRunId in run.meta.anchors — skipping');
    } else {
      try {
        const r = await generatePriorityActions({
          firmSlug: input.firmSlug,
          firmId: input.firmId,
          sopKey: 'brand_visibility_audit',
          runId: input.runId,
          stepNumber: input.stepNumber,
          auditRunId,
        });
        out.ticketsCreated += r.created.length;
      } catch (e) {
        out.warnings.push(`priority_actions failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Other factories — suppression, third_party, schema, etc. — stub for
  // Day 2 continuation.
  if (
    gen.ticketsFromFactory &&
    gen.ticketsFromFactory !== 'priority_actions_from_visibility_audit'
  ) {
    out.warnings.push(`Factory '${gen.ticketsFromFactory}' wired on Day 2D/E (after priority_actions lands).`);
  }

  // Deliverable builders — wired Day 2 next pass.
  if (gen.deliverableKinds?.length) {
    out.warnings.push(
      `Deliverables [${gen.deliverableKinds.join(', ')}] queued — builders land in the next Day 2 commit.`,
    );
  }

  return out;
}
