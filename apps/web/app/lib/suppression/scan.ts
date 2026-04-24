import {
  getDb,
  auditRuns,
  pages,
  legacyFindings,
  remediationTickets,
  brandTruthVersions,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { eq, desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { crawlViaSitemap } from './crawler';
import { fetchAndExtract } from './extract';
import {
  brandTruthToText,
  embedBatch,
  embedSingle,
  semanticDistance,
  EMBEDDING_MODEL,
} from './embeddings';

/**
 * Suppression scan — see PLAN §5.3.
 *
 * Flow per run:
 *   1. Create an auditRuns row (kind='suppression').
 *   2. Resolve the firm's site URL (from Brand Truth payload).
 *   3. Crawl sitemap.xml → list of URLs.
 *   4. Fetch + extract main content for each URL (serial; each fetch is
 *      slow enough that parallelism risks rate-limiting the target site).
 *   5. Embed each extracted page's main content + the Brand Truth
 *      centroid (single embedding call).
 *   6. Compute semantic distance; apply threshold rules → legacy_finding
 *      + remediation_ticket rows.
 *   7. Upsert `page` rows so re-runs don't duplicate.
 *
 * Thresholds from PLAN §5.3:
 *   - d > 0.45  → no-index candidate (action = 'noindex')
 *   - 0.30 < d ≤ 0.45 → rewrite candidate
 *   - d ≤ 0.30  → aligned, no action
 *
 * The PLAN also distinguishes "no-index" vs "301 to closest aligned page"
 * based on backlinks. We don't have a backlinks source yet, so the v1
 * default for d > 0.45 is `'noindex'`; the UI can surface a redirect
 * override when the operator knows better.
 */

const PAGE_CONCURRENCY = 1; // Be polite — firm sites are small targets.
const MAX_URLS_DEFAULT = 75;

const DISTANCE_THRESHOLD_REWRITE = 0.30;
const DISTANCE_THRESHOLD_SUPPRESS = 0.45;
const MIN_WORDS_TO_SCORE = 150; // Skip thin pages (contact, thank-you, etc).

export interface RunSuppressionOptions {
  maxUrls?: number;
}

function hashContent(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

/**
 * Figure out the firm's primary web presence. BrandTruth has `primary_url`
 * in some variants, `website` in others. We try both; if neither is set
 * we bail with a clear error so the UI can nudge the operator to complete
 * the Brand Truth first.
 */
function resolveFirmSiteUrl(brandTruth: BrandTruth): string {
  const bt = brandTruth as any;
  const candidates = [bt.primary_url, bt.website, bt.homepage_url];
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c)) return c;
  }
  throw new Error(
    'Brand Truth missing a primary URL — add `primary_url` / `website` to scan for legacy content',
  );
}

export async function runSuppressionScan(
  firmId: string,
  options: RunSuppressionOptions = {},
): Promise<string> {
  const db = getDb();
  const maxUrls = options.maxUrls ?? MAX_URLS_DEFAULT;

  // Create the run record up-front so the UI can poll status even while
  // crawl + embeddings are still running.
  const [run] = await db
    .insert(auditRuns)
    .values({
      firm_id: firmId,
      kind: 'suppression',
      status: 'running',
      started_at: new Date(),
    })
    .returning({ id: auditRuns.id });

  const runId = run!.id;

  try {
    // Pull the latest Brand Truth payload.
    const [btv] = await db
      .select()
      .from(brandTruthVersions)
      .where(eq(brandTruthVersions.firm_id, firmId))
      .orderBy(desc(brandTruthVersions.version))
      .limit(1);

    if (!btv) {
      throw new Error('Firm has no Brand Truth — create one before scanning');
    }
    const brandTruth = btv.payload as BrandTruth;
    const siteUrl = resolveFirmSiteUrl(brandTruth);

    // 1. Crawl.
    const crawl = await crawlViaSitemap({ firmSiteUrl: siteUrl, maxUrls });
    if (crawl.urls.length === 0) {
      throw new Error('Sitemap found but no crawlable URLs after filtering');
    }

    // 2. Fetch + extract sequentially. We log per-URL failures and skip
    // them rather than aborting the whole run — a handful of 404s shouldn't
    // erase an otherwise-complete scan.
    const extracted: Array<{
      url: string;
      title: string | null;
      mainContent: string;
      wordCount: number;
    }> = [];

    for (let i = 0; i < crawl.urls.length; i += PAGE_CONCURRENCY) {
      const slice = crawl.urls.slice(i, i + PAGE_CONCURRENCY);
      const results = await Promise.allSettled(
        slice.map((u) => fetchAndExtract(u)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          const { url, title, mainContent, wordCount } = r.value;
          if (wordCount >= MIN_WORDS_TO_SCORE) {
            extracted.push({ url, title, mainContent, wordCount });
          }
        }
        // Silent skip on fetch/extract errors — logged in run metadata below.
      }
    }

    if (extracted.length === 0) {
      throw new Error('No pages with enough content to score (min 150 words)');
    }

    // 3. Embed Brand Truth centroid + all page contents.
    const bTruthText = brandTruthToText(brandTruth);
    const [brandVec, pageVecs] = await Promise.all([
      embedSingle(bTruthText),
      embedBatch(extracted.map((p) => p.mainContent)),
    ]);

    if (pageVecs.length !== extracted.length) {
      throw new Error(
        `Embedding count mismatch: ${pageVecs.length} vs ${extracted.length} pages`,
      );
    }

    // 4. Per-page: upsert page row, compute distance, write findings +
    // remediation tickets for anything past the rewrite threshold.
    for (let i = 0; i < extracted.length; i++) {
      const page = extracted[i]!;
      const vec = pageVecs[i]!;
      const distance = semanticDistance(brandVec, vec);

      // Upsert by (firm_id, url). Re-runs refresh the embedding + content.
      const [existing] = await db
        .select({ id: pages.id })
        .from(pages)
        .where(eq(pages.url, page.url))
        .limit(1);

      let pageId: string;
      const contentHash = hashContent(page.mainContent);
      if (existing) {
        await db
          .update(pages)
          .set({
            title: page.title,
            content_hash: contentHash,
            main_content: page.mainContent,
            word_count: page.wordCount,
            embedding: vec,
            embedding_model: EMBEDDING_MODEL,
            fetched_at: new Date(),
          })
          .where(eq(pages.id, existing.id));
        pageId = existing.id;
      } else {
        const [inserted] = await db
          .insert(pages)
          .values({
            firm_id: firmId,
            url: page.url,
            title: page.title,
            content_hash: contentHash,
            main_content: page.mainContent,
            word_count: page.wordCount,
            embedding: vec,
            embedding_model: EMBEDDING_MODEL,
            fetched_at: new Date(),
          })
          .returning({ id: pages.id });
        pageId = inserted!.id;
      }

      // Classify + record.
      if (distance > DISTANCE_THRESHOLD_REWRITE) {
        const action =
          distance > DISTANCE_THRESHOLD_SUPPRESS ? 'noindex' : 'rewrite';
        const rationale =
          action === 'noindex'
            ? `Semantic distance ${distance.toFixed(3)} > ${DISTANCE_THRESHOLD_SUPPRESS} — page doesn't reflect the Brand Truth; candidate for noindex or redirect to the closest aligned page.`
            : `Semantic distance ${distance.toFixed(3)} in (${DISTANCE_THRESHOLD_REWRITE}, ${DISTANCE_THRESHOLD_SUPPRESS}] — rewrite to align with Brand Truth positioning while keeping on-page entities.`;

        const [finding] = await db
          .insert(legacyFindings)
          .values({
            page_id: pageId,
            semantic_distance: distance,
            action,
            rationale,
          })
          .returning({ id: legacyFindings.id });

        // Create a remediation ticket so the finding surfaces alongside
        // audit-driven Red tickets. noindex gets a shorter due date than
        // rewrite — an unaligned page leaking to LLMs is more urgent than
        // a fixable one.
        await db.insert(remediationTickets).values({
          firm_id: firmId,
          source_type: 'legacy',
          source_id: finding!.id,
          status: 'open',
          playbook_step: action === 'noindex' ? 'suppress' : 'rewrite',
          due_at: new Date(
            Date.now() +
              (action === 'noindex' ? 3 : 14) * 24 * 60 * 60 * 1000,
          ),
        });
      }
    }

    await db
      .update(auditRuns)
      .set({ status: 'completed', finished_at: new Date() })
      .where(eq(auditRuns.id, runId));
  } catch (err) {
    await db
      .update(auditRuns)
      .set({
        status: 'failed',
        finished_at: new Date(),
        error: String(err),
      })
      .where(eq(auditRuns.id, runId));
  }

  return runId;
}
