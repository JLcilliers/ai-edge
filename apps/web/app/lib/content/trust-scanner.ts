/**
 * Trust Alignment Audit scanner — Phase 6 SOP `trust_alignment_audit`.
 *
 * First scanner in Phase 6 (Content Generation), turning that phase
 * page from "Scanner wiring in progress" into a live scan.
 *
 * Pure read-only over `pages.main_content` (no re-crawl needed). Per
 * run:
 *   1. Load every page row for the firm.
 *   2. Extract factual claims (years, quantities, awards) +
 *      banned-claim hits per page.
 *   3. Run the corpus-level detection rules (year inconsistencies,
 *      quantity inconsistencies, banned-claim violations, unverified
 *      awards).
 *   4. Emit one ticket per finding — multi-page findings (e.g. a year
 *      inconsistency spanning 4 pages) become a single ticket so the
 *      operator triages it as one decision, not four.
 *
 * Lifecycle matches the other scanner-managed SOPs.
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
import { createTicketFromStep } from '../../actions/sop-actions';
import { getSopDefinition } from '../sop/registry';
import {
  detectFindings,
  extractClaims,
  checkBannedClaims,
  type TrustFinding,
} from './trust-rubric';

const SOP_KEY = 'trust_alignment_audit' as const;
// Tickets attach to step 3 (Flag Misalignments) — the synthesis step.
const TICKET_STEP_NUMBER = 3;

const SEVERITY_RANK: Record<TrustFinding['severity'], number> = {
  high: 1,
  medium: 2,
  low: 3,
};

export interface TrustScanResult {
  runId: string;
  pagesScanned: number;
  findingsByKind: Record<TrustFinding['kind'], number>;
  ticketsCreated: number;
}

interface FirmRow {
  id: string;
  slug: string;
  name: string;
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
    return f;
  }
  if (arg.slug) {
    const [f] = await db
      .select({ id: firms.id, slug: firms.slug, name: firms.name })
      .from(firms)
      .where(eq(firms.slug, arg.slug))
      .limit(1);
    if (!f) throw new Error(`Firm not found: ${arg.slug}`);
    return f;
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
      created_by: 'scanner:trust-alignment',
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
    const targetStatus = step.number <= TICKET_STEP_NUMBER ? 'completed' : 'not_started';
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

function buildTicketPayload(finding: TrustFinding): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  const sev = finding.severity[0]!.toUpperCase() + finding.severity.slice(1);
  const title = `[${sev}] Trust: ${finding.label}`;

  const description = `${finding.detail}\n\nAffected pages (${finding.pageUrls.length}):\n${finding.pageUrls.map((u) => `- ${u}`).join('\n')}`;

  const remediationCopyByKind: Record<TrustFinding['kind'], string> = {
    year_inconsistency: `**Resolve the inconsistency:**

1. Confirm the correct founding/operation year (check incorporation paperwork, original press release, GBP business since-date).
2. Update Brand Truth with the canonical year.
3. Edit every flagged page to use the same year (search for "since YYYY", "founded YYYY", "established YYYY" patterns).
4. Re-run the Trust Alignment scan to confirm the inconsistency is cleared.`,
    quantity_inconsistency: `**Resolve the inconsistency:**

1. Pick the most current accurate count (consult internal records — case files, client list, etc.).
2. Update Brand Truth with the canonical figure.
3. Edit every flagged page to use the same figure.
4. Where possible, use a deliberately ranged claim ("500+") instead of an exact figure so the number stays accurate for longer.`,
    banned_claim: `**Remove or rephrase the banned phrase:**

1. Check Brand Truth → \`banned_claims\` for the policy reason (bar association rule, state dental board rule, FTC requirement).
2. Edit the page to remove or rephrase. For law firms specifically, replace superlatives ("best", "top", "leading") with documentable specifics ("over 30 years of trial experience", "recognized by Super Lawyers in 2023").
3. Re-scan to confirm no further hits.`,
    unverified_award: `**Verify or remove the award claim:**

1. Confirm the award is real (year, awarding body, source URL).
2. If verified: add it to Brand Truth → \`awards\` with the source URL + year.
3. If unverifiable: remove the claim from the page.
4. Awards that LLMs can cross-check (Super Lawyers, Best Lawyers, ADA, etc.) carry the most citation weight — prioritize verifiable awards over generic recognition phrases.`,
  };

  const remediationCopy = `**Affected pages (${finding.pageUrls.length}):**\n\n${finding.pageUrls.map((u) => `- ${u}`).join('\n')}\n\n${remediationCopyByKind[finding.kind]}`;

  const validationSteps: Array<{ description: string }> = [
    { description: 'Apply the correction to every affected page' },
    { description: 'Update Brand Truth where appropriate' },
    { description: 'Re-run the Trust Alignment scan and confirm the finding clears' },
  ];

  return { title, description, remediationCopy, validationSteps };
}

export async function runTrustAlignmentScan(firmId: string): Promise<TrustScanResult> {
  const db = getDb();
  const firm = await resolveFirm({ id: firmId });

  // Load latest Brand Truth (needed for banned_claims + verified awards).
  const [btv] = await db
    .select()
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firm.id))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  const brandTruth = (btv?.payload as BrandTruth | undefined) ?? null;

  const rows = await db
    .select({
      url: pages.url,
      mainContent: pages.main_content,
    })
    .from(pages)
    .where(eq(pages.firm_id, firm.id));

  if (rows.length === 0) {
    throw new Error('No crawled pages found — run the Suppression scan first to populate the page corpus.');
  }

  // Per-page claim extraction + banned-claim hits.
  const perPage = rows
    .filter((r) => !!r.mainContent && r.mainContent.length > 0)
    .map((r) => {
      const claims = extractClaims(r.url, r.mainContent!);
      claims.bannedHits = checkBannedClaims(r.mainContent!, brandTruth);
      return claims;
    });

  if (perPage.length === 0) {
    throw new Error('No pages with extracted main_content — re-run the Suppression scan to populate page bodies.');
  }

  // Corpus-level findings.
  const findings = detectFindings(perPage, brandTruth);

  const runId = await findOrCreateScannerRun(firm.id);
  await clearPriorOpenTickets(firm.id, runId);

  // Sort findings: severity first, then page-count desc (broader
  // findings outrank single-page ones at the same severity).
  const sorted = [...findings].sort((a, b) => {
    const sr = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sr !== 0) return sr;
    return b.pageUrls.length - a.pageUrls.length;
  });

  let priorityRank = 1;
  let ticketsCreated = 0;
  for (const finding of sorted) {
    const payload = buildTicketPayload(finding);
    // For multi-page findings we still use the first page's URL as
    // executeUrl so the operator has somewhere to click; the
    // description lists every affected URL.
    const primaryUrl = finding.pageUrls[0] ?? '';
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
      evidenceLinks: finding.pageUrls.slice(0, 10).map((u) => ({
        kind: 'page_url' as const,
        url: u,
        description: finding.kind,
      })),
      automationTier: 'assist',
      executeUrl: primaryUrl || undefined,
      executeLabel: primaryUrl ? 'Open first page' : undefined,
    });
    ticketsCreated += 1;
  }

  await markScannerStepsComplete(runId);

  const findingsByKind: TrustScanResult['findingsByKind'] = {
    year_inconsistency: 0,
    quantity_inconsistency: 0,
    banned_claim: 0,
    unverified_award: 0,
  };
  for (const f of findings) findingsByKind[f.kind] += 1;

  return {
    runId,
    pagesScanned: perPage.length,
    findingsByKind,
    ticketsCreated,
  };
}

export async function runTrustAlignmentScanBySlug(firmSlug: string): Promise<TrustScanResult> {
  const firm = await resolveFirm({ slug: firmSlug });
  return runTrustAlignmentScan(firm.id);
}
