'use server';

/**
 * SOP engine server actions.
 *
 * The contract between the workflow UI (/dashboard/[firmSlug]/sops and
 * /sop/[sopKey]) and the database. State-machine transitions, gate
 * enforcement, deliverable generation, and ticket creation all funnel
 * through here.
 *
 * Pattern: every mutation runs revalidatePath on both the SOP detail
 * route and the firm-level /sops grid so the operator sees fresh state
 * after a click.
 */

import {
  getDb,
  firms,
  sopRuns,
  sopStepStates,
  sopDeliverables,
  remediationTickets,
} from '@ai-edge/db';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import {
  SOP_REGISTRY,
  getSopDefinition,
  isSopExecutable,
  PHASES,
} from '../lib/sop/registry';
import { dispatchStepGenerators } from '../lib/sop/generators';
import { resolveDataInput, type ResolvedDataInput } from '../lib/sop/data-resolvers';
import type {
  SopKey,
  SopRunStatus,
  SopStepStatus,
  SopDefinition,
  DeliverableKind,
  TicketFactoryKey,
} from '../lib/sop/types';

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

async function resolveFirmId(firmSlug: string): Promise<string> {
  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id })
    .from(firms)
    .where(eq(firms.slug, firmSlug))
    .limit(1);
  if (!firm) throw new Error(`Firm not found: ${firmSlug}`);
  return firm.id;
}

function revalidateSop(firmSlug: string, sopKey?: SopKey): void {
  // Best-effort: when called from non-Next contexts (scripts), revalidatePath
  // throws — swallow that so the action remains usable from outside the
  // request lifecycle.
  try {
    revalidatePath(`/dashboard/${firmSlug}/sops`);
    if (sopKey) revalidatePath(`/dashboard/${firmSlug}/sop/${sopKey}`);
    revalidatePath(`/dashboard/${firmSlug}/action-items`);
  } catch {
    /* not in a Next.js request context — fine */
  }
}

// ───────────────────────────────────────────────────────────────
// Read paths
// ───────────────────────────────────────────────────────────────

export interface SopRunSummary {
  id: string;
  sopKey: SopKey;
  phase: number;
  name: string;
  status: SopRunStatus;
  currentStep: number;
  totalSteps: number;
  startedAt: Date | null;
  completedAt: Date | null;
  nextReviewAt: Date | null;
  isExecutable: boolean;
  ticketCount: number;
  deliverableCount: number;
}

/**
 * Returns one row per SOP in the registry, joined with the firm's latest
 * run if one exists. Phase grid uses this to render every SOP whether or
 * not the operator has started it.
 */
export async function listSopRunsForFirm(firmSlug: string): Promise<SopRunSummary[]> {
  const firmId = await resolveFirmId(firmSlug);
  const db = getDb();

  // Latest run per sop_key for this firm. Drizzle's distinctOn would be ideal
  // but Neon HTTP serverless's PGlite layer doesn't always support it cleanly;
  // pull all runs and pick the latest in memory — N is tiny (24 SOPs × few
  // runs).
  const runs = await db
    .select()
    .from(sopRuns)
    .where(eq(sopRuns.firm_id, firmId))
    .orderBy(desc(sopRuns.created_at));

  const latestByKey = new Map<string, typeof runs[number]>();
  for (const r of runs) {
    if (!latestByKey.has(r.sop_key)) latestByKey.set(r.sop_key, r);
  }

  // Counts per run (tickets, deliverables) — one trip each, keyed by
  // sop_run_id. Uses inArray() rather than sql`= ANY(${runIds})` —
  // Drizzle does not auto-cast a JS array to a Postgres array parameter
  // and the raw template throws "op ANY/ALL (array) requires array on
  // right side" at runtime. Same bug we fixed in auto-start.ts. Worse
  // here because the page's .catch swallowed the throw and silently
  // returned an empty SopRunSummary list, which made every workflow
  // card render as "Coming soon" on firms that already had sop_run
  // rows.
  const runIds = [...latestByKey.values()].map((r) => r.id);
  const ticketCounts = new Map<string, number>();
  const deliverableCounts = new Map<string, number>();
  if (runIds.length > 0) {
    const tickets = await db
      .select({ sopRunId: remediationTickets.sop_run_id, count: sql<number>`count(*)::int` })
      .from(remediationTickets)
      .where(inArray(remediationTickets.sop_run_id, runIds))
      .groupBy(remediationTickets.sop_run_id);
    for (const t of tickets) {
      if (t.sopRunId) ticketCounts.set(t.sopRunId, t.count);
    }
    const dels = await db
      .select({ sopRunId: sopDeliverables.sop_run_id, count: sql<number>`count(*)::int` })
      .from(sopDeliverables)
      .where(inArray(sopDeliverables.sop_run_id, runIds))
      .groupBy(sopDeliverables.sop_run_id);
    for (const d of dels) {
      deliverableCounts.set(d.sopRunId, d.count);
    }
  }

  return Object.values(SOP_REGISTRY).map((def): SopRunSummary => {
    const run = latestByKey.get(def.key);
    return {
      id: run?.id ?? '',
      sopKey: def.key,
      phase: def.phase,
      name: def.name,
      status: (run?.status as SopRunStatus) ?? 'not_started',
      currentStep: run?.current_step ?? 0,
      totalSteps: def.steps.length,
      startedAt: run?.started_at ?? null,
      completedAt: run?.completed_at ?? null,
      nextReviewAt: run?.next_review_at ?? null,
      isExecutable: isSopExecutable(def.key),
      ticketCount: run ? (ticketCounts.get(run.id) ?? 0) : 0,
      deliverableCount: run ? (deliverableCounts.get(run.id) ?? 0) : 0,
    };
  });
}

export interface SopRunDetail {
  run: {
    id: string;
    firmId: string;
    sopKey: SopKey;
    phase: number;
    status: SopRunStatus;
    currentStep: number;
    startedAt: Date | null;
    completedAt: Date | null;
    pausedAt: Date | null;
    nextReviewAt: Date | null;
    meta: Record<string, unknown>;
  } | null;
  def: SopDefinition;
  steps: Array<{
    number: number;
    key: string;
    title: string;
    status: SopStepStatus;
    startedAt: Date | null;
    completedAt: Date | null;
    confirmations: unknown;
    outputSummary: Record<string, unknown>;
    notes: string | null;
  }>;
  deliverables: Array<{
    id: string;
    kind: DeliverableKind;
    name: string;
    generatedAt: Date;
    blobUrl: string | null;
  }>;
  ticketCount: number;
  dependencies: Array<{ sopKey: SopKey; name: string; status: SopRunStatus }>;
  /**
   * Resolved data-input values for each step, keyed by step_number.
   * Empty array for steps with no inputs configured. The workflow client
   * renders these as live data cards beside the step's process bullets.
   */
  resolvedDataInputs: Record<number, ResolvedDataInput[]>;
}

/**
 * Full detail for the SOP workflow page. Returns the def + the firm's
 * latest run (or null if not started) + per-step state + deliverables +
 * dependency status.
 */
export async function getSopRunDetail(firmSlug: string, sopKey: SopKey): Promise<SopRunDetail> {
  const firmId = await resolveFirmId(firmSlug);
  const db = getDb();
  const def = getSopDefinition(sopKey);

  const [run] = await db
    .select()
    .from(sopRuns)
    .where(and(eq(sopRuns.firm_id, firmId), eq(sopRuns.sop_key, sopKey)))
    .orderBy(desc(sopRuns.created_at))
    .limit(1);

  let stepStates: Array<typeof sopStepStates.$inferSelect> = [];
  let deliverables: Array<typeof sopDeliverables.$inferSelect> = [];
  let ticketCount = 0;
  if (run) {
    stepStates = await db
      .select()
      .from(sopStepStates)
      .where(eq(sopStepStates.sop_run_id, run.id))
      .orderBy(sopStepStates.step_number);
    deliverables = await db
      .select()
      .from(sopDeliverables)
      .where(eq(sopDeliverables.sop_run_id, run.id))
      .orderBy(desc(sopDeliverables.generated_at));
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(remediationTickets)
      .where(eq(remediationTickets.sop_run_id, run.id));
    ticketCount = rows[0]?.count ?? 0;
  }

  // Dependencies — for the "you should finish X first" banner.
  const dependencies: SopRunDetail['dependencies'] = [];
  for (const dep of def.dependsOnSops) {
    const depDef = SOP_REGISTRY[dep];
    const [depRun] = await db
      .select({ status: sopRuns.status })
      .from(sopRuns)
      .where(and(eq(sopRuns.firm_id, firmId), eq(sopRuns.sop_key, dep)))
      .orderBy(desc(sopRuns.created_at))
      .limit(1);
    dependencies.push({
      sopKey: dep,
      name: depDef.name,
      status: (depRun?.status as SopRunStatus) ?? 'not_started',
    });
  }

  // Build the merged step list — registry def merged with state.
  const stateByStep = new Map<number, typeof stepStates[number]>();
  for (const s of stepStates) stateByStep.set(s.step_number, s);

  const steps = def.steps.map((stepDef) => {
    const state = stateByStep.get(stepDef.number);
    return {
      number: stepDef.number,
      key: stepDef.key,
      title: stepDef.title,
      status: (state?.status as SopStepStatus) ?? 'not_started',
      startedAt: state?.started_at ?? null,
      completedAt: state?.completed_at ?? null,
      confirmations: state?.operator_confirmations ?? [],
      outputSummary: (state?.output_summary as Record<string, unknown>) ?? {},
      notes: state?.notes ?? null,
    };
  });

  // Resolve data inputs per step. Only resolve for steps with at least
  // one input; skip empty-skeleton Phase 2-7 steps and steps that have
  // no data dependencies. Run all resolutions in parallel for each step.
  const resolvedDataInputs: Record<number, ResolvedDataInput[]> = {};
  if (run) {
    const meta = (run.meta as Record<string, unknown>) ?? {};
    await Promise.all(
      def.steps.map(async (s) => {
        if (s.dataInputs.length === 0) {
          resolvedDataInputs[s.number] = [];
          return;
        }
        const resolved = await Promise.all(
          s.dataInputs.map((di) =>
            resolveDataInput(
              {
                firmId,
                sopRunMeta: meta,
                sopKey,
                stepNumber: s.number,
                sopRunId: run.id,
              },
              di.kind,
              di.label,
              di.anchor,
            ).catch((e) => ({
              kind: di.kind,
              label: di.label,
              available: false,
              summary: `Resolver error: ${e instanceof Error ? e.message : String(e)}`,
              tone: 'warn' as const,
            })),
          ),
        );
        resolvedDataInputs[s.number] = resolved;
      }),
    );
  }

  return {
    run: run
      ? {
          id: run.id,
          firmId: run.firm_id,
          sopKey: run.sop_key as SopKey,
          phase: run.phase,
          status: run.status as SopRunStatus,
          currentStep: run.current_step,
          startedAt: run.started_at,
          completedAt: run.completed_at,
          pausedAt: run.paused_at,
          nextReviewAt: run.next_review_at,
          meta: (run.meta as Record<string, unknown>) ?? {},
        }
      : null,
    def,
    steps,
    deliverables: deliverables.map((d) => ({
      id: d.id,
      kind: d.kind as DeliverableKind,
      name: d.name,
      generatedAt: d.generated_at,
      blobUrl: d.blob_url,
    })),
    ticketCount,
    dependencies,
    resolvedDataInputs,
  };
}

// ───────────────────────────────────────────────────────────────
// Mutation paths
// ───────────────────────────────────────────────────────────────

export interface StartSopInput {
  firmSlug: string;
  sopKey: SopKey;
  /**
   * Optional anchors to record in sop_run.meta — e.g. for Brand Visibility
   * Audit: { audit_run_id, brand_truth_version_id }.
   */
  anchors?: Record<string, unknown>;
  createdBy?: string;
  /**
   * If true, skip the dependency gate (operator override). Records the
   * override reason in meta.override_reason.
   */
  overrideReason?: string;
}

export async function startSopRun(input: StartSopInput): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const def = getSopDefinition(input.sopKey);
  const firmId = await resolveFirmId(input.firmSlug);
  const db = getDb();

  // Dependency check — soft enforcement.
  if (def.dependsOnSops.length > 0 && !input.overrideReason) {
    for (const dep of def.dependsOnSops) {
      const [depRun] = await db
        .select({ status: sopRuns.status, currentStep: sopRuns.current_step })
        .from(sopRuns)
        .where(and(eq(sopRuns.firm_id, firmId), eq(sopRuns.sop_key, dep)))
        .orderBy(desc(sopRuns.created_at))
        .limit(1);
      if (!depRun || (depRun.status !== 'completed' && depRun.status !== 'in_progress')) {
        return {
          ok: false,
          error: `Dependency not met: ${SOP_REGISTRY[dep].name} must be at least in_progress before starting ${def.name}. Pass overrideReason to skip.`,
        };
      }
    }
  }

  const meta: Record<string, unknown> = { ...(input.anchors ?? {}) };
  if (input.overrideReason) meta.override_reason = input.overrideReason;

  const [run] = await db
    .insert(sopRuns)
    .values({
      firm_id: firmId,
      sop_key: input.sopKey,
      phase: def.phase,
      status: 'in_progress',
      current_step: 1,
      started_at: new Date(),
      meta,
      created_by: input.createdBy ?? 'operator',
    })
    .returning({ id: sopRuns.id });

  if (!run) return { ok: false, error: 'Failed to insert sop_run row' };

  // Seed sop_step_state for every step in the definition (status: not_started
  // except step 1 which is in_progress).
  await db.insert(sopStepStates).values(
    def.steps.map((s) => ({
      sop_run_id: run.id,
      step_number: s.number,
      step_key: s.key,
      status: s.number === 1 ? 'in_progress' : 'not_started',
      started_at: s.number === 1 ? new Date() : null,
    })),
  );

  revalidateSop(input.firmSlug, input.sopKey);
  return { ok: true, runId: run.id };
}

export interface CompleteStepInput {
  firmSlug: string;
  sopKey: SopKey;
  runId: string;
  stepNumber: number;
  /**
   * Operator confirmations keyed by gate.key, e.g.
   *   { positioning_statement_confirmed: true, ... }
   * For free_text gates, value is the entered text; for attestation, the
   * truthy boolean is what's checked.
   */
  confirmations: Record<string, string | boolean>;
  /**
   * Structured summary the step produced. Persisted to
   * sop_step_state.output_summary so downstream steps can read it via
   * dataInputs of kind 'previous_sop_output'.
   */
  outputSummary?: Record<string, unknown>;
  notes?: string;
}

export async function completeStep(input: CompleteStepInput): Promise<
  { ok: true; nextStep: number | null } | { ok: false; error: string; missingGates?: string[] }
> {
  const def = getSopDefinition(input.sopKey);
  const stepDef = def.steps.find((s) => s.number === input.stepNumber);
  if (!stepDef) return { ok: false, error: `Step ${input.stepNumber} not found in ${input.sopKey}` };

  // Gate enforcement — every required gate must have a truthy entry in
  // confirmations.
  const missing = stepDef.gates
    .filter((g) => g.required)
    .filter((g) => {
      const v = input.confirmations[g.key];
      if (g.kind === 'free_text') return !v || typeof v !== 'string' || v.trim().length === 0;
      return !v;
    })
    .map((g) => g.key);
  if (missing.length > 0) {
    return { ok: false, error: 'One or more required gates are not satisfied', missingGates: missing };
  }

  const db = getDb();
  const now = new Date();
  const confirmedBy = 'operator';

  const confirmationRecords = Object.entries(input.confirmations).map(([key, value]) => {
    const gate = stepDef.gates.find((g) => g.key === key);
    return {
      key,
      label: gate?.label ?? key,
      confirmed_at: now.toISOString(),
      confirmed_by: confirmedBy,
      ...(typeof value === 'string' ? { value } : {}),
    };
  });

  await db
    .update(sopStepStates)
    .set({
      status: 'completed',
      completed_at: now,
      operator_confirmations: confirmationRecords,
      output_summary: input.outputSummary ?? {},
      notes: input.notes ?? null,
    })
    .where(and(eq(sopStepStates.sop_run_id, input.runId), eq(sopStepStates.step_number, input.stepNumber)));

  // Fire generators if the step defines any. Failures inside the
  // dispatcher are non-fatal — they're returned as warnings and stored
  // on the step's output_summary so the operator can see them.
  let generatorWarnings: string[] = [];
  if (stepDef.generates) {
    try {
      const firmId = await resolveFirmId(input.firmSlug);
      const dispatchResult = await dispatchStepGenerators({
        firmSlug: input.firmSlug,
        firmId,
        sopKey: input.sopKey,
        runId: input.runId,
        stepNumber: input.stepNumber,
        stepDef,
      });
      generatorWarnings = dispatchResult.warnings;
      if (dispatchResult.ticketsCreated > 0 || dispatchResult.deliverablesCreated > 0 || generatorWarnings.length > 0) {
        // Patch the output_summary to record what generators did.
        await db
          .update(sopStepStates)
          .set({
            output_summary: {
              ...(input.outputSummary ?? {}),
              generators: {
                ticketsCreated: dispatchResult.ticketsCreated,
                deliverablesCreated: dispatchResult.deliverablesCreated,
                warnings: generatorWarnings,
              },
            },
          })
          .where(and(eq(sopStepStates.sop_run_id, input.runId), eq(sopStepStates.step_number, input.stepNumber)));
      }
    } catch (e) {
      generatorWarnings.push(`dispatchStepGenerators threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Advance the run.
  const isLastStep = input.stepNumber === def.steps.length;
  if (isLastStep) {
    // Compute next_review_at based on cadence.
    let nextReviewAt: Date | null = null;
    if (typeof def.cadence === 'object' && 'intervalDays' in def.cadence) {
      nextReviewAt = new Date(now.getTime() + def.cadence.intervalDays * 86_400_000);
    }
    await db
      .update(sopRuns)
      .set({
        status: 'completed',
        completed_at: now,
        next_review_at: nextReviewAt,
      })
      .where(eq(sopRuns.id, input.runId));
    revalidateSop(input.firmSlug, input.sopKey);
    return { ok: true, nextStep: null };
  } else {
    const next = input.stepNumber + 1;
    await db
      .update(sopRuns)
      .set({ current_step: next })
      .where(eq(sopRuns.id, input.runId));
    // Move the next step to in_progress.
    await db
      .update(sopStepStates)
      .set({ status: 'in_progress', started_at: now })
      .where(and(eq(sopStepStates.sop_run_id, input.runId), eq(sopStepStates.step_number, next)));
    revalidateSop(input.firmSlug, input.sopKey);
    return { ok: true, nextStep: next };
  }
}

export async function pauseSopRun(input: { firmSlug: string; sopKey: SopKey; runId: string; reason: string }): Promise<void> {
  const db = getDb();
  await db
    .update(sopRuns)
    .set({
      status: 'paused',
      paused_at: new Date(),
      meta: sql`COALESCE(${sopRuns.meta}, '{}'::jsonb) || ${JSON.stringify({ pause_reason: input.reason })}::jsonb`,
    })
    .where(eq(sopRuns.id, input.runId));
  revalidateSop(input.firmSlug, input.sopKey);
}

export async function resumeSopRun(input: { firmSlug: string; sopKey: SopKey; runId: string }): Promise<void> {
  const db = getDb();
  await db
    .update(sopRuns)
    .set({ status: 'in_progress', paused_at: null })
    .where(eq(sopRuns.id, input.runId));
  revalidateSop(input.firmSlug, input.sopKey);
}

export async function cancelSopRun(input: { firmSlug: string; sopKey: SopKey; runId: string; reason: string }): Promise<void> {
  const db = getDb();
  await db
    .update(sopRuns)
    .set({
      status: 'cancelled',
      meta: sql`COALESCE(${sopRuns.meta}, '{}'::jsonb) || ${JSON.stringify({ cancel_reason: input.reason })}::jsonb`,
    })
    .where(eq(sopRuns.id, input.runId));
  revalidateSop(input.firmSlug, input.sopKey);
}

// ───────────────────────────────────────────────────────────────
// Deliverable generation (dispatch + per-kind builders go on Day 2)
// ───────────────────────────────────────────────────────────────

export interface DeliverableResult {
  id: string;
  kind: DeliverableKind;
  name: string;
  blobUrl: string | null;
  payloadPreview?: string;
}

/**
 * Manually regenerate a deliverable for a SOP run. Used by the operator
 * when they want to refresh an artifact after editing Brand Truth /
 * running a fresh audit / fixing an upstream input. Dispatches to the
 * same per-kind builders in lib/sop/generators.ts that completeStep
 * fires automatically on step completion — so this never persists
 * placeholder data; if no builder is wired for the requested kind, we
 * surface that as an error instead of pretending the deliverable was
 * generated.
 */
export async function generateDeliverable(input: {
  firmSlug: string;
  sopKey: SopKey;
  runId: string;
  kind: DeliverableKind;
  stepNumber: number;
}): Promise<DeliverableResult> {
  const def = getSopDefinition(input.sopKey);
  const stepDef = def.steps.find((s) => s.number === input.stepNumber);
  if (!stepDef) throw new Error(`Step ${input.stepNumber} not found on ${input.sopKey}`);
  if (!stepDef.generates?.deliverableKinds?.includes(input.kind)) {
    throw new Error(
      `Step ${input.stepNumber} of ${input.sopKey} does not declare deliverable ${input.kind}. ` +
        `Use the SOP registry to wire the deliverable to a step first.`,
    );
  }

  const firmId = await resolveFirmId(input.firmSlug);
  const result = await dispatchStepGenerators({
    firmSlug: input.firmSlug,
    firmId,
    sopKey: input.sopKey,
    runId: input.runId,
    stepNumber: input.stepNumber,
    stepDef,
  });

  if (result.warnings.length > 0 && result.deliverablesCreated === 0) {
    throw new Error(`Deliverable generation failed: ${result.warnings.join('; ')}`);
  }

  // Return the newest deliverable for this run+kind so the UI can link
  // straight to it.
  const db = getDb();
  const [latest] = await db
    .select({
      id: sopDeliverables.id,
      kind: sopDeliverables.kind,
      name: sopDeliverables.name,
      blobUrl: sopDeliverables.blob_url,
    })
    .from(sopDeliverables)
    .where(and(eq(sopDeliverables.sop_run_id, input.runId), eq(sopDeliverables.kind, input.kind)))
    .orderBy(desc(sopDeliverables.generated_at))
    .limit(1);
  if (!latest) throw new Error('Deliverable was not persisted by the builder');
  revalidateSop(input.firmSlug, input.sopKey);
  return {
    id: latest.id,
    kind: latest.kind as DeliverableKind,
    name: latest.name,
    blobUrl: latest.blobUrl,
  };
}

// ───────────────────────────────────────────────────────────────
// Ticket creation + assignment
// ───────────────────────────────────────────────────────────────

export interface CreateTicketInput {
  firmSlug: string;
  sopKey: SopKey;
  runId: string;
  stepNumber: number;
  title: string;
  description?: string;
  priorityRank?: number;
  remediationCopy?: string;
  validationSteps?: Array<{ description: string }>;
  evidenceLinks?: Array<{ kind: string; url: string; description?: string }>;
  owner?: string;
  dueAt?: Date;
}

export async function createTicketFromStep(input: CreateTicketInput): Promise<{ id: string }> {
  const firmId = await resolveFirmId(input.firmSlug);
  const db = getDb();
  // Use the sop_step_state.id as source_id so the legacy source_type+source_id
  // contract still resolves. Look up the step state row.
  const [state] = await db
    .select({ id: sopStepStates.id })
    .from(sopStepStates)
    .where(and(eq(sopStepStates.sop_run_id, input.runId), eq(sopStepStates.step_number, input.stepNumber)))
    .limit(1);
  if (!state) throw new Error(`sop_step_state not found for run=${input.runId} step=${input.stepNumber}`);

  const ticketRows = await db
    .insert(remediationTickets)
    .values({
      firm_id: firmId,
      source_type: 'sop',
      source_id: state.id,
      sop_run_id: input.runId,
      sop_step_number: input.stepNumber,
      title: input.title,
      description: input.description,
      priority_rank: input.priorityRank,
      remediation_copy: input.remediationCopy,
      validation_steps: input.validationSteps?.map((v) => ({ description: v.description })),
      evidence_links: input.evidenceLinks?.map((e) => ({
        kind: e.kind as 'llm_citation' | 'page_url' | 'third_party_listing' | 'aio_source' | 'reddit_thread',
        url: e.url,
        description: e.description,
      })),
      owner: input.owner,
      due_at: input.dueAt,
      playbook_step: `${input.sopKey}/step-${input.stepNumber}`,
    })
    .returning({ id: remediationTickets.id });
  const t = ticketRows[0];
  if (!t) throw new Error('Failed to insert remediation_ticket');
  revalidateSop(input.firmSlug, input.sopKey);
  return { id: t.id };
}

export async function assignTicket(input: {
  firmSlug: string;
  ticketId: string;
  owner?: string;
  dueAt?: Date | null;
  priorityRank?: number;
}): Promise<void> {
  const db = getDb();
  const patch: Record<string, unknown> = {};
  if (input.owner !== undefined) patch.owner = input.owner;
  if (input.dueAt !== undefined) patch.due_at = input.dueAt;
  if (input.priorityRank !== undefined) patch.priority_rank = input.priorityRank;
  if (Object.keys(patch).length === 0) return;
  await db.update(remediationTickets).set(patch).where(eq(remediationTickets.id, input.ticketId));
  try {
    revalidatePath(`/dashboard/${input.firmSlug}/action-items`);
  } catch { /* not in request context */ }
}

// ───────────────────────────────────────────────────────────────
// Phase grid summary — for the /sops route header
// ───────────────────────────────────────────────────────────────

export interface PhaseGridSummary {
  phase: number;
  name: string;
  description: string;
  total: number;
  notStarted: number;
  inProgress: number;
  completed: number;
}

export async function getPhaseGridSummary(firmSlug: string): Promise<PhaseGridSummary[]> {
  const runs = await listSopRunsForFirm(firmSlug);
  return PHASES.map((p): PhaseGridSummary => {
    const phaseRuns = runs.filter((r) => r.phase === p.phase);
    return {
      phase: p.phase,
      name: p.name,
      description: p.description,
      total: phaseRuns.length,
      notStarted: phaseRuns.filter((r) => r.status === 'not_started').length,
      inProgress: phaseRuns.filter((r) => r.status === 'in_progress' || r.status === 'awaiting_input').length,
      completed: phaseRuns.filter((r) => r.status === 'completed').length,
    };
  });
}
