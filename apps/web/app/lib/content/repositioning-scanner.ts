/**
 * Content Repositioning scanner — Phase 3 SOP `content_repositioning`.
 *
 * ── After C1 (Suppression Decision Framework Rewrite) ──
 *
 * The Suppression scanner now writes Toth STEP3 buckets directly into
 * two sop_runs — `legacy_content_suppression` for delete/redirect/
 * noindex, and `content_repositioning` for keep_update (≥50 clicks/mo
 * + drift) and rewrite (transitional no-GSC bucket). That means the
 * Repositioning sop_run's task list is ALREADY populated as a side
 * effect of running Suppression.
 *
 * This scanner's job after C1 is the synthesis pass on top of those
 * tickets:
 *   - Confirm Suppression has actually run (legacy_findings exist).
 *   - Enrich the Suppression-emitted tickets with step_number=2
 *     (Identify Required Changes — the synthesis step) so they appear
 *     under Step 2 of the Repositioning workflow instead of "no step".
 *   - Upgrade the remediation_copy to the full SOP-aligned rewrite
 *     checklist (intro+H1+meta → restructure → schema → publish →
 *     verify with LLM-Friendly scan).
 *   - Mark scanner steps complete up through step 2.
 *
 * The pre-C1 path called `buildSuppressionArtifacts()` and re-emitted
 * the keep rows as fresh tickets attached to the Repositioning run —
 * which duplicated work that Suppression now does directly. That code
 * is retired here. `buildSuppressionArtifacts` itself remains for the
 * xlsx-export deliverable path only.
 *
 * Gating: if Suppression has never run for the firm, the scanner emits
 * a single config-gate ticket pointing at the Suppression scan.
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
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { createTicketFromStep } from '../../actions/sop-actions';
import { getSopDefinition } from '../sop/registry';

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

function buildSuppressionGateTicket(): {
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

/**
 * SOP-aligned rewrite checklist that replaces the Suppression scanner's
 * default `keep_update` copy. Suppression's prescription is short
 * (deliberately — it's emitted from a Phase 1 scanner whose
 * descriptions cover all four buckets); Repositioning is the Phase 3
 * synthesis step where the full Toth Content Repositioning checklist
 * lives.
 */
function buildRepositioningRemediationCopy(args: {
  url: string;
  clicksPerMonth: number | null;
  semanticDistance: number;
}): string {
  const clicksLine =
    args.clicksPerMonth != null
      ? `**Why it qualifies:** ${args.clicksPerMonth} clicks/mo (≥50 Toth STEP3 keep-update threshold) + semantic distance ${args.semanticDistance.toFixed(2)} from Brand Truth. Real audience, drifted positioning. Refresh in place.`
      : `**Why it qualifies:** Provisional bucket — drift d=${args.semanticDistance.toFixed(2)} flagged for rewrite while GSC is not connected. Once Search Console is wired up the scanner will re-bucket on clicks.`;

  return `**Page:** ${args.url}

${clicksLine}

**Rewrite checklist (Steve Toth Content Repositioning SOP):**

1. **Audit against Brand Truth** — open Brand Truth → \`primary_url\`, \`required_positioning_phrases\`, \`unique_differentiators\`, \`banned_claims\`. Note where the page contradicts.

2. **Rewrite intro + H1 + meta** — make the first 100 words a direct answer to the page's primary query. Use Brand Truth vocabulary. The meta description gets the same treatment.

3. **Restructure body for AEO** — break into scannable sections under H2/H3 question-shaped headings. Add a definition list (<dl>) for any key terms. Add specific facts (years, percentages, named entities) that LLMs can quote.

4. **Update schema markup** — at minimum Organization + WebPage. For FAQ-shaped content add FAQPage. For article-shaped content add Article with author + datePublished + dateModified.

5. **Update internal links** — make sure links *to* this page use the new positioning vocabulary in their anchor text.

6. **Publish and verify** — confirm the page renders, validate at https://search.google.com/test/rich-results, request re-indexing in GSC.

7. **Run the LLM-Friendly Content Checklist scan** afterwards to confirm the page now scores ≥ 5/7.`;
}

const REPOSITIONING_VALIDATION_STEPS: Array<{ description: string }> = [
  { description: 'Diff current page copy against Brand Truth' },
  { description: 'Rewrite intro + H1 + meta to match Brand Truth' },
  { description: 'Restructure body with scannable headings + definitions' },
  { description: 'Update schema markup' },
  { description: 'Publish and verify in browser + GSC URL Inspection' },
  { description: 'Re-run LLM-Friendly Content Checklist scan; confirm score ≥ 5/7' },
];

/**
 * Find the Suppression-emitted tickets that already live on this firm's
 * content_repositioning sop_run. Those are the tickets the upstream
 * Suppression scanner inserted in C1's dual-routing path — they carry
 * source_type='legacy' + source_id=legacy_finding.id, but they're
 * attached to the Repositioning sop_run, not Suppression's.
 */
async function findSuppressionEmittedKeepTickets(repositioningRunId: string): Promise<Array<{
  ticketId: string;
  findingId: string;
  pageUrl: string;
  pageTitle: string | null;
  wordCount: number | null;
  semanticDistance: number;
  decidedWithGsc: boolean;
  /** Reconstructed from the GSC URL metrics table; null when no GSC. */
  clicksPerMonth: number | null;
  priorityHint: number;
}>> {
  const db = getDb();
  // Join ticket → legacy_finding → page so we have the full row needed
  // to rebuild the SOP-aligned remediation copy.
  const rows = await db
    .select({
      ticketId: remediationTickets.id,
      findingId: legacyFindings.id,
      pageUrl: pages.url,
      pageTitle: pages.title,
      wordCount: pages.word_count,
      semanticDistance: legacyFindings.semantic_distance,
      action: legacyFindings.action,
      decidedWithGsc: legacyFindings.decided_with_gsc,
      // We don't store clicks in legacy_finding directly; the prescription
      // helper used to receive them from the scanner. The Suppression
      // ticket's description preserves them in a `GSC clicks (last 30
      // days): N` line which we could parse — but easier and more
      // robust: pull them from gsc_url_metric directly when needed.
      clicks: sql<number | null>`(
        SELECT m.clicks
        FROM gsc_url_metric m
        WHERE m.firm_id = ${remediationTickets.firm_id}
          AND m.url = ${pages.url}
        ORDER BY m.window_end_date DESC
        LIMIT 1
      )`.as('clicks'),
    })
    .from(remediationTickets)
    .innerJoin(legacyFindings, eq(legacyFindings.id, remediationTickets.source_id))
    .innerJoin(pages, eq(pages.id, legacyFindings.page_id))
    .where(
      and(
        eq(remediationTickets.sop_run_id, repositioningRunId),
        eq(remediationTickets.source_type, 'legacy'),
        inArray(remediationTickets.status, ['open', 'in_progress']),
        inArray(legacyFindings.action, ['keep_update', 'rewrite']),
      ),
    );

  // keep_update (real Toth bucket, ≥50 clicks) outranks rewrite
  // (transitional fallback) — sort that way before assigning priority.
  // Within keep_update, sort by clicks DESC.
  const sorted = rows
    .map((r, i) => ({
      ticketId: r.ticketId,
      findingId: r.findingId,
      pageUrl: r.pageUrl,
      pageTitle: r.pageTitle,
      wordCount: r.wordCount,
      semanticDistance: Number(r.semanticDistance),
      decidedWithGsc: r.decidedWithGsc,
      clicksPerMonth: r.clicks != null ? Number(r.clicks) : null,
      action: r.action,
      priorityHint: i,
    }))
    .sort((a, b) => {
      // keep_update before rewrite
      if (a.action !== b.action) return a.action === 'keep_update' ? -1 : 1;
      // Within keep_update, clicks DESC
      return (b.clicksPerMonth ?? 0) - (a.clicksPerMonth ?? 0);
    });

  return sorted.map((r, i) => ({
    ticketId: r.ticketId,
    findingId: r.findingId,
    pageUrl: r.pageUrl,
    pageTitle: r.pageTitle,
    wordCount: r.wordCount,
    semanticDistance: r.semanticDistance,
    decidedWithGsc: r.decidedWithGsc,
    clicksPerMonth: r.clicksPerMonth,
    priorityHint: i + 1,
  }));
}

export async function runRepositioningScan(firmId: string): Promise<RepositioningScanResult> {
  const firm = await resolveFirm({ id: firmId });
  const db = getDb();

  // Gate on Suppression having run.
  if (!(await hasSuppressionData(firm.id))) {
    const runId = await findOrCreateScannerRun(firm.id);
    // Wipe prior gate tickets so we don't double-up.
    await db
      .delete(remediationTickets)
      .where(
        and(
          eq(remediationTickets.firm_id, firm.id),
          eq(remediationTickets.sop_run_id, runId),
          eq(remediationTickets.sop_step_number, TICKET_STEP_NUMBER),
          inArray(remediationTickets.status, ['open', 'in_progress']),
        ),
      );
    const gate = buildSuppressionGateTicket();
    await createTicketFromStep({
      firmSlug: firm.slug,
      sopKey: SOP_KEY,
      runId,
      stepNumber: TICKET_STEP_NUMBER,
      title: gate.title,
      description: gate.description,
      priorityRank: 1,
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

  // Suppression has run. Find the keep_update / rewrite tickets it
  // already emitted onto our sop_run and enrich them.
  const runId = await findOrCreateScannerRun(firm.id);
  const candidates = await findSuppressionEmittedKeepTickets(runId);

  let totalClicks = 0;
  for (const c of candidates) {
    if (c.clicksPerMonth != null) totalClicks += c.clicksPerMonth;

    const titleText = c.pageTitle?.trim() || c.pageUrl;
    const clicksFragment =
      c.clicksPerMonth != null ? `${c.clicksPerMonth} clicks/mo, ` : '';
    const newTitle = `Reposition ${titleText.slice(0, 70)} (${clicksFragment}drift d=${c.semanticDistance.toFixed(2)})`;
    const newRemediation = buildRepositioningRemediationCopy({
      url: c.pageUrl,
      clicksPerMonth: c.clicksPerMonth,
      semanticDistance: c.semanticDistance,
    });

    await db
      .update(remediationTickets)
      .set({
        sop_step_number: TICKET_STEP_NUMBER,
        title: newTitle,
        remediation_copy: newRemediation,
        validation_steps: REPOSITIONING_VALIDATION_STEPS,
        priority_rank: c.priorityHint,
        playbook_step: 'repositioning:rewrite',
      })
      .where(eq(remediationTickets.id, c.ticketId));
  }

  await markScannerStepsComplete(runId);

  return {
    runId,
    candidatesFound: candidates.length,
    ticketsCreated: candidates.length,
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
