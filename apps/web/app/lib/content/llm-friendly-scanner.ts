/**
 * LLM-Friendly Content Checklist scanner.
 *
 * Phase 3 SOP `llm_friendly_content_checklist` — scoring every crawled
 * page against the 7-criterion rubric (title, length floor/ceiling,
 * positioning alignment, citable facts, required phrases). Emits one
 * assist-tier remediation_ticket per page that fails the bar, with a
 * detailed breakdown of which criteria failed and the exact next steps.
 *
 * Read-only over `pages` — does NOT re-crawl. If a firm has stale
 * extracted content the operator runs the Suppression scan first; this
 * scanner consumes that output. That keeps the two scanners loosely
 * coupled and the LLM-Friendly pass cheap (no HTTP fetches).
 *
 * Per-run shape:
 *   1. Resolve firm + latest Brand Truth payload.
 *   2. Find or create the `llm_friendly_content_checklist` sop_run.
 *   3. Pull every page with main_content + embedding for the firm.
 *   4. Compute the Brand Truth centroid once.
 *   5. Score each page; collect failing pages.
 *   6. Clear prior open tickets from this scanner (re-runs replace
 *      previous output — same mental model as suppression).
 *   7. Emit one ticket per failing page (assist-tier, executeUrl=page,
 *      executeLabel='Edit page' — operator opens it in their CMS and
 *      applies the rubric fixes).
 *   8. Mark steps 1-4 of the SOP run completed; leave step 5 (Final
 *      Approval) in_progress so the operator confirms the rubric run
 *      before publishing.
 *
 * Idempotent. Safe to re-run; the prior-ticket sweep keeps the ticket
 * surface from accumulating duplicates.
 */

import {
  getDb,
  firms,
  pages,
  sopRuns,
  sopStepStates,
  remediationTickets,
  brandTruthVersions,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { brandTruthToText, embedSingle, semanticDistance } from '../suppression/embeddings';
import { createTicketFromStep } from '../../actions/sop-actions';
import { getSopDefinition } from '../sop/registry';
import {
  scorePage,
  extractRequiredPhrases,
  PASS_THRESHOLD,
  MAX_SCORE,
  type PageScore,
} from './rubric';

const SOP_KEY = 'llm_friendly_content_checklist' as const;
// Tickets attach to the synthesis step (Citation Readiness Check) so
// they roll up under a single step number in the execution-task list.
const TICKET_STEP_NUMBER = 4;

export interface LlmFriendlyScanResult {
  runId: string;
  pagesScanned: number;
  pagesFailing: number;
  ticketsCreated: number;
  averageScore: number;
}

interface FirmRow {
  id: string;
  slug: string;
  name: string;
}

async function resolveFirm(firmIdOrSlug: { id?: string; slug?: string }): Promise<FirmRow> {
  const db = getDb();
  if (firmIdOrSlug.id) {
    const [f] = await db
      .select({ id: firms.id, slug: firms.slug, name: firms.name })
      .from(firms)
      .where(eq(firms.id, firmIdOrSlug.id))
      .limit(1);
    if (!f) throw new Error(`Firm not found: ${firmIdOrSlug.id}`);
    return f;
  }
  if (firmIdOrSlug.slug) {
    const [f] = await db
      .select({ id: firms.id, slug: firms.slug, name: firms.name })
      .from(firms)
      .where(eq(firms.slug, firmIdOrSlug.slug))
      .limit(1);
    if (!f) throw new Error(`Firm not found: ${firmIdOrSlug.slug}`);
    return f;
  }
  throw new Error('resolveFirm: id or slug required');
}

/**
 * Find or create the sop_run for `llm_friendly_content_checklist`. If
 * one exists at any non-cancelled status, reuse it; we want re-runs to
 * update the same row so the operator's history stays clean. Step rows
 * are seeded once on first creation and updated on each run.
 */
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
      created_by: 'scanner:llm-friendly',
    })
    .returning({ id: sopRuns.id });
  const runId = inserted!.id;

  // Seed step states — every step starts not_started; the scanner will
  // mark 1-4 completed at the end of its work.
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

/**
 * Clear prior open tickets emitted by this scanner before re-emitting.
 * Re-runs replace the previous report — same mental model as the
 * suppression scanner. Closed/resolved tickets are kept as historical
 * record.
 */
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

/**
 * Mark the scanner steps completed at the end of a successful run. We
 * mark steps 1-4 completed (the rubric dimensions) and leave step 5
 * (Final Approval) in_progress so the operator confirms the run.
 */
async function markScannerStepsComplete(runId: string): Promise<void> {
  const db = getDb();
  const now = new Date();
  const def = getSopDefinition(SOP_KEY);

  for (const step of def.steps) {
    const targetStatus =
      step.number <= TICKET_STEP_NUMBER ? 'completed' : 'in_progress';
    await db
      .update(sopStepStates)
      .set({
        status: targetStatus,
        started_at: now,
        completed_at: targetStatus === 'completed' ? now : null,
      })
      .where(
        and(eq(sopStepStates.sop_run_id, runId), eq(sopStepStates.step_number, step.number)),
      );
  }

  // For scanner-managed SOPs we use started_at as "last scan started"
  // rather than the historical first-start. The phase-page-shell's
  // "Last scan: X min ago" reads from this; without the bump, re-runs
  // would forever show the original creation time.
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
 * Build the ticket title + remediation copy for a failing page.
 */
function buildTicketPayload(score: PageScore): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  const failed = score.criteria.filter((c) => !c.passed);
  const title = `LLM-friendliness: refresh ${score.title?.trim() || score.url} (${score.total}/${MAX_SCORE})`;
  const description =
    `Page scored ${score.total}/${MAX_SCORE} on the LLM-Friendly Content Checklist.\n\n` +
    `URL: ${score.url}\n` +
    `Word count: ${score.wordCount}\n` +
    (score.semanticDistance != null
      ? `Brand Truth distance: ${score.semanticDistance.toFixed(3)}\n`
      : 'Brand Truth distance: not computed (page missing embedding)\n') +
    `\nFailing criteria:\n` +
    failed.map((c) => `- ${c.label}: ${c.detail}`).join('\n');

  const remediationCopy =
    `**Page:** ${score.url}\n\n` +
    `**Score:** ${score.total}/${MAX_SCORE} — needs ${PASS_THRESHOLD - score.total} more pass${PASS_THRESHOLD - score.total === 1 ? '' : 'es'} to clear the bar.\n\n` +
    `**Fix list:**\n` +
    failed
      .map((c, i) => {
        const hint = HOW_TO_FIX[c.key];
        return `${i + 1}. **${c.label}** — ${c.detail}\n   ↳ ${hint}`;
      })
      .join('\n\n');

  const validationSteps: Array<{ description: string }> = failed
    .map((c) => ({ description: `Verify: ${c.label}` }));
  validationSteps.push({ description: 'Re-run LLM-Friendly Content Checklist scan' });
  validationSteps.push({ description: 'Score ≥ 5/7 before marking ticket resolved' });

  return { title, description, remediationCopy, validationSteps };
}

/** Operator-facing fix guidance per criterion. Kept tight — one line each. */
const HOW_TO_FIX: Record<PageScore['criteria'][number]['key'], string> = {
  title_present: 'Add a <title> tag describing the page topic (your CMS\'s "SEO title" or "Meta title" field).',
  title_length: 'Edit the title to 10–70 characters — long enough to describe, short enough to render in AIO previews.',
  body_length_floor: 'Expand the body past 400 words. Add a concrete example, a numbered step list, or a sub-section per audience.',
  body_length_ceiling: 'Split the page or trim filler. Move tangential sections to linked sub-pages; LLMs sample the middle and lose the framing on long pages.',
  positioning_alignment: 'Rewrite the intro + headings to use Brand Truth vocabulary (your differentiators, required positioning phrases, banned claims).',
  citable_facts: 'Add specific anchors: a year, a percentage, a dollar amount, an ordinal milestone, or a date. LLMs preferentially quote sentences with concrete numbers.',
  required_phrases: 'Insert at least one Brand Truth required-positioning phrase into the body verbatim (intro, a sub-header, or the close).',
};

/**
 * Main entry point. Idempotent over (firm × scanner) — re-runs replace
 * the prior open tickets but reuse the same sop_run row.
 */
export async function runLlmFriendlyScan(firmId: string): Promise<LlmFriendlyScanResult> {
  const db = getDb();
  const firm = await resolveFirm({ id: firmId });

  // Load the latest Brand Truth.
  const [btv] = await db
    .select()
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firm.id))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);

  if (!btv) {
    throw new Error('Firm has no Brand Truth — create one before scanning content.');
  }

  const brandTruth = btv.payload as BrandTruth;
  const requiredPhrases = extractRequiredPhrases(brandTruth);

  // Load every page for the firm. We score even pages that don't have
  // embeddings yet — the positioning criterion just fails for those
  // with a clear "run the suppression scan" detail.
  const rows = await db
    .select({
      url: pages.url,
      title: pages.title,
      mainContent: pages.main_content,
      wordCount: pages.word_count,
      embedding: pages.embedding,
    })
    .from(pages)
    .where(eq(pages.firm_id, firm.id));

  if (rows.length === 0) {
    throw new Error('No crawled pages found — run the Suppression scan first to populate the page corpus.');
  }

  // Compute Brand Truth centroid once. Skip when no rows have embeddings
  // (which means we'd never use it).
  const hasEmbeddings = rows.some((r) => Array.isArray(r.embedding) && r.embedding.length > 0);
  let brandVec: number[] | null = null;
  if (hasEmbeddings) {
    const btText = brandTruthToText(brandTruth);
    brandVec = await embedSingle(btText);
  }

  // Score each page.
  const scores: PageScore[] = rows.map((r) => {
    const distance =
      brandVec && Array.isArray(r.embedding) && r.embedding.length > 0
        ? semanticDistance(brandVec, r.embedding as number[])
        : null;
    return scorePage({
      url: r.url,
      title: r.title,
      mainContent: r.mainContent,
      wordCount: r.wordCount,
      semanticDistance: distance,
      requiredPhrases,
    });
  });

  // Find or create the run + clear prior open tickets.
  const runId = await findOrCreateScannerRun(firm.id);
  await clearPriorOpenTickets(firm.id, runId);

  // Emit one ticket per failing page, ranked by score (worst first).
  const failing = scores
    .filter((s) => s.failed)
    .sort((a, b) => a.total - b.total);

  let priorityRank = 1;
  let ticketsCreated = 0;
  for (const score of failing) {
    const payload = buildTicketPayload(score);
    await createTicketFromStep({
      firmSlug: firm.slug,
      sopKey: SOP_KEY,
      runId,
      stepNumber: TICKET_STEP_NUMBER,
      title: payload.title,
      description: payload.description,
      priorityRank: priorityRank++,
      remediationCopy: payload.remediationCopy,
      validationSteps: payload.validationSteps,
      evidenceLinks: [
        { kind: 'page_url', url: score.url, description: `Scored ${score.total}/${MAX_SCORE}` },
      ],
      // Assist tier: we drafted the fix list, the operator applies it in
      // the CMS. Flip to 'auto' once we wire per-firm CMS credentials so
      // the [Apply] button can patch the content directly.
      automationTier: 'assist',
      executeUrl: score.url,
      executeLabel: 'Open page',
    });
    ticketsCreated += 1;
  }

  await markScannerStepsComplete(runId);

  const total = scores.reduce((acc, s) => acc + s.total, 0);
  return {
    runId,
    pagesScanned: scores.length,
    pagesFailing: failing.length,
    ticketsCreated,
    averageScore: scores.length ? +(total / scores.length).toFixed(2) : 0,
  };
}

/** Convenience wrapper for callers that have a slug instead of an id. */
export async function runLlmFriendlyScanBySlug(firmSlug: string): Promise<LlmFriendlyScanResult> {
  const firm = await resolveFirm({ slug: firmSlug });
  return runLlmFriendlyScan(firm.id);
}
