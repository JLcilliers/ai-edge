'use server';

import {
  getDb,
  pages,
  firms,
  legacyFindings,
  legacyRewriteDrafts,
  brandTruthVersions,
} from '@ai-edge/db';
import { eq, desc } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { generateRewriteDraftForFinding } from '../lib/suppression/rewrite';

/**
 * Server actions for the AI-assisted rewrite workflow (PLAN §5.3).
 *
 * The detail page at /dashboard/[slug]/suppression/[findingId] calls:
 *   - getSuppressionFindingDetail  → initial page data
 *   - generateRewriteDraft         → kick off (or regenerate) a draft
 *   - acceptRewriteDraft           → mark status='accepted'
 *   - rejectRewriteDraft           → mark status='rejected' (so the operator
 *                                    can regenerate without accidentally
 *                                    acting on a stale draft)
 *
 * All mutations revalidate the detail page and the suppression list page so
 * the status/badge state updates across tabs without a full reload.
 */

export type RewriteDraftStatus = 'draft' | 'accepted' | 'rejected';

export interface SuppressionFindingDetail {
  firmSlug: string;
  firmName: string;
  finding: {
    id: string;
    semanticDistance: number;
    action: string;
    rationale: string | null;
    detectedAt: Date;
  };
  page: {
    id: string;
    url: string;
    title: string | null;
    wordCount: number | null;
    mainContent: string | null;
    fetchedAt: Date | null;
  };
  draft: {
    id: string;
    brandTruthVersionId: string | null;
    currentTitle: string | null;
    currentExcerpt: string | null;
    proposedTitle: string;
    proposedBody: string;
    changeSummary: string | null;
    entitiesPreserved: string[];
    positioningFixes: string[];
    bannedClaimsAvoided: string[];
    generatedByModel: string;
    costUsd: number | null;
    status: RewriteDraftStatus;
    generatedAt: Date;
    reviewedAt: Date | null;
    // Latest Brand Truth version at read time — lets the UI flag "draft was
    // generated against v3, you're now on v5".
    currentBrandTruthVersionId: string | null;
  } | null;
}

/** Ensure the finding belongs to the firm identified by `firmSlug`. */
async function assertFindingBelongsToFirm(
  findingId: string,
  firmSlug: string,
): Promise<{ firmId: string; firmName: string }> {
  const db = getDb();
  const [row] = await db
    .select({
      firmId: pages.firm_id,
      firmName: firms.name,
      slug: firms.slug,
    })
    .from(legacyFindings)
    .innerJoin(pages, eq(pages.id, legacyFindings.page_id))
    .innerJoin(firms, eq(firms.id, pages.firm_id))
    .where(eq(legacyFindings.id, findingId))
    .limit(1);
  if (!row) throw new Error(`Legacy finding not found: ${findingId}`);
  if (row.slug !== firmSlug) {
    // Same error text as not-found so callers can't probe for other tenants'
    // finding ids.
    throw new Error(`Legacy finding not found: ${findingId}`);
  }
  return { firmId: row.firmId, firmName: row.firmName };
}

/** Full detail payload for the finding-detail page. */
export async function getSuppressionFindingDetail(
  firmSlug: string,
  findingId: string,
): Promise<SuppressionFindingDetail | null> {
  const db = getDb();

  // Fetch the finding + page + firm in one join. We don't left-join the
  // draft into the main query because drafts carry a long `proposed_body`
  // and a left-join across attempts is wasteful on a detail page that
  // renders a single draft.
  const [metaRow] = await db
    .select({
      findingId: legacyFindings.id,
      findingDistance: legacyFindings.semantic_distance,
      findingAction: legacyFindings.action,
      findingRationale: legacyFindings.rationale,
      findingDetectedAt: legacyFindings.detected_at,
      pageId: pages.id,
      pageFirmId: pages.firm_id,
      pageUrl: pages.url,
      pageTitle: pages.title,
      pageWordCount: pages.word_count,
      pageMainContent: pages.main_content,
      pageFetchedAt: pages.fetched_at,
      firmId: firms.id,
      firmName: firms.name,
      firmSlug: firms.slug,
    })
    .from(legacyFindings)
    .innerJoin(pages, eq(pages.id, legacyFindings.page_id))
    .innerJoin(firms, eq(firms.id, pages.firm_id))
    .where(eq(legacyFindings.id, findingId))
    .limit(1);
  if (!metaRow) return null;
  if (metaRow.firmSlug !== firmSlug) return null; // cross-firm probe guard

  // Latest Brand Truth version for this firm — used by the UI to flag
  // "this draft was aligned to v3, you're now on v5" when they differ.
  const [latestBtvAct] = await db
    .select({ id: brandTruthVersions.id })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, metaRow.firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);

  const [draftRow] = await db
    .select({
      id: legacyRewriteDrafts.id,
      brandTruthVersionId: legacyRewriteDrafts.brand_truth_version_id,
      currentTitle: legacyRewriteDrafts.current_title,
      currentExcerpt: legacyRewriteDrafts.current_excerpt,
      proposedTitle: legacyRewriteDrafts.proposed_title,
      proposedBody: legacyRewriteDrafts.proposed_body,
      changeSummary: legacyRewriteDrafts.change_summary,
      entitiesPreserved: legacyRewriteDrafts.entities_preserved,
      positioningFixes: legacyRewriteDrafts.positioning_fixes,
      bannedClaimsAvoided: legacyRewriteDrafts.banned_claims_avoided,
      generatedByModel: legacyRewriteDrafts.generated_by_model,
      costUsd: legacyRewriteDrafts.cost_usd,
      status: legacyRewriteDrafts.status,
      generatedAt: legacyRewriteDrafts.generated_at,
      reviewedAt: legacyRewriteDrafts.reviewed_at,
    })
    .from(legacyRewriteDrafts)
    .where(eq(legacyRewriteDrafts.legacy_finding_id, findingId))
    .limit(1);

  return {
    firmSlug,
    firmName: metaRow.firmName,
    finding: {
      id: metaRow.findingId,
      semanticDistance: metaRow.findingDistance,
      action: metaRow.findingAction,
      rationale: metaRow.findingRationale,
      detectedAt: metaRow.findingDetectedAt,
    },
    page: {
      id: metaRow.pageId,
      url: metaRow.pageUrl,
      title: metaRow.pageTitle,
      wordCount: metaRow.pageWordCount,
      mainContent: metaRow.pageMainContent,
      fetchedAt: metaRow.pageFetchedAt,
    },
    draft: draftRow
      ? {
          id: draftRow.id,
          brandTruthVersionId: draftRow.brandTruthVersionId,
          currentTitle: draftRow.currentTitle,
          currentExcerpt: draftRow.currentExcerpt,
          proposedTitle: draftRow.proposedTitle,
          proposedBody: draftRow.proposedBody,
          changeSummary: draftRow.changeSummary,
          entitiesPreserved: draftRow.entitiesPreserved,
          positioningFixes: draftRow.positioningFixes,
          bannedClaimsAvoided: draftRow.bannedClaimsAvoided,
          generatedByModel: draftRow.generatedByModel,
          costUsd: draftRow.costUsd,
          status: draftRow.status as RewriteDraftStatus,
          generatedAt: draftRow.generatedAt,
          reviewedAt: draftRow.reviewedAt,
          currentBrandTruthVersionId: latestBtvAct?.id ?? null,
        }
      : null,
  };
}

/**
 * Generate (or regenerate) a rewrite draft for this finding. Returns the
 * freshly-upserted draft id + the ui-facing cost for audit logging.
 */
export async function generateRewriteDraft(
  firmSlug: string,
  findingId: string,
): Promise<{ draftId: string; costUsd: number } | { error: string }> {
  try {
    await assertFindingBelongsToFirm(findingId, firmSlug);
    const draft = await generateRewriteDraftForFinding(findingId);
    revalidatePath(`/dashboard/${firmSlug}/suppression`);
    revalidatePath(`/dashboard/${firmSlug}/suppression/${findingId}`);
    return { draftId: draft.draftId, costUsd: draft.costUsd };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function setDraftStatus(
  firmSlug: string,
  findingId: string,
  status: RewriteDraftStatus,
): Promise<{ ok: true } | { error: string }> {
  try {
    await assertFindingBelongsToFirm(findingId, firmSlug);
    const db = getDb();
    const updated = await db
      .update(legacyRewriteDrafts)
      .set({ status, reviewed_at: new Date() })
      .where(eq(legacyRewriteDrafts.legacy_finding_id, findingId))
      .returning({ id: legacyRewriteDrafts.id });
    if (updated.length === 0) {
      return { error: 'No draft exists for this finding — generate one first.' };
    }
    revalidatePath(`/dashboard/${firmSlug}/suppression`);
    revalidatePath(`/dashboard/${firmSlug}/suppression/${findingId}`);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function acceptRewriteDraft(firmSlug: string, findingId: string) {
  return setDraftStatus(firmSlug, findingId, 'accepted');
}

export async function rejectRewriteDraft(firmSlug: string, findingId: string) {
  return setDraftStatus(firmSlug, findingId, 'rejected');
}
