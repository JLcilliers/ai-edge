/**
 * Generator dispatcher — called by completeStep when a step's
 * `generates` field is set in the registry. Routes to the right
 * ticket factory + deliverable builder.
 *
 * Failures here don't block step completion — they're logged and
 * surfaced as warnings on the step's output_summary. The operator can
 * always retry generation from the step detail page.
 */

import { getDb, sopRuns, sopDeliverables, firms } from '@ai-edge/db';
import { eq } from 'drizzle-orm';
import type { SopDefinition, SopKey } from './types';
import { generatePriorityActions } from './ticket-factories/priority-actions';
import { generateSuppressionTickets } from './ticket-factories/suppression-decisions';
import { buildComparisonMatrixXlsx } from './deliverables/comparison-matrix-xlsx';
import { buildSuppressionArtifacts } from './deliverables/suppression-artifacts';
import {
  buildMessagingArtifacts,
  generateThirdPartyListingTickets,
} from './deliverables/messaging-artifacts';

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

  if (gen.ticketsFromFactory === 'third_party_listing_updates') {
    try {
      const [firmRow] = await db
        .select({ name: firms.name })
        .from(firms)
        .where(eq(firms.id, input.firmId))
        .limit(1);
      const r = await generateThirdPartyListingTickets({
        firmSlug: input.firmSlug,
        firmId: input.firmId,
        firmName: firmRow?.name ?? 'Firm',
        sopKey: 'brand_messaging_standardization',
        runId: input.runId,
        stepNumber: input.stepNumber,
      });
      out.ticketsCreated += r.created.length;
    } catch (e) {
      out.warnings.push(`third_party_listing_updates failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (gen.ticketsFromFactory === 'suppression_decisions_to_tickets') {
    try {
      const [firmRow] = await db
        .select({ name: firms.name })
        .from(firms)
        .where(eq(firms.id, input.firmId))
        .limit(1);
      const primaryUrl = typeof (anchors.primary_url) === 'string' ? (anchors.primary_url as string) : null;
      const r = await generateSuppressionTickets({
        firmSlug: input.firmSlug,
        firmId: input.firmId,
        firmName: firmRow?.name ?? 'Firm',
        primaryUrl,
        sopKey: 'legacy_content_suppression',
        runId: input.runId,
        stepNumber: input.stepNumber,
      });
      out.ticketsCreated += r.created.length;
    } catch (e) {
      out.warnings.push(`suppression_decisions failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Other factories — schema_patches_per_page, reddit_escalations,
  // citation_diff_alerts — land in Day 3.
  if (
    gen.ticketsFromFactory &&
    gen.ticketsFromFactory !== 'priority_actions_from_visibility_audit' &&
    gen.ticketsFromFactory !== 'suppression_decisions_to_tickets' &&
    gen.ticketsFromFactory !== 'third_party_listing_updates'
  ) {
    out.warnings.push(`Factory '${gen.ticketsFromFactory}' wired on Day 3.`);
  }

  // Deliverable builders.
  if (gen.deliverableKinds?.length) {
    for (const kind of gen.deliverableKinds) {
      if (kind === 'comparison_matrix_xlsx') {
        const auditRunId = typeof anchors.auditRunId === 'string' ? anchors.auditRunId : undefined;
        if (!auditRunId) {
          out.warnings.push(`${kind}: no auditRunId in run.meta.anchors — skipping`);
          continue;
        }
        try {
          const [firmRow] = await db.select({ name: firms.name }).from(firms).where(eq(firms.id, input.firmId)).limit(1);
          const result = await buildComparisonMatrixXlsx({
            firmName: firmRow?.name ?? 'Firm',
            auditRunId,
            generatedAt: new Date(),
          });
          await db.insert(sopDeliverables).values({
            sop_run_id: input.runId,
            kind,
            name: result.filename,
            payload: {
              filename: result.filename,
              bytes: result.bytes,
              rowCount: result.rowCount,
              auditRunId,
            },
            blob_url: result.blobUrl,
          });
          out.deliverablesCreated += 1;
        } catch (e) {
          out.warnings.push(`${kind} builder failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (
        kind === 'decision_matrix_csv' ||
        kind === 'redirect_map_csv' ||
        kind === 'phased_implementation_plan_md'
      ) {
        // Build once for the run and emit all three artifacts together —
        // they all come from the same decision pass. Avoid rebuilding when
        // multiple kinds are listed on the same step.
        try {
          const [firmRow] = await db
            .select({ name: firms.name })
            .from(firms)
            .where(eq(firms.id, input.firmId))
            .limit(1);
          const primaryUrl = typeof anchors.primary_url === 'string' ? (anchors.primary_url as string) : null;
          const artifacts = await buildSuppressionArtifacts({
            firmId: input.firmId,
            firmName: firmRow?.name ?? 'Firm',
            primaryUrl,
            generatedAt: new Date(),
          });
          const persist = async (k: string, name: string, blobUrl: string | null, payload: Record<string, unknown>) => {
            await db.insert(sopDeliverables).values({
              sop_run_id: input.runId,
              kind: k,
              name,
              payload,
              blob_url: blobUrl,
            });
            out.deliverablesCreated += 1;
          };
          if (kind === 'decision_matrix_csv') {
            await persist('decision_matrix_csv', artifacts.decisionMatrix.filename, artifacts.decisionMatrix.blobUrl, {
              filename: artifacts.decisionMatrix.filename,
              rowCount: artifacts.decisionMatrix.rowCount,
            });
          } else if (kind === 'redirect_map_csv') {
            await persist('redirect_map_csv', artifacts.redirectMap.filename, artifacts.redirectMap.blobUrl, {
              filename: artifacts.redirectMap.filename,
              rowCount: artifacts.redirectMap.rowCount,
            });
          } else {
            await persist('phased_implementation_plan_md', artifacts.phasedPlan.filename, artifacts.phasedPlan.blobUrl, {
              filename: artifacts.phasedPlan.filename,
              bytes: artifacts.phasedPlan.bytes,
            });
          }
        } catch (e) {
          out.warnings.push(`${kind} builder failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (
        kind === 'messaging_framework_md' ||
        kind === 'schema_bundle_jsonld' ||
        kind === 'messaging_guide_md'
      ) {
        // Build all three from a single Brand Truth pass. Persist
        // only the one matching this dispatcher call to avoid
        // duplicates when multiple kinds share a step.
        try {
          const [firmRow] = await db
            .select({ name: firms.name })
            .from(firms)
            .where(eq(firms.id, input.firmId))
            .limit(1);
          const artifacts = await buildMessagingArtifacts({
            firmId: input.firmId,
            firmName: firmRow?.name ?? 'Firm',
            generatedAt: new Date(),
          });
          if (!artifacts) {
            out.warnings.push(`${kind}: no brand_truth_version exists for this firm — skipping`);
            continue;
          }
          const target =
            kind === 'messaging_framework_md'
              ? artifacts.framework
              : kind === 'schema_bundle_jsonld'
                ? artifacts.schemaBundle
                : artifacts.guide;
          await db.insert(sopDeliverables).values({
            sop_run_id: input.runId,
            kind,
            name: target.filename,
            payload: { filename: target.filename, bytes: target.bytes },
            blob_url: target.blobUrl,
          });
          out.deliverablesCreated += 1;
        } catch (e) {
          out.warnings.push(`${kind} builder failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        // Other deliverable kinds (monitoring_log_md, weekly_report_md,
        // audit_delivery_pdf) — Day 3 work.
        out.warnings.push(`Deliverable '${kind}' builder lands in Day 3.`);
      }
    }
  }

  return out;
}
