/**
 * Auto-start SOP runs based on existing data.
 *
 * The first time an operator hits /dashboard/[firmSlug]/sops, we want
 * Phase 1 SOPs to already reflect what's been done. For Andrew Pickett
 * Law specifically:
 *   - Brand Visibility Audit: there's a completed audit_run → start a
 *     sop_run at Step 4 (audit data is in hand; alignment scoring is
 *     the operator's next manual step).
 *   - Legacy Content Suppression: legacy_findings exist → start at
 *     Step 3 (decision framework).
 *   - Brand Messaging Standardization: brand_truth_version exists →
 *     start at Step 1 (still need to inventory third-party listings).
 *
 * This module is idempotent: it never creates duplicate runs for the
 * same firm+sop_key. If a run already exists at any status (including
 * cancelled), we leave it alone.
 *
 * Wired into the /sops page server component as a fire-and-forget call
 * so the page renders with the right starter state without requiring
 * the operator to click "Start SOP" on every SOP individually.
 */

import {
  getDb,
  firms,
  sopRuns,
  sopStepStates,
  auditRuns,
  legacyFindings,
  brandTruthVersions,
  pages,
} from '@ai-edge/db';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { SopKey } from './types';
import { getSopDefinition } from './registry';

interface PhaseOneAnchors {
  auditRunId?: string;
  brandTruthVersionId?: string;
  legacyFindingsCount?: number;
  pagesCount?: number;
}

/**
 * Inspect the firm's data and return anchor IDs for Phase 1 SOPs.
 */
async function gatherPhaseOneAnchors(firmId: string): Promise<PhaseOneAnchors> {
  const db = getDb();
  const [latestAudit] = await db
    .select({ id: auditRuns.id })
    .from(auditRuns)
    .where(and(eq(auditRuns.firm_id, firmId), sql`${auditRuns.status} IN ('completed', 'completed_partial')`))
    .orderBy(desc(auditRuns.finished_at))
    .limit(1);
  const [latestBT] = await db
    .select({ id: brandTruthVersions.id })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  // Pages table doesn't have firm_id directly — it's joined through firm
  // via a separate scan record. For the auto-start anchor, we just want
  // a "do legacy findings exist for this firm?" check.
  const findingsRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(legacyFindings)
    .innerJoin(pages, eq(legacyFindings.page_id, pages.id))
    .where(eq(pages.firm_id, firmId));
  const pagesRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pages)
    .where(eq(pages.firm_id, firmId));
  return {
    auditRunId: latestAudit?.id,
    brandTruthVersionId: latestBT?.id,
    legacyFindingsCount: findingsRows[0]?.count ?? 0,
    pagesCount: pagesRows[0]?.count ?? 0,
  };
}

/**
 * Best guess at which step the operator is "currently on" given the
 * data we have. Returns 1 for SOPs we can't infer for.
 */
function inferCurrentStep(sopKey: SopKey, anchors: PhaseOneAnchors): number {
  switch (sopKey) {
    case 'brand_visibility_audit':
      // Audit is done → operator is at Step 4 (alignment review).
      return anchors.auditRunId ? 4 : 1;
    case 'legacy_content_suppression':
      // Findings exist → operator is at Step 3 (decision framework).
      return (anchors.legacyFindingsCount ?? 0) > 0 ? 3 : 1;
    case 'brand_messaging_standardization':
      // Brand Truth exists → operator can start at Step 1 (extract
      // existing descriptions across platforms).
      return anchors.brandTruthVersionId ? 1 : 1;
    default:
      return 1;
  }
}

/**
 * Auto-create Phase 1 SOP runs for the firm if they don't already
 * exist. Idempotent. Returns the list of sop_keys that were created
 * (empty if everything already existed).
 */
export async function ensurePhaseOneSopRuns(firmId: string): Promise<SopKey[]> {
  const db = getDb();
  const phaseOneKeys: SopKey[] = [
    'brand_visibility_audit',
    'legacy_content_suppression',
    'brand_messaging_standardization',
  ];

  // Which Phase 1 SOPs already have a run for this firm?
  const existing = await db
    .select({ sopKey: sopRuns.sop_key })
    .from(sopRuns)
    .where(and(eq(sopRuns.firm_id, firmId), sql`${sopRuns.sop_key} = ANY(${phaseOneKeys})`));
  const existingKeys = new Set(existing.map((r) => r.sopKey));

  const toCreate = phaseOneKeys.filter((k) => !existingKeys.has(k));
  if (toCreate.length === 0) return [];

  const anchors = await gatherPhaseOneAnchors(firmId);
  const created: SopKey[] = [];

  for (const sopKey of toCreate) {
    const def = getSopDefinition(sopKey);
    const inferredStep = inferCurrentStep(sopKey, anchors);
    const now = new Date();
    const meta: Record<string, unknown> = {
      auto_started: true,
      anchors,
    };

    const inserted = await db
      .insert(sopRuns)
      .values({
        firm_id: firmId,
        sop_key: sopKey,
        phase: def.phase,
        status: 'in_progress',
        current_step: inferredStep,
        started_at: now,
        meta,
        created_by: 'system:auto-start',
      })
      .returning({ id: sopRuns.id });
    const run = inserted[0];
    if (!run) continue;

    // Seed step states. Steps 1..(inferredStep-1) are completed; the
    // inferred step is in_progress; the rest are not_started.
    const stepValues = def.steps.map((s) => {
      if (s.number < inferredStep) {
        return {
          sop_run_id: run.id,
          step_number: s.number,
          step_key: s.key,
          status: 'completed' as const,
          started_at: now,
          completed_at: now,
          output_summary: { auto_started: true },
        };
      } else if (s.number === inferredStep) {
        return {
          sop_run_id: run.id,
          step_number: s.number,
          step_key: s.key,
          status: 'in_progress' as const,
          started_at: now,
        };
      } else {
        return {
          sop_run_id: run.id,
          step_number: s.number,
          step_key: s.key,
          status: 'not_started' as const,
        };
      }
    });

    if (stepValues.length > 0) {
      await db.insert(sopStepStates).values(stepValues);
    }
    created.push(sopKey);
  }

  return created;
}

/**
 * Same but takes a firm slug — convenience for callers that don't
 * already have the firm UUID.
 */
export async function ensurePhaseOneSopRunsBySlug(firmSlug: string): Promise<SopKey[]> {
  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id })
    .from(firms)
    .where(eq(firms.slug, firmSlug))
    .limit(1);
  if (!firm) return [];
  return ensurePhaseOneSopRuns(firm.id);
}
