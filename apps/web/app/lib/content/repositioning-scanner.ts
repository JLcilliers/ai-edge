/**
 * Content Repositioning scanner — Phase 3 SOP `content_repositioning`.
 *
 * Reuses the Suppression scan's `Keep + update` bucket. The Suppression
 * deliverable builder (lib/sop/deliverables/suppression-artifacts.ts)
 * already runs the decision framework:
 *
 *   ≥50 clicks/mo + drifted from Brand Truth → action='keep'
 *      → "refresh in place rather than suppress"
 *
 * Those pages are *not* suppression candidates — they have real traffic
 * and real authority. They're Content Repositioning candidates: rewrite
 * them in place to match current Brand Truth.
 *
 * The Suppression ticket factory already emits a "Refresh content"
 * ticket for these pages, but those tickets are attached to the
 * legacy_content_suppression sop_run, so they don't surface in Phase 3's
 * task list. This scanner is the bridge — it re-emits them attached to
 * the content_repositioning sop_run with a proper SOP-aligned rewrite
 * checklist (intro + H1 + meta → body restructure → schema update →
 * publish + verify).
 *
 * Per run:
 *   1. Resolve firm + load Brand Truth.
 *   2. Call buildSuppressionArtifacts() to get the current decision matrix.
 *   3. Filter to action='keep' rows.
 *   4. Create or update the content_repositioning sop_run.
 *   5. Clear prior open tickets on this run.
 *   6. Emit one assist-tier ticket per keep page, sorted by clicks DESC
 *      (highest-traffic pages have biggest upside from a refresh).
 *
 * If Suppression has never run for the firm, the scanner emits a single
 * config-gate ticket pointing at the Suppression scan.
 */

import {
  getDb,
  firms,
  legacyFindings,
  pages,
  sopRuns,
  sopStepStates,
  remediationTickets,
  brandTruthVersions,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { createTicketFromStep } from '../../actions/sop-actions';
import { getSopDefinition } from '../sop/registry';
import { computePriority } from '../sop/priority-score';
import { buildSuppressionArtifacts } from '../sop/deliverables/suppression-artifacts';

const SOP_KEY = 'content_repositioning' as const;
// Tickets attach to step 2 (Identify Required Changes) — the synthesis
// step where the operator decides what to rewrite.
const TICKET_STEP_NUMBER = 2;

export interface RepositioningScanResult {
  runId: string;
  candidatesFound: number;
  ticketsCreated: number;
  totalKeepClicks: number;
  /** True when Suppression hasn't run yet — scanner emitted a config-gate ticket. */
  blockedOnSuppression: boolean;
}

interface FirmRow {
  id: string;
  slug: string;
  name: string;
  primaryUrl: string | null;
}

async function resolveFirm(arg: { id?: string; slug?: string }): Promise<FirmRow> {
  const db = getDb();
  if (arg.id) {
    const [f] = await db
      .select({ id: firms.id, slug: firms.slug, name: firms.name })
      .from(firms)
      .where(eq(firms.id, arg.id))
      .limit(1);
    if (!f) throw new Error(`Firm not found: ${arg.id}`);
    // Pull primary URL from latest Brand Truth.
    const [bt] = await db
      .select({ payload: brandTruthVersions.payload })
      .from(brandTruthVersions)
      .where(eq(brandTruthVersions.firm_id, f.id))
      .orderBy(desc(brandTruthVersions.version))
      .limit(1);
    const primaryUrl =
      (bt?.payload as { primary_url?: string } | undefined)?.primary_url ?? null;
    return { ...f, primaryUrl };
  }
  if (arg.slug) {
    const [f] = await db
      .select({ id: firms.id, slug: firms.slug, name: firms.name })
      .from(firms)
      .where(eq(firms.slug, arg.slug))
      .limit(1);
    if (!f) throw new Error(`Firm not found: ${arg.slug}`);
    const [bt] = await db
      .select({ payload: brandTruthVersions.payload })
      .from(brandTruthVersions)
      .where(eq(brandTruthVersions.firm_id, f.id))
      .orderBy(desc(brandTruthVersions.version))
      .limit(1);
    const primaryUrl =
      (bt?.payload as { primary_url?: string } | undefined)?.primary_url ?? null;
    return { ...f, primaryUrl };
  }
  throw new Error('resolveFirm: id or slug required');
}

async function findOrCreateScannerRun(firmId: string): Promise<string> {
  const db = getDb();
  const def = getSopDefinition(SOP_KEY);

  const [existing] = await db
    .select({ id: sopRuns.id, status: sopRuns.status })
    .from(sopRuns)
    .where(and(eq(sopRuns.firm_id, firmId), eq(sopRuns.sop_key, SOP_KEY)))
    .orderBy(desc(sopRuns.created_at))
    .limit(1);

  if (existing && existing.status !== 'cancelled') {
    return existing.id;
  }

  const now = new Date();
  const [inserted] = await db
    .insert(sopRuns)
    .values({
      firm_id: firmId,
      sop_key: SOP_KEY,
      phase: def.phase,
      status: 'in_progress',
      current_step: 1,
      started_at: now,
      meta: { scanner_managed: true },
      created_by: 'scanner:repositioning',
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

async function clearPriorOpenTickets(firmId: string, runId: string): Promise<void> {
  const db = getDb();
  await db
    .delete(remediationTickets)
    .where(
      and(
        eq(remediationTickets.firm_id, firmId),
        eq(remediationTickets.sop_run_id, runId),
        eq(remediationTickets.sop_step_number, TICKET_STEP_NUMBER),
        inArray(remediationTickets.status, ['open', 'in_progress']),
      ),
    );
}

async function markScannerStepsComplete(runId: string): Promise<void> {
  const db = getDb();
  const now = new Date();
  const def = getSopDefinition(SOP_KEY);

  for (const step of def.steps) {
    const targetStatus =
      step.number <= TICKET_STEP_NUMBER ? 'completed' : 'not_started';
    await db
      .update(sopStepStates)
      .set({
        status: targetStatus,
        started_at: targetStatus === 'completed' ? now : null,
        completed_at: targetStatus === 'completed' ? now : null,
      })
      .where(
        and(eq(sopStepStates.sop_run_id, runId), eq(sopStepStates.step_number, step.number)),
      );
  }

  await db
    .update(sopRuns)
    .set({
      current_step: TICKET_STEP_NUMBER + 1,
      status: 'awaiting_input',
      started_at: now,
    })
    .where(eq(sopRuns.id, runId));
}

/**
 * Did Suppression actually run for this firm? We can't rely on the
 * sop_run alone — the operator might have started one and never
 * completed. The truth source is whether ≥1 legacy_finding row exists
 * for any page of this firm.
 */
async function hasSuppressionData(firmId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: legacyFindings.id })
    .from(legacyFindings)
    .innerJoin(pages, eq(pages.id, legacyFindings.page_id))
    .where(eq(pages.firm_id, firmId))
    .limit(1);
  return !!row;
}

function buildSuppressionGateTicket(firmSlug: string): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  return {
    title: 'Run the Legacy Content Suppression scan first',
    description:
      'Content Repositioning identifies pages with ≥50 clicks/mo that have drifted from Brand Truth — pages worth refreshing rather than suppressing. The scanner reads from the Suppression scan\'s output, so Suppression has to run before Repositioning can find candidates.\n\nNo legacy_finding rows exist for this firm yet.',
    remediationCopy: `**To enable Content Repositioning:**

1. Go to Phase 1 (Brand Audit & Analysis) → run the Suppression scan.
2. Wait for it to complete (typically 2-4 minutes for a 75-page site).
3. Re-run this Phase 3 scan. Pages flagged "Keep + update" (≥50 clicks/mo + drift) become repositioning candidates.

**Why this order matters:**

Suppression uses semantic distance + GSC click data to bucket pages. High-traffic pages that drifted are *not* suppression candidates — they have audience and authority worth preserving. Those are exactly the pages where rewriting in place (Content Repositioning SOP) beats either deletion or no-index.`,
    validationSteps: [
      { description: 'Run Suppression scan from Phase 1' },
      { description: 'Wait for completion' },
      { description: 'Re-run Phase 3 scan to surface repositioning candidates' },
    ],
  };
}

function buildRepositioningTicket(d: {
  url: string;
  title: string | null;
  clicks12m: number;
  semanticDistance: number;
  wordCount: number | null;
  rationale: string;
}): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  const titleText = d.title ?? d.url;
  const title = `Reposition ${titleText} (${d.clicks12m.toFixed(0)} clicks/mo, drift d=${d.semanticDistance.toFixed(2)})`;
  const description =
    `${d.rationale}\n\n` +
    `URL: ${d.url}\n` +
    `Clicks/mo: ${d.clicks12m.toFixed(0)}\n` +
    `Semantic distance from Brand Truth: ${d.semanticDistance.toFixed(3)}\n` +
    `Word count: ${d.wordCount ?? 'unknown'}\n\n` +
    `This page has real traffic and real authority — repositioning in place beats suppression.`;

  const remediationCopy = `**Page:** ${d.url}

**Why it qualifies:** ≥50 clicks/mo + semantic distance ${d.semanticDistance.toFixed(2)} from Brand Truth. Real audience, drifted positioning. Refresh in place.

**Rewrite checklist (Steve Toth Content Repositioning SOP):**

1. **Audit against Brand Truth** — open Brand Truth → \`primary_url\`, \`required_positioning_phrases\`, \`unique_differentiators\`, \`banned_claims\`. Note where the page contradicts.

2. **Rewrite intro + H1 + meta** — make the first 100 words a direct answer to the page's primary query. Use Brand Truth vocabulary. The meta description gets the same treatment.

3. **Restructure body for AEO** — break into scannable sections under H2/H3 question-shaped headings. Add a definition list (<dl>) for any key terms. Add specific facts (years, percentages, named entities) that LLMs can quote.

4. **Update schema markup** — at minimum Organization + WebPage. For FAQ-shaped content add FAQPage. For article-shaped content add Article with author + datePublished + dateModified.

5. **Update internal links** — make sure links *to* this page use the new positioning vocabulary in their anchor text.

6. **Publish and verify** — confirm the page renders, validate at https://search.google.com/test/rich-results, request re-indexing in GSC.

7. **Run the LLM-Friendly Content Checklist scan** afterwards to confirm the page now scores ≥ 5/7.`;

  const validationSteps = [
    { description: 'Diff current page copy against Brand Truth' },
    { description: 'Rewrite intro + H1 + meta to match Brand Truth' },
    { description: 'Restructure body with scannable headings + definitions' },
    { description: 'Update schema markup' },
    { description: 'Publish and verify in browser + GSC URL Inspection' },
    { description: 'Re-run LLM-Friendly Content Checklist scan; confirm score ≥ 5/7' },
  ];

  return { title, description, remediationCopy, validationSteps };
}

export async function runRepositioningScan(firmId: string): Promise<RepositioningScanResult> {
  const firm = await resolveFirm({ id: firmId });

  // Gate on Suppression having run.
  if (!(await hasSuppressionData(firm.id))) {
    const runId = await findOrCreateScannerRun(firm.id);
    await clearPriorOpenTickets(firm.id, runId);
    const gate = buildSuppressionGateTicket(firm.slug);
    // The "run Suppression first" ticket is a workflow prerequisite —
    // closest fit is content_drift (it blocks downstream content work)
    // but it has no signal-driven offset, so score at the class floor.
    const gatePriority = computePriority({
      sourceType: 'sop',
      sopKey: SOP_KEY,
      // No legacyAction available because there's no suppression data
      // yet — the function falls through to unknown class. Override to
      // content_drift via direct class injection isn't supported; let
      // it land in unknown so the operator at least sees it above
      // config_gate.
    });
    await createTicketFromStep({
      firmSlug: firm.slug,
      sopKey: SOP_KEY,
      runId,
      stepNumber: TICKET_STEP_NUMBER,
      title: gate.title,
      description: gate.description,
      priorityRank: 1,
      priorityClass: gatePriority.priorityClass,
      priorityScore: gatePriority.priorityScore,
      remediationCopy: gate.remediationCopy,
      validationSteps: gate.validationSteps,
      evidenceLinks: [],
      automationTier: 'assist',
      executeUrl: `/dashboard/${firm.slug}/suppression`,
      executeLabel: 'Open Suppression scan',
    });
    await markScannerStepsComplete(runId);
    return {
      runId,
      candidatesFound: 0,
      ticketsCreated: 1,
      totalKeepClicks: 0,
      blockedOnSuppression: true,
    };
  }

  // Pull the latest decision matrix from the Suppression deliverable
  // builder. This recomputes from current data — no need to read a
  // cached deliverable.
  const artifacts = await buildSuppressionArtifacts({
    firmId: firm.id,
    firmName: firm.name,
    primaryUrl: firm.primaryUrl,
    generatedAt: new Date(),
  });

  const keepRows = artifacts.decisions
    .filter((d) => d.action === 'keep')
    .sort((a, b) => b.clicks12m - a.clicks12m);

  const runId = await findOrCreateScannerRun(firm.id);
  await clearPriorOpenTickets(firm.id, runId);

  let priorityRank = 1;
  let ticketsCreated = 0;
  let totalClicks = 0;
  for (const d of keepRows) {
    totalClicks += d.clicks12m;
    const payload = buildRepositioningTicket({
      url: d.url,
      title: d.title,
      clicks12m: d.clicks12m,
      semanticDistance: d.semanticDistance,
      wordCount: d.wordCount,
      rationale: d.rationale,
    });
    // Repositioning candidates are high-traffic drifted pages →
    // content_drift class. The legacyAction signal ('keep_update' is
    // C1's name; on main this scanner calls it 'keep' but that's not
    // a recognized action so we encode it as keep_update for the
    // priority math).
    const { priorityClass, priorityScore } = computePriority({
      sourceType: 'legacy',
      legacyAction: 'keep_update',
      semanticDistance: d.semanticDistance,
      clicksPerMonth: d.clicks12m,
    });
    await createTicketFromStep({
      firmSlug: firm.slug,
      sopKey: SOP_KEY,
      runId,
      stepNumber: TICKET_STEP_NUMBER,
      title: payload.title,
      description: payload.description,
      priorityRank: priorityRank++,
      priorityClass,
      priorityScore,
      remediationCopy: payload.remediationCopy,
      validationSteps: payload.validationSteps,
      evidenceLinks: [
        {
          kind: 'page_url',
          url: d.url,
          description: `${d.clicks12m.toFixed(0)} clicks/mo · drift d=${d.semanticDistance.toFixed(2)}`,
        },
      ],
      automationTier: 'assist',
      executeUrl: d.url,
      executeLabel: 'Open page',
    });
    ticketsCreated += 1;
  }

  await markScannerStepsComplete(runId);

  return {
    runId,
    candidatesFound: keepRows.length,
    ticketsCreated,
    totalKeepClicks: Math.round(totalClicks),
    blockedOnSuppression: false,
  };
}

export async function runRepositioningScanBySlug(
  firmSlug: string,
): Promise<RepositioningScanResult> {
  const firm = await resolveFirm({ slug: firmSlug });
  return runRepositioningScan(firm.id);
}
