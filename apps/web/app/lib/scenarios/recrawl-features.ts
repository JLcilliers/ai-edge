import {
  getDb,
  pages,
  pageFeatures,
  brandTruthVersions,
  legacyFindings,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { fetchHtml } from '../suppression/extract';
import { extractFeaturesFromHtml } from './features';
import type { FeatureVec } from './ranker-feature-list';

/**
 * Per-page full-HTML feature recrawl.
 *
 * Why this exists. The original `extractFeaturesForFirm` action runs the
 * degraded `extractFeaturesFromMainContent` path against `pages.main_content`
 * — which is the readability-stripped text, NOT the original HTML. That
 * means every JSON-LD-presence feature, every heading-count feature, and
 * every link-density feature defaults to 0 across the whole corpus. The
 * Scenario Lab can technically calibrate against that, but the resulting
 * weights for those features are meaningless because the input column is
 * a flat zero.
 *
 * What this fixes. We re-fetch each page's HTML, run the full
 * `extractFeaturesFromHtml` extractor, and overwrite the `page_features`
 * row with a vector that has REAL values across all 22 dimensions. PSO
 * calibration can now learn meaningful weights for schema/heading/link
 * features.
 *
 * Cost considerations. One HTTP request per page. Andrew Pickett Law
 * has 75 pages → 75 round-trips at ~200ms-2s each. We run them
 * sequentially with a small delay (politeness — these are firm sites,
 * not search engines, and they shouldn't be hammered). Total wall-clock
 * around 1-3 minutes for typical firms. Wrapped in a try/catch per page
 * so a couple of 404s can't blow up the whole pass.
 *
 * Centroid distance. We try to reuse the suppression scan's output: if
 * a `legacy_finding` row exists for this page, its `semantic_distance`
 * is the live distance to the Brand Truth centroid — pass it through.
 * For aligned pages (no finding row), we fall back to the page's stored
 * embedding vs a fresh centroid embedding, but in practice we surface
 * `centroidDistance: undefined` and let the centroid_similarity feature
 * default to 0 — preferable to faking a number.
 */

export interface RecrawlOutcome {
  pagesScanned: number;
  pagesWithFullFeatures: number;
  pagesSkippedNetworkError: number;
  pagesSkippedNoUrl: number;
  errors: Array<{ url: string; error: string }>;
}

interface RecrawlOptions {
  /** Stop after N pages — useful for testing without hammering a site. */
  limit?: number;
  /** Delay between fetches in ms; default 250ms is light politeness. */
  delayMs?: number;
}

function safeHostFromUrl(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Map page_id → semantic_distance from the most recent suppression finding
 * for that page. Used so per-page features get the real centroid_similarity
 * signal without re-embedding.
 */
async function buildDistanceMap(
  firmId: string,
  pageIds: string[],
): Promise<Map<string, number>> {
  if (pageIds.length === 0) return new Map();
  const db = getDb();
  // legacy_finding has multiple rows per page across re-scans — take the
  // newest by detected_at. Drizzle doesn't have a clean "latest per group"
  // helper, so we pull all matching rows and dedupe in memory.
  const rows = await db
    .select({
      pageId: legacyFindings.page_id,
      distance: legacyFindings.semantic_distance,
      detectedAt: legacyFindings.detected_at,
    })
    .from(legacyFindings)
    .where(inArray(legacyFindings.page_id, pageIds))
    .orderBy(desc(legacyFindings.detected_at));
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!out.has(r.pageId)) out.set(r.pageId, r.distance);
  }
  return out;
}

export async function recrawlFeaturesForFirm(
  firmId: string,
  options: RecrawlOptions = {},
): Promise<RecrawlOutcome> {
  const db = getDb();
  const delayMs = options.delayMs ?? 250;

  const pageRows = await db
    .select()
    .from(pages)
    .where(eq(pages.firm_id, firmId));
  if (pageRows.length === 0) {
    return {
      pagesScanned: 0,
      pagesWithFullFeatures: 0,
      pagesSkippedNetworkError: 0,
      pagesSkippedNoUrl: 0,
      errors: [],
    };
  }

  // Resolve firm host from Brand Truth so internal-vs-external link counts
  // are correct. Fallback to the most common host across pages if Brand
  // Truth is missing primary_url.
  const [btv] = await db
    .select()
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  const bt = (btv?.payload ?? null) as BrandTruth | null;
  const primaryUrl = (bt as { primary_url?: string } | null)?.primary_url ?? null;
  let firmHost = primaryUrl ? safeHostFromUrl(primaryUrl) : undefined;
  if (!firmHost && pageRows.length > 0) {
    const counts = new Map<string, number>();
    for (const p of pageRows) {
      const host = safeHostFromUrl(p.url);
      if (!host) continue;
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    let best: { host: string; n: number } | null = null;
    for (const [host, n] of counts) {
      if (!best || n > best.n) best = { host, n };
    }
    firmHost = best?.host;
  }

  // Distance lookup (page_id → semantic_distance). Empty for pages without
  // findings; those get centroidSimilarity computed as 0 (default), which
  // is correct since they're "aligned" — distance ≤ 0.40 — and the feature
  // emphasizes deviation, not closeness.
  const distanceByPageId = await buildDistanceMap(
    firmId,
    pageRows.map((p) => p.id),
  );

  const subset = options.limit
    ? pageRows.slice(0, options.limit)
    : pageRows;

  let withFull = 0;
  let netErrors = 0;
  let noUrl = 0;
  const errors: Array<{ url: string; error: string }> = [];

  for (const page of subset) {
    if (!page.url) {
      noUrl += 1;
      continue;
    }
    let html: string;
    try {
      const fetched = await fetchHtml(page.url);
      html = fetched.html;
    } catch (err) {
      netErrors += 1;
      errors.push({
        url: page.url,
        error: err instanceof Error ? err.message : String(err),
      });
      // Light delay even on error — don't hammer a flaky host.
      if (delayMs > 0) await sleep(delayMs);
      continue;
    }

    const days = page.fetched_at
      ? Math.max(0, (Date.now() - new Date(page.fetched_at).getTime()) / 86400_000)
      : undefined;

    let fv: FeatureVec;
    try {
      fv = extractFeaturesFromHtml(html, {
        url: page.url,
        // No query at recrawl time — keyword features stay 0 here. Per-scenario
        // recompute fills them in at scenario time using the scenario's query.
        query: undefined,
        centroidDistance: distanceByPageId.get(page.id),
        freshnessDays: days,
        firmHost,
      });
    } catch (err) {
      errors.push({
        url: page.url,
        error: 'extract failed: ' + (err instanceof Error ? err.message : String(err)),
      });
      if (delayMs > 0) await sleep(delayMs);
      continue;
    }

    // Upsert by (firm_id, url) — same shape as the existing extractor.
    const [existing] = await db
      .select({ id: pageFeatures.id })
      .from(pageFeatures)
      .where(
        and(eq(pageFeatures.firm_id, firmId), eq(pageFeatures.url, page.url)),
      )
      .limit(1);
    if (existing) {
      await db
        .update(pageFeatures)
        .set({
          features: fv as unknown as Record<string, number>,
          page_id: page.id,
          extracted_at: new Date(),
        })
        .where(eq(pageFeatures.id, existing.id));
    } else {
      await db.insert(pageFeatures).values({
        firm_id: firmId,
        page_id: page.id,
        url: page.url,
        features: fv as unknown as Record<string, number>,
      });
    }
    withFull += 1;
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    pagesScanned: subset.length,
    pagesWithFullFeatures: withFull,
    pagesSkippedNetworkError: netErrors,
    pagesSkippedNoUrl: noUrl,
    errors,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
