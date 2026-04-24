'use server';

import {
  getDb,
  firms,
  auditRuns,
  pages,
  legacyFindings,
  remediationTickets,
} from '@ai-edge/db';
import { eq, desc, and } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { runSuppressionScan } from '../lib/suppression/scan';

/** Resolve firm id from URL slug. Throws if the slug doesn't match a firm. */
async function resolveFirmId(slug: string): Promise<string> {
  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id })
    .from(firms)
    .where(eq(firms.slug, slug))
    .limit(1);
  if (!firm) throw new Error(`Firm not found: ${slug}`);
  return firm.id;
}

/**
 * Kick off a suppression scan. This crawls the firm's sitemap, extracts
 * + embeds each page, and writes `legacy_finding` + `remediation_ticket`
 * rows for anything that drifts from the Brand Truth.
 *
 * The scan is an async-in-request pattern (not a background job yet) — the
 * action returns as soon as the `auditRuns` row is created, and the UI
 * polls `getSuppressionScanStatus` for completion. That's fine within the
 * Fluid Compute 300s ceiling for the ~75-page target-case; anything bigger
 * and we'd move this to a Queue.
 */
export async function startSuppressionScan(
  firmSlug: string,
): Promise<{ runId: string } | { error: string }> {
  try {
    const firmId = await resolveFirmId(firmSlug);
    const runId = await runSuppressionScan(firmId);
    revalidatePath(`/dashboard/${firmSlug}/suppression`);
    return { runId };
  } catch (err) {
    return { error: String(err) };
  }
}

/** Poll status for a specific scan run. Audit-run ids are globally unique. */
export async function getSuppressionScanStatus(runId: string): Promise<{
  status: string;
  error: string | null;
}> {
  const db = getDb();
  const [run] = await db
    .select({ status: auditRuns.status, error: auditRuns.error })
    .from(auditRuns)
    .where(eq(auditRuns.id, runId))
    .limit(1);
  return run ?? { status: 'unknown', error: null };
}

/** Most recent suppression audit_run — drives the "last scanned" header copy. */
export async function getLatestSuppressionRun(firmSlug: string): Promise<{
  id: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
} | null> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  const [run] = await db
    .select({
      id: auditRuns.id,
      status: auditRuns.status,
      startedAt: auditRuns.started_at,
      finishedAt: auditRuns.finished_at,
      error: auditRuns.error,
    })
    .from(auditRuns)
    .where(and(eq(auditRuns.firm_id, firmId), eq(auditRuns.kind, 'suppression')))
    .orderBy(desc(auditRuns.started_at))
    .limit(1);

  return run ?? null;
}

export type SuppressionFindingRow = {
  findingId: string;
  pageId: string;
  url: string;
  title: string | null;
  wordCount: number | null;
  semanticDistance: number;
  action: string; // 'rewrite' | 'noindex' | 'redirect'
  rationale: string | null;
  detectedAt: Date;
  ticketStatus: string | null;
  ticketDueAt: Date | null;
};

/**
 * All active (distance > rewrite threshold) findings for the firm, joined
 * with the underlying page + the downstream remediation ticket so the UI
 * can render "page → action → due date → status" in one row without
 * waterfalling.
 *
 * Ordered by semantic_distance descending — furthest-from-brand first,
 * which is the order an operator naturally wants to triage.
 */
export async function getSuppressionFindings(
  firmSlug: string,
): Promise<SuppressionFindingRow[]> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  // Join legacy_findings → pages (firm scope) → remediation_tickets (optional).
  // source_type = 'legacy' guards against accidentally matching a differently-
  // sourced ticket that happens to share a UUID with a finding id.
  const rows = await db
    .select({
      findingId: legacyFindings.id,
      pageId: pages.id,
      url: pages.url,
      title: pages.title,
      wordCount: pages.word_count,
      semanticDistance: legacyFindings.semantic_distance,
      action: legacyFindings.action,
      rationale: legacyFindings.rationale,
      detectedAt: legacyFindings.detected_at,
      ticketStatus: remediationTickets.status,
      ticketDueAt: remediationTickets.due_at,
    })
    .from(legacyFindings)
    .innerJoin(pages, eq(pages.id, legacyFindings.page_id))
    .leftJoin(
      remediationTickets,
      and(
        eq(remediationTickets.source_id, legacyFindings.id),
        eq(remediationTickets.source_type, 'legacy'),
      ),
    )
    .where(eq(pages.firm_id, firmId))
    .orderBy(desc(legacyFindings.semantic_distance));

  return rows;
}

export type SuppressionSummary = {
  totalPages: number;
  noindexCount: number;
  rewriteCount: number;
  alignedCount: number;
  avgDistance: number | null;
};

/**
 * Quick summary counts for the top-of-page stat tiles. We count every page
 * row (across all runs) since the `pages` upsert means one row per URL,
 * not per scan. "aligned" = pages with no matching finding, i.e. pages
 * that didn't trip the rewrite threshold on the latest scoring.
 *
 * avgDistance is computed across findings only — a firm with 50 aligned
 * pages and 2 unaligned would otherwise get a tiny-looking average that
 * hides the problem.
 */
export async function getSuppressionSummary(firmSlug: string): Promise<SuppressionSummary> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  const pageRows = await db
    .select({ id: pages.id })
    .from(pages)
    .where(eq(pages.firm_id, firmId));

  const findingRows = await db
    .select({
      action: legacyFindings.action,
      semanticDistance: legacyFindings.semantic_distance,
    })
    .from(legacyFindings)
    .innerJoin(pages, eq(pages.id, legacyFindings.page_id))
    .where(eq(pages.firm_id, firmId));

  const noindexCount = findingRows.filter((f) => f.action === 'noindex').length;
  const rewriteCount = findingRows.filter((f) => f.action === 'rewrite').length;
  const totalPages = pageRows.length;
  const alignedCount = Math.max(totalPages - noindexCount - rewriteCount, 0);

  const avgDistance =
    findingRows.length === 0
      ? null
      : findingRows.reduce((sum, r) => sum + r.semanticDistance, 0) /
        findingRows.length;

  return {
    totalPages,
    noindexCount,
    rewriteCount,
    alignedCount,
    avgDistance,
  };
}
