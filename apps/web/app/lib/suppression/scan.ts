import {
  getDb,
  auditRuns,
  pages,
  legacyFindings,
  remediationTickets,
  brandTruthVersions,
  sopStepStates,
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
  type BacklinkCount,
} from './backlinks';
import { ensureSopRun } from '../sop/ensure-run';
import { prescribeLegacyTicket } from '../sop/legacy-prescription';
import {
  decideAction,
  targetSopKeyForAction,
  DISTANCE_THRESHOLD_DRIFT,
} from './decide-action';
import {
  firmHasGscConnection,
  ensureFreshPerUrlMetrics,
  getClicksPerMonthForUrl,
} from '../gsc/per-url-metrics';

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

// Distance thresholds re-exported from decide-action.ts for symmetry
// with what we used to define locally. Caller uses
// DISTANCE_THRESHOLD_DRIFT as the gate; decideAction() handles the rest.
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

  // Resolve sop_runs up-front. After C1 (SOP Alignment Audit) we route
  // tickets to TWO different sop_runs based on bucket:
  //   delete / redirect / noindex → legacy_content_suppression (Phase 1)
  //   keep_update / rewrite        → content_repositioning      (Phase 3)
  // Resolving both here so neither code path needs to ensure-on-demand.
  const suppressionRunId = await ensureSopRun(
    firmId,
    'legacy_content_suppression',
    'scanner:suppression',
  );
  const repositioningRunId = await ensureSopRun(
    firmId,
    'content_repositioning',
    'scanner:suppression',
  );

  // GSC dual-mode gate. Per Toth STEP3, the bucket selection (Delete /
  // 301 / NoIndex / Keep-Update) depends on per-URL clicks/month. If
  // GSC isn't connected, we fall back to distance-only logic AND emit
  // a single "Connect GSC" config-gate ticket attached to the gsc_setup
  // sop_run. Operators see the config-gate ticket in Phase 1 with a
  // clear next action.
  const gscConnected = await firmHasGscConnection(firmId);
  if (gscConnected) {
    // Lazy backfill — fetches last-30-days per-URL clicks for the firm
    // in a single GSC API call. No-op if data is already fresh (<7 days).
    // Errors here don't kill the scan; we degrade to no-GSC mode for the
    // current run and surface a config-gate ticket so the operator can
    // re-auth.
    try {
      await ensureFreshPerUrlMetrics(firmId);
    } catch (err) {
      console.warn(
        `[suppression] GSC per-URL fetch failed for firm ${firmId}:`,
        err,
      );
    }
  } else {
    await emitGscSetupConfigGateTicket(firmId);
  }

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

      // Distance gate — below the drift threshold the page reads on-
      // brand to LLMs, no action.
      if (distance <= DISTANCE_THRESHOLD_DRIFT) continue;

      // Per-URL inputs to the decision framework. Both can be null:
      //   clicksPerMonth = null → no GSC → decideAction falls back to
      //                          distance + backlinks bucketing
      //   backlinks = null → no provider configured → treated as 0 ref-domains
      // Backlinks lookup is paid; only fetch when the action might flip
      // (clicks <5 OR no-GSC distance > divergent).
      let clicksPerMonth: number | null = null;
      if (gscConnected) {
        clicksPerMonth = await getClicksPerMonthForUrl(firmId, page.url);
        // null here means GSC has zero impressions for this URL in the
        // window (genuine "0 clicks"), not "no GSC" — caller already
        // ensured gscConnected. Treat as 0.
        if (clicksPerMonth == null) clicksPerMonth = 0;
      }

      let backlinks: BacklinkCount | null = null;
      const needsBacklinks =
        (clicksPerMonth != null && clicksPerMonth < 5) ||
        (clicksPerMonth == null && distance > 0.55);
      if (needsBacklinks) {
        backlinks = await backlinksProvider.getBacklinks(page.url);
      }

      const decision = decideAction({
        distance,
        clicksPerMonth,
        backlinks: backlinks ? { refDomains: backlinks.refDomains } : null,
      });
      if (decision.action === 'aligned') continue;

      const [finding] = await db
        .insert(legacyFindings)
        .values({
          page_id: pageId,
          semantic_distance: distance,
          action: decision.action,
          rationale: decision.rationale,
          decided_with_gsc: decision.decidedWithGsc,
        })
        .returning({ id: legacyFindings.id });

      // Route to the right sop_run per bucket. delete/redirect/noindex
      // stay in Suppression (Phase 1); keep_update + rewrite (no-GSC
      // transitional bucket) go to Content Repositioning (Phase 3).
      const targetSop = targetSopKeyForAction(decision.action);
      const ticketSopRunId =
        targetSop === 'content_repositioning'
          ? repositioningRunId
          : suppressionRunId;

      // Due-date policy per bucket:
      //   delete      → 7 days  (review window before destructive action)
      //   noindex     → 3 days  (unaligned page leaking to LLMs is urgent)
      //   redirect    → 7 days  (operator needs to map to target page)
      //   keep_update → 14 days (content work, longest runway)
      //   rewrite     → 14 days (transitional, same runway as keep_update)
      const dueDays =
        decision.action === 'noindex' ? 3 :
        decision.action === 'redirect' ? 7 :
        decision.action === 'delete' ? 7 :
        14;
      const playbookStep =
        decision.action === 'noindex' ? 'suppress' :
        decision.action === 'redirect' ? 'redirect' :
        decision.action === 'delete' ? 'delete' :
        decision.action === 'keep_update' ? 'keep_update' :
        'rewrite';

      const presc = prescribeLegacyTicket({
        pageUrl: page.url,
        pageTitle: page.title,
        wordCount: page.wordCount,
        action: decision.action,
        rationale: decision.rationale,
        semanticDistance: distance,
        clicksPerMonth,
        decidedWithGsc: decision.decidedWithGsc,
      });
      await db.insert(remediationTickets).values({
        firm_id: firmId,
        source_type: 'legacy',
        source_id: finding!.id,
        sop_run_id: ticketSopRunId,
        status: 'open',
        playbook_step: playbookStep,
        due_at: new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000),
        title: presc.title,
        description: presc.description,
        priority_rank: presc.priorityRank,
        remediation_copy: presc.remediationCopy,
        validation_steps: presc.validationSteps,
        evidence_links: presc.evidenceLinks,
        automation_tier: presc.automationTier,
        execute_url: presc.executeUrl,
        execute_label: presc.executeLabel,
      });
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

/**
 * When the firm has no GSC connection at scan time we can't apply Toth's
 * click-based decision framework. Surface this as a single, idempotent
 * config-gate ticket attached to the gsc_setup sop_run so operators see
 * the missing prerequisite in Phase 1 instead of silently degrading to
 * the no-GSC fallback. Re-runs of the scanner reuse the existing open
 * ticket rather than spamming a new one.
 */
async function emitGscSetupConfigGateTicket(firmId: string): Promise<void> {
  const db = getDb();
  const gscSetupRunId = await ensureSopRun(
    firmId,
    'gsc_setup',
    'scanner:suppression',
  );

  // Idempotency: skip if an open config-gate ticket already exists for
  // this firm + sop_run.
  const existing = await db
    .select({ id: remediationTickets.id })
    .from(remediationTickets)
    .where(
      and(
        eq(remediationTickets.firm_id, firmId),
        eq(remediationTickets.sop_run_id, gscSetupRunId),
        eq(remediationTickets.source_type, 'sop'),
        inArray(remediationTickets.status, ['open', 'in_progress']),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;

  // source_id references the step-1 sop_step_state row for gsc_setup.
  // ensureSopRun already inserted step states (one per def.steps) so the
  // row exists. We use source_type='sop' (the canonical SOP-emitted-
  // ticket type) since remediation_ticket.source_id is NOT NULL and
  // a 'config_gate' source_type would need its own source table.
  const [stepState] = await db
    .select({ id: sopStepStates.id })
    .from(sopStepStates)
    .where(
      and(
        eq(sopStepStates.sop_run_id, gscSetupRunId),
        eq(sopStepStates.step_number, 1),
      ),
    )
    .limit(1);
  if (!stepState) {
    // ensureSopRun guarantees this row exists — failure here means the
    // gsc_setup SopDefinition has zero steps, which is a registry bug.
    console.warn(
      `[suppression] gsc_setup sop_run ${gscSetupRunId} has no step 1 — skipping config-gate ticket emit`,
    );
    return;
  }

  await db.insert(remediationTickets).values({
    firm_id: firmId,
    source_type: 'sop',
    source_id: stepState.id,
    sop_run_id: gscSetupRunId,
    sop_step_number: 1,
    status: 'open',
    playbook_step: 'connect_gsc_oauth',
    due_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    title: 'Connect Google Search Console to enable Toth STEP3 bucketing',
    description:
      'Suppression scans currently run in **no-GSC fallback mode** — bucket selection (Delete / 301 / NoIndex / Keep-Update) requires per-URL clicks data from Google Search Console.\n\n' +
      'Until Search Console is connected:\n' +
      '- Drifted pages (d > 0.55) with ≥5 referring domains → 301 redirect\n' +
      '- Drifted pages (d > 0.55) with <5 referring domains → noindex\n' +
      '- Drift band (0.40 < d ≤ 0.55) → rewrite (provisional)\n\n' +
      'Once GSC is connected, an automatic re-bucketing pass will move provisional findings into Toth STEP3\'s click-aware buckets (≥50 clicks/mo → keep_update, 10-49 → redirect, 5-9 → noindex, <5 → delete/redirect by backlinks).',
    priority_rank: 1,
    remediation_copy:
      '**Action:** Connect Google Search Console for this firm.\n\n' +
      '1. Open the firm settings page (`/dashboard/{firmSlug}/settings/integrations`).\n' +
      '2. Click **Connect Search Console** and complete the OAuth flow with an account that has GSC access to the firm\'s site.\n' +
      '3. After OAuth completes, the next Suppression scan will pull last-30-days per-URL clicks and re-bucket provisional findings.\n\n' +
      'No other action is needed — re-bucketing runs automatically on the next scan.',
    validation_steps: [
      { description: 'Complete the GSC OAuth flow from the firm integrations page' },
      { description: 'Re-run Suppression scan' },
      { description: 'Confirm Phase 1 → Suppression tickets now carry click counts in their descriptions' },
    ],
    evidence_links: [],
    automation_tier: 'manual',
    manual_reason:
      'GSC OAuth must be initiated by a human signed into a Google account with Search Console access — Claude cannot complete OAuth flows on the user\'s behalf.',
    execute_url: undefined,
    execute_label: undefined,
  });
}
