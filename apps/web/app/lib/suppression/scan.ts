import {
  getDb,
  auditRuns,
  pages,
  legacyFindings,
  remediationTickets,
  brandTruthVersions,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { eq, desc, and, inArray } from 'drizzle-orm';
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
import {
  getBacklinksProvider,
  decideSuppressionAction,
  buildRationale,
  type BacklinkCount,
} from './backlinks';

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
 * Thresholds (calibrated against text-embedding-3-large empirical
 * distance distribution):
 *   - d > 0.55  → no-index candidate (action = 'noindex')
 *   - 0.40 < d ≤ 0.55 → rewrite candidate
 *   - d ≤ 0.40  → aligned, no action
 *
 * Calibration history: PLAN §5.3 originally specified 0.30 / 0.45, but
 * those bounds produced ~95% noindex rates on real firm sites (Andrew
 * Pickett Law: 73/75 noindex) because text-embedding-3-large produces
 * distances in [0.3, 0.5] for genuinely on-brand pages whose vocabulary
 * doesn't *exactly* mirror the Brand Truth centroid. We bumped both
 * thresholds by 0.10 — false-positive noindex (suppressing a real
 * on-brand page) destroys operator trust, so erring conservative on the
 * upper bound is worth missing some legacy pages we'd then catch with
 * a tighter centroid in v2. We also enriched `brandTruthToText` to
 * include attorney bio bodies + case summaries so the centroid carries
 * the firm's actual vocabulary, not just its taxonomy.
 *
 * The PLAN also distinguishes "no-index" vs "301 to closest aligned page"
 * based on backlinks. We don't have a backlinks source yet, so the v1
 * default for d > 0.55 is `'noindex'`; the UI can surface a redirect
 * override when the operator knows better.
 */

const PAGE_CONCURRENCY = 1; // Be polite — firm sites are small targets.
const MAX_URLS_DEFAULT = 75;

const DISTANCE_THRESHOLD_REWRITE = 0.40;
const DISTANCE_THRESHOLD_SUPPRESS = 0.55;
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

    // 0. Wipe prior open suppression findings + their unfinished tickets.
    //
    // A re-scan replaces the prior report — this is the operator's mental
    // model ("I clicked Run Scan, the new numbers should be the truth")
    // and the only way calibration changes are verifiable from the UI.
    // We *keep* findings whose ticket the operator already closed; those
    // are historical record (and the ticket close-out is auditable).
    //
    // Order matters: tickets first (they FK to findings via source_id),
    // then findings (they FK to pages, which we leave intact since pages
    // get upserted below).
    const priorOpenFindings = await db
      .select({
        findingId: legacyFindings.id,
      })
      .from(legacyFindings)
      .innerJoin(pages, eq(pages.id, legacyFindings.page_id))
      .innerJoin(
        remediationTickets,
        and(
          eq(remediationTickets.source_id, legacyFindings.id),
          eq(remediationTickets.source_type, 'legacy'),
        ),
      )
      .where(
        and(
          eq(pages.firm_id, firmId),
          inArray(remediationTickets.status, ['open', 'in_progress']),
        ),
      );

    if (priorOpenFindings.length > 0) {
      const ids = priorOpenFindings.map((r) => r.findingId);
      // Delete the open tickets first (FK constraint).
      await db
        .delete(remediationTickets)
        .where(
          and(
            eq(remediationTickets.source_type, 'legacy'),
            inArray(remediationTickets.source_id, ids),
            inArray(remediationTickets.status, ['open', 'in_progress']),
          ),
        );
      // Then delete the now-orphan findings.
      await db
        .delete(legacyFindings)
        .where(inArray(legacyFindings.id, ids));
    }

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

    // 2.5 Resolve backlinks provider once. NullProvider when no API key
    // is configured — every getBacklinks() call returns 0 ref-domains so
    // the action policy keeps current 'noindex' behavior. With Ahrefs or
    // DataForSEO credentials in env, providers light up automatically.
    const backlinksProvider = getBacklinksProvider();

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

      // Classify + record. With Phase B #4 wiring: when distance > suppress
      // threshold AND backlinks ≥ 5 ref-domains, action becomes 'redirect'
      // instead of 'noindex' — preserves link equity for pages worth saving.
      // backlinksProvider is resolved once outside the loop; the per-URL
      // lookup is async + paid, so we only call it when distance is in
      // the suppress range (the only place the result changes our action).
      if (distance > DISTANCE_THRESHOLD_REWRITE) {
        let backlinks: BacklinkCount | null = null;
        if (distance > DISTANCE_THRESHOLD_SUPPRESS) {
          // Only ask the backlinks provider when the action might flip to
          // redirect — for rewrite-bucket findings the answer is irrelevant
          // and we'd waste API quota.
          backlinks = await backlinksProvider.getBacklinks(page.url);
        }
        const action = decideSuppressionAction(
          distance,
          {
            rewrite: DISTANCE_THRESHOLD_REWRITE,
            suppress: DISTANCE_THRESHOLD_SUPPRESS,
          },
          backlinks,
        );
        // 'aligned' shouldn't reach here (we gated on > rewrite threshold)
        // but the type makes us handle it explicitly.
        if (action === 'aligned') continue;
        const rationale = buildRationale(
          distance,
          action,
          {
            rewrite: DISTANCE_THRESHOLD_REWRITE,
            suppress: DISTANCE_THRESHOLD_SUPPRESS,
          },
          backlinks,
        );

        const [finding] = await db
          .insert(legacyFindings)
          .values({
            page_id: pageId,
            semantic_distance: distance,
            action,
            rationale,
          })
          .returning({ id: legacyFindings.id });

        // Ticket policy:
        //   noindex  → 3-day due (unaligned page leaking to LLMs is urgent)
        //   redirect → 7-day due (less urgent than noindex; preserves link
        //                          equity but operator needs to map to the
        //                          closest aligned page)
        //   rewrite  → 14-day due (content work, longest runway)
        const dueDays =
          action === 'noindex' ? 3 : action === 'redirect' ? 7 : 14;
        const playbookStep =
          action === 'noindex'
            ? 'suppress'
            : action === 'redirect'
              ? 'redirect'
              : 'rewrite';
        await db.insert(remediationTickets).values({
          firm_id: firmId,
          source_type: 'legacy',
          source_id: finding!.id,
          status: 'open',
          playbook_step: playbookStep,
          due_at: new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000),
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
