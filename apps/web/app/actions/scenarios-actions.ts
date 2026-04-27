'use server';

import {
  getDb,
  firms,
  pages,
  serpSnapshots,
  serpResults,
  pageFeatures,
  rankerWeights,
  scenarios,
  brandTruthVersions,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { eq, desc, and, inArray, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { extractFeaturesFromMainContent } from '../lib/scenarios/features';
import { runCalibration, getLatestWeights } from '../lib/scenarios/calibrate';
import { simulate, type ConfidenceLabel } from '../lib/scenarios/simulate';
import { recrawlFeaturesForFirm } from '../lib/scenarios/recrawl-features';
import { captureSerpsForFirm } from '../lib/scenarios/serp-capture';
import {
  emptyFeatureVec,
  type FeatureVec,
  type Weights,
} from '../lib/scenarios/ranker-feature-list';

/**
 * Server actions for the Scenario Lab.
 *
 * Surface area kept deliberately small — the page calls:
 *   - getScenarioOverview      → counts + latest weights for the dashboard
 *   - listSerps                → paste-in management
 *   - addManualSerp            → operator pastes a SERP
 *   - deleteSerp
 *   - listScenarios            → list view
 *   - createScenario           → create + simulate in one shot
 *   - recomputeScenario        → re-run simulation against latest weights
 *   - deleteScenario
 *   - extractFeaturesForFirm   → batch extraction across a firm's pages
 *   - runFirmCalibration       → kicks off PSO
 *
 * Authorization model matches the rest of the dashboard — caller's scope
 * is implicit by firmSlug; we resolve to firm_id and trust the lookup.
 */

// ── Common helpers ──────────────────────────────────────────

async function resolveFirmId(firmSlug: string): Promise<string> {
  const db = getDb();
  const [row] = await db
    .select({ id: firms.id })
    .from(firms)
    .where(eq(firms.slug, firmSlug))
    .limit(1);
  if (!row) throw new Error(`Firm not found: ${firmSlug}`);
  return row.id;
}

function safeHostFromUrl(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

// ── Overview ────────────────────────────────────────────────

export interface ScenarioOverview {
  firmSlug: string;
  firmName: string;
  serpCount: number;
  scenarioCount: number;
  pageFeatureCount: number;
  latestWeights: {
    generation: number;
    fitness: number;
    observationCount: number;
    trainedAt: Date;
  } | null;
  /** From the firm's brand truth — enables the keyword-feature flags. */
  primaryUrl: string | null;
  /** Seed queries from Brand Truth so the scenario form has a default
   *  picker without re-fetching. */
  seedQueries: string[];
}

export async function getScenarioOverview(firmSlug: string): Promise<ScenarioOverview> {
  const db = getDb();
  const [firm] = await db
    .select()
    .from(firms)
    .where(eq(firms.slug, firmSlug))
    .limit(1);
  if (!firm) throw new Error('Firm not found');

  const [btv] = await db
    .select()
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firm.id))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  const bt = (btv?.payload ?? null) as BrandTruth | null;
  const primaryUrl: string | null = (bt as { primary_url?: string } | null)?.primary_url ?? null;
  const seedQueries: string[] = bt?.seed_query_intents ?? [];

  const [serpRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(serpSnapshots)
    .where(eq(serpSnapshots.firm_id, firm.id));
  const [scenarioRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scenarios)
    .where(eq(scenarios.firm_id, firm.id));
  const [featureRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pageFeatures)
    .where(eq(pageFeatures.firm_id, firm.id));

  const w = await getLatestWeights(firm.id);

  return {
    firmSlug: firm.slug,
    firmName: firm.name,
    serpCount: serpRow?.n ?? 0,
    scenarioCount: scenarioRow?.n ?? 0,
    pageFeatureCount: featureRow?.n ?? 0,
    latestWeights: w
      ? {
          generation: w.generation,
          fitness: w.fitness,
          observationCount: w.observationCount,
          trainedAt: w.trainedAt,
        }
      : null,
    primaryUrl,
    seedQueries,
  };
}

// ── SERPs ───────────────────────────────────────────────────

export interface SerpRow {
  id: string;
  query: string;
  provider: string;
  fetchedAt: Date;
  resultCount: number;
  notes: string | null;
}

export async function listSerps(firmSlug: string): Promise<SerpRow[]> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);
  // Two queries — snapshot list + per-snapshot result count — joined in
  // memory. Cleaner than a correlated subquery and the result set is tiny
  // (typically <50 SERPs per firm).
  const snaps = await db
    .select({
      id: serpSnapshots.id,
      query: serpSnapshots.query,
      provider: serpSnapshots.provider,
      fetchedAt: serpSnapshots.fetched_at,
      notes: serpSnapshots.notes,
    })
    .from(serpSnapshots)
    .where(eq(serpSnapshots.firm_id, firmId))
    .orderBy(desc(serpSnapshots.fetched_at));
  if (snaps.length === 0) return [];
  const counts = await db
    .select({
      snapshotId: serpResults.snapshot_id,
      n: sql<number>`count(*)::int`,
    })
    .from(serpResults)
    .where(inArray(serpResults.snapshot_id, snaps.map((s) => s.id)))
    .groupBy(serpResults.snapshot_id);
  const countByMap = new Map(counts.map((c) => [c.snapshotId, c.n]));
  return snaps.map((s) => ({
    id: s.id,
    query: s.query,
    provider: s.provider,
    fetchedAt: s.fetchedAt,
    resultCount: countByMap.get(s.id) ?? 0,
    notes: s.notes,
  }));
}

export interface ManualSerpInput {
  query: string;
  /** Plain text — one URL per line. Optional `position` and `title` columns
   *  separated by tabs. We auto-number positions if omitted (line N → rank N).
   *  Accepts the format SerpAPI / DataForSEO export by tolerating extra
   *  columns silently. */
  pasted: string;
  notes?: string;
  country?: string;
  language?: string;
}

interface ParsedSerpLine {
  position: number;
  url: string;
  title?: string;
}

function parseSerpPaste(pasted: string): ParsedSerpLine[] {
  const lines = pasted
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  const out: ParsedSerpLine[] = [];
  let auto = 0;
  for (const line of lines) {
    auto += 1;
    // Tab-separated takes priority; fall back to "position. url" then "url".
    const tabs = line.split(/\t+/);
    let position: number | null = null;
    let url: string | null = null;
    let title: string | undefined;
    if (tabs.length >= 2 && /^\d+$/.test(tabs[0]!)) {
      position = parseInt(tabs[0]!, 10);
      url = tabs[1]!;
      title = tabs[2];
    } else {
      const m = /^(\d+)[\.\)]\s+(.+)$/.exec(line);
      if (m) {
        position = parseInt(m[1]!, 10);
        url = m[2]!;
      } else {
        url = line;
      }
    }
    if (!url) continue;
    // URL sanity — caller pasted something that isn't a URL? Skip silently.
    try {
      new URL(url);
    } catch {
      continue;
    }
    out.push({ position: position ?? auto, url, title });
  }
  return out;
}

export async function addManualSerp(
  firmSlug: string,
  input: ManualSerpInput,
): Promise<{ snapshotId: string; resultCount: number }> {
  if (!input.query.trim()) throw new Error('Query is required');
  const parsed = parseSerpPaste(input.pasted);
  if (parsed.length === 0) {
    throw new Error('No valid URLs found in pasted content. One URL per line, optionally tab-prefixed with rank.');
  }
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  // Resolve firm host so we can flag is_target on the firm's own URLs.
  const [btv] = await db
    .select({ payload: brandTruthVersions.payload })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  const bt = (btv?.payload ?? null) as BrandTruth | null;
  const primaryUrl =
    (bt as { primary_url?: string } | null)?.primary_url ?? null;
  const firmHost = primaryUrl ? safeHostFromUrl(primaryUrl) : null;

  const [snap] = await db
    .insert(serpSnapshots)
    .values({
      firm_id: firmId,
      query: input.query,
      provider: 'manual',
      country: input.country ?? null,
      language: input.language ?? null,
      notes: input.notes ?? null,
    })
    .returning({ id: serpSnapshots.id });

  const rows = parsed.map((p) => {
    const host = safeHostFromUrl(p.url) ?? '';
    return {
      snapshot_id: snap!.id,
      position: p.position,
      url: p.url,
      domain: host,
      title: p.title ?? null,
      is_target: !!firmHost && host === firmHost,
    };
  });
  if (rows.length > 0) {
    await db.insert(serpResults).values(rows);
  }

  revalidatePath(`/dashboard/${firmSlug}/scenarios`);
  return { snapshotId: snap!.id, resultCount: rows.length };
}

export async function deleteSerp(
  firmSlug: string,
  snapshotId: string,
): Promise<{ ok: true }> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);
  // FK ON DELETE CASCADE handles serp_result. Scope by firm_id to prevent
  // cross-tenant deletion via crafted snapshot_id.
  await db
    .delete(serpSnapshots)
    .where(
      and(eq(serpSnapshots.id, snapshotId), eq(serpSnapshots.firm_id, firmId)),
    );
  revalidatePath(`/dashboard/${firmSlug}/scenarios`);
  return { ok: true };
}

// ── Feature extraction ─────────────────────────────────────

export interface ExtractFeaturesOutcome {
  extracted: number;
  skipped: number;
  total: number;
}

/**
 * Extract features for every page already crawled by the suppression
 * scanner. We use the stored `main_content` (degraded extraction; no JSON-LD,
 * no link counts) — getting full HTML features would require a re-crawl,
 * which is expensive enough we leave it as a Phase B cron.
 *
 * The schema-presence features default to 0 in this path. Operators see a
 * UI hint to "re-crawl for full feature extraction."
 */
export async function extractFeaturesForFirm(
  firmSlug: string,
): Promise<ExtractFeaturesOutcome> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  const rows = await db
    .select()
    .from(pages)
    .where(eq(pages.firm_id, firmId));
  if (rows.length === 0) {
    return { extracted: 0, skipped: 0, total: 0 };
  }

  // Pull the firm's centroid distance per page (we already have embedding
  // + brand truth centroid distance baked into legacy_finding rows; for the
  // baseline, we recompute on the fly using the page embedding). To keep
  // this action fast and avoid an OpenAI roundtrip, we *don't* re-embed —
  // we reuse `pages.embedding` if present and pass null centroidDistance
  // to the extractor for pages without one.

  const [btv] = await db
    .select()
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  const bt = (btv?.payload ?? null) as BrandTruth | null;
  const primaryUrl =
    (bt as { primary_url?: string } | null)?.primary_url ?? null;
  // safeHostFromUrl returns string|null; the extractor wants string|undefined.
  const firmHost = (primaryUrl ? safeHostFromUrl(primaryUrl) : null) ?? undefined;

  let extracted = 0;
  let skipped = 0;
  for (const page of rows) {
    if (!page.main_content || page.main_content.length === 0) {
      skipped += 1;
      continue;
    }
    const days = page.fetched_at
      ? Math.max(0, (Date.now() - new Date(page.fetched_at).getTime()) / 86400_000)
      : undefined;
    const fv = extractFeaturesFromMainContent(page.main_content, {
      url: page.url,
      query: undefined,           // batch extraction has no query — keyword
                                  // features stay zero; per-scenario recompute
                                  // fills them in.
      freshnessDays: days,
      firmHost,
    });

    // Upsert by (firm_id, url).
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
    extracted += 1;
  }

  revalidatePath(`/dashboard/${firmSlug}/scenarios`);
  return { extracted, skipped, total: rows.length };
}

/**
 * Slow-but-thorough recrawl: re-fetch each page's HTML and run the full
 * `extractFeaturesFromHtml` extractor (JSON-LD blocks, headings, link
 * counts — everything the degraded `main_content`-only path can't see).
 *
 * Replaces every `page_features` row for the firm with values that have
 * real signal across all 22 dimensions. Until this runs, schema-presence
 * features are universally 0 and PSO can't learn anything about them.
 */
export interface RecrawlFeaturesOutcome {
  pagesScanned: number;
  pagesWithFullFeatures: number;
  pagesSkippedNetworkError: number;
  pagesSkippedNoUrl: number;
  // Cap at ~10 errors in the response — a long error list bloats the
  // server-action payload and the UI surface only shows the first few.
  sampleErrors: Array<{ url: string; error: string }>;
}

export async function recrawlFeaturesViaHtml(
  firmSlug: string,
): Promise<RecrawlFeaturesOutcome> {
  const firmId = await resolveFirmId(firmSlug);
  const outcome = await recrawlFeaturesForFirm(firmId);
  revalidatePath(`/dashboard/${firmSlug}/scenarios`);
  return {
    pagesScanned: outcome.pagesScanned,
    pagesWithFullFeatures: outcome.pagesWithFullFeatures,
    pagesSkippedNetworkError: outcome.pagesSkippedNetworkError,
    pagesSkippedNoUrl: outcome.pagesSkippedNoUrl,
    sampleErrors: outcome.errors.slice(0, 10),
  };
}

/**
 * Manually trigger a Bing Web Search live SERP capture for the firm's
 * top N seed_query_intents. Used by the Observed SERPs tab as a
 * "capture live now" alternative to the manual paste-in flow.
 *
 * Graceful: if BING_SEARCH_API_KEY is not set, every per-query result
 * comes back as skipped — UI surfaces "configure key" rather than
 * masking the gap.
 */
export interface BingCaptureUiOutcome {
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
  perQuery: Array<{
    query: string;
    ok: boolean;
    resultCount?: number;
    reason?: string;
  }>;
}

export async function captureSerpsViaBing(
  firmSlug: string,
  options: { maxQueries?: number; count?: number } = {},
): Promise<BingCaptureUiOutcome> {
  const firmId = await resolveFirmId(firmSlug);
  const outcome = await captureSerpsForFirm(firmId, {
    maxQueries: options.maxQueries ?? 5,
    count: options.count ?? 10,
  });
  revalidatePath(`/dashboard/${firmSlug}/scenarios`);
  return {
    attempted: outcome.attempted,
    succeeded: outcome.succeeded,
    skipped: outcome.skipped,
    failed: outcome.failed,
    perQuery: outcome.perQuery.map((p) => ({
      query: p.query,
      ok: p.outcome.ok,
      resultCount: p.outcome.ok ? p.outcome.resultCount : undefined,
      reason: p.outcome.ok ? undefined : p.outcome.reason,
    })),
  };
}

// ── Calibration ────────────────────────────────────────────

export async function runFirmCalibration(
  firmSlug: string,
): Promise<{
  generation: number;
  fitness: number;
  observationCount: number;
  resultsConsidered: number;
  resultsSkippedNoFeatures: number;
}> {
  const firmId = await resolveFirmId(firmSlug);
  const outcome = await runCalibration(firmId);
  revalidatePath(`/dashboard/${firmSlug}/scenarios`);
  return {
    generation: outcome.generation,
    fitness: outcome.fitness,
    observationCount: outcome.observationCount,
    resultsConsidered: outcome.resultsConsidered,
    resultsSkippedNoFeatures: outcome.resultsSkippedNoFeatures,
  };
}

// ── Scenarios ──────────────────────────────────────────────

export interface ScenarioRow {
  id: string;
  name: string;
  baselineUrl: string;
  query: string;
  description: string | null;
  baselineScore: number | null;
  proposedScore: number | null;
  deltaScore: number | null;
  baselineRank: number | null;
  proposedRank: number | null;
  deltaRank: number | null;
  competitorCount: number | null;
  weightsGenerationUsed: number | null;
  confidenceLabel: string | null;
  proposedChange: Record<string, string | number | boolean>;
  createdAt: Date;
  recomputedAt: Date | null;
}

export async function listScenarios(firmSlug: string): Promise<ScenarioRow[]> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);
  const rows = await db
    .select()
    .from(scenarios)
    .where(eq(scenarios.firm_id, firmId))
    .orderBy(desc(scenarios.created_at));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    baselineUrl: r.baseline_url,
    query: r.query,
    description: r.description,
    baselineScore: r.baseline_score,
    proposedScore: r.proposed_score,
    deltaScore: r.delta_score,
    baselineRank: r.baseline_rank,
    proposedRank: r.proposed_rank,
    deltaRank: r.delta_rank,
    competitorCount: r.competitor_count,
    weightsGenerationUsed: r.weights_generation_used,
    confidenceLabel: r.confidence_label,
    proposedChange: (r.proposed_change ?? {}) as Record<string, string | number | boolean>,
    createdAt: r.created_at,
    recomputedAt: r.recomputed_at,
  }));
}

export interface CreateScenarioInput {
  name: string;
  baselineUrl: string;
  query: string;
  description?: string;
  proposedChange: Record<string, string | number | boolean>;
}

/**
 * Resolve baseline + competitor features for a given (firm, baselineUrl,
 * query) tuple, then run the simulator. Used by both create and recompute.
 */
async function simulateForFirm(
  firmId: string,
  input: { baselineUrl: string; query: string; proposedChange: CreateScenarioInput['proposedChange'] },
): Promise<{
  result: ReturnType<typeof simulate>;
  weightsGeneration: number | null;
  weights: Weights;
}> {
  const db = getDb();

  // Baseline features. Three fallbacks:
  //   1. page_features row (the happy path)
  //   2. derive from pages.main_content (degraded extraction)
  //   3. emptyFeatureVec — score will be 0 for everything; UI shows
  //      "feature extraction needed" warning.
  const [feat] = await db
    .select()
    .from(pageFeatures)
    .where(
      and(
        eq(pageFeatures.firm_id, firmId),
        eq(pageFeatures.url, input.baselineUrl),
      ),
    )
    .limit(1);
  let baselineFeatures: FeatureVec;
  if (feat) {
    baselineFeatures = feat.features as unknown as FeatureVec;
  } else {
    const [pageRow] = await db
      .select()
      .from(pages)
      .where(and(eq(pages.firm_id, firmId), eq(pages.url, input.baselineUrl)))
      .limit(1);
    if (pageRow?.main_content) {
      const days = pageRow.fetched_at
        ? Math.max(
            0,
            (Date.now() - new Date(pageRow.fetched_at).getTime()) / 86400_000,
          )
        : undefined;
      baselineFeatures = extractFeaturesFromMainContent(pageRow.main_content, {
        url: pageRow.url,
        query: input.query,
        freshnessDays: days,
      });
    } else {
      baselineFeatures = emptyFeatureVec();
    }
  }

  // Competitors: use the most recent SERP for the query, MINUS the firm's
  // own row (we don't want to compare the baseline against itself).
  const [snap] = await db
    .select()
    .from(serpSnapshots)
    .where(
      and(eq(serpSnapshots.firm_id, firmId), eq(serpSnapshots.query, input.query)),
    )
    .orderBy(desc(serpSnapshots.fetched_at))
    .limit(1);

  let competitors: { url: string; features: FeatureVec; observedPosition?: number }[] = [];
  if (snap) {
    const compRows = await db
      .select()
      .from(serpResults)
      .where(eq(serpResults.snapshot_id, snap.id));
    const compUrls = compRows
      .map((r) => r.url)
      .filter((u) => u !== input.baselineUrl);
    if (compUrls.length > 0) {
      const compFeats = await db
        .select()
        .from(pageFeatures)
        .where(
          and(
            eq(pageFeatures.firm_id, firmId),
            inArray(pageFeatures.url, compUrls),
          ),
        );
      const featByUrl = new Map<string, FeatureVec>(
        compFeats.map((f) => [f.url, f.features as unknown as FeatureVec]),
      );
      // For competitor URLs without features, we use an empty vector. They
      // score 0 across the board — overestimates baseline rank lift but
      // doesn't fabricate data. Surfaced in confidence label downstream.
      competitors = compRows
        .filter((r) => r.url !== input.baselineUrl)
        .map((r) => ({
          url: r.url,
          features: featByUrl.get(r.url) ?? emptyFeatureVec(),
          observedPosition: r.position,
        }));
    }
  }

  // Weights. If never trained, simulate runs with empty weights → score=0
  // for everything → Δscore=0. UI shows the no_calibration warning.
  const w = await getLatestWeights(firmId);
  const weights: Weights = w?.weights ?? {};

  const result = simulate({
    baselineUrl: input.baselineUrl,
    baselineFeatures,
    proposedChange: input.proposedChange,
    weights,
    weightsGeneration: w?.generation,
    competitors,
  });

  return { result, weightsGeneration: w?.generation ?? null, weights };
}

export async function createScenario(
  firmSlug: string,
  input: CreateScenarioInput,
): Promise<{ id: string }> {
  if (!input.name.trim()) throw new Error('Scenario name is required');
  if (!input.baselineUrl.trim()) throw new Error('Baseline URL is required');
  if (!input.query.trim()) throw new Error('Query is required');
  if (!input.proposedChange || Object.keys(input.proposedChange).length === 0) {
    throw new Error('Proposed change is empty — pick at least one feature to modify');
  }

  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);
  const { result, weightsGeneration } = await simulateForFirm(firmId, input);

  const [row] = await db
    .insert(scenarios)
    .values({
      firm_id: firmId,
      name: input.name,
      baseline_url: input.baselineUrl,
      query: input.query,
      description: input.description ?? null,
      proposed_change: input.proposedChange,
      baseline_score: result.baselineScore,
      proposed_score: result.proposedScore,
      delta_score: result.deltaScore,
      baseline_rank: result.baselineRank ?? null,
      proposed_rank: result.proposedRank ?? null,
      delta_rank: result.deltaRank ?? null,
      competitor_count: result.competitorCount,
      weights_generation_used: weightsGeneration,
      confidence_label: result.confidenceLabel,
    })
    .returning({ id: scenarios.id });

  revalidatePath(`/dashboard/${firmSlug}/scenarios`);
  return { id: row!.id };
}

export async function recomputeScenario(
  firmSlug: string,
  scenarioId: string,
): Promise<{ id: string; deltaRank: number | null; deltaScore: number }> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);
  const [row] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), eq(scenarios.firm_id, firmId)))
    .limit(1);
  if (!row) throw new Error('Scenario not found');

  const { result, weightsGeneration } = await simulateForFirm(firmId, {
    baselineUrl: row.baseline_url,
    query: row.query,
    proposedChange: row.proposed_change as Record<string, string | number | boolean>,
  });

  await db
    .update(scenarios)
    .set({
      baseline_score: result.baselineScore,
      proposed_score: result.proposedScore,
      delta_score: result.deltaScore,
      baseline_rank: result.baselineRank ?? null,
      proposed_rank: result.proposedRank ?? null,
      delta_rank: result.deltaRank ?? null,
      competitor_count: result.competitorCount,
      weights_generation_used: weightsGeneration,
      confidence_label: result.confidenceLabel,
      recomputed_at: new Date(),
    })
    .where(eq(scenarios.id, scenarioId));

  revalidatePath(`/dashboard/${firmSlug}/scenarios`);
  return {
    id: scenarioId,
    deltaRank: result.deltaRank ?? null,
    deltaScore: result.deltaScore,
  };
}

export async function deleteScenario(
  firmSlug: string,
  scenarioId: string,
): Promise<{ ok: true }> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);
  await db
    .delete(scenarios)
    .where(and(eq(scenarios.id, scenarioId), eq(scenarios.firm_id, firmId)));
  revalidatePath(`/dashboard/${firmSlug}/scenarios`);
  return { ok: true };
}

// ── Helpers exposed to the UI for "preview" before save ────

export interface ScenarioPreviewInput {
  baselineUrl: string;
  query: string;
  proposedChange: Record<string, string | number | boolean>;
}

export async function previewScenario(
  firmSlug: string,
  input: ScenarioPreviewInput,
): Promise<{
  baselineScore: number;
  proposedScore: number;
  deltaScore: number;
  baselineRank: number | null;
  proposedRank: number | null;
  deltaRank: number | null;
  competitorCount: number;
  confidenceLabel: ConfidenceLabel;
  topContributingFeatures: Array<{ feature: string; delta: number; contribution: number }>;
}> {
  const firmId = await resolveFirmId(firmSlug);
  const { result } = await simulateForFirm(firmId, input);
  return {
    baselineScore: result.baselineScore,
    proposedScore: result.proposedScore,
    deltaScore: result.deltaScore,
    baselineRank: result.baselineRank,
    proposedRank: result.proposedRank,
    deltaRank: result.deltaRank,
    competitorCount: result.competitorCount,
    confidenceLabel: result.confidenceLabel,
    topContributingFeatures: result.topContributingFeatures.map((c) => ({
      feature: c.feature as string,
      delta: c.delta,
      contribution: c.contribution,
    })),
  };
}

/** All pages we have features for, surfaced as the picker source. */
export async function listPagesWithFeatures(
  firmSlug: string,
): Promise<Array<{ url: string; title: string | null; wordCount: number | null }>> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);
  // Pull features then resolve titles via a second lookup. Keeps the
  // query plan obvious and matches the codebase's drizzle-only style.
  const feats = await db
    .select({
      url: pageFeatures.url,
      pageId: pageFeatures.page_id,
    })
    .from(pageFeatures)
    .where(eq(pageFeatures.firm_id, firmId));
  if (feats.length === 0) return [];
  const pageIds = feats
    .map((f) => f.pageId)
    .filter((id): id is string => id != null);
  const pageRows = pageIds.length
    ? await db
        .select({
          id: pages.id,
          title: pages.title,
          wordCount: pages.word_count,
        })
        .from(pages)
        .where(inArray(pages.id, pageIds))
    : [];
  const byId = new Map(pageRows.map((p) => [p.id, p]));
  return feats
    .map((f) => {
      const p = f.pageId ? byId.get(f.pageId) : undefined;
      return {
        url: f.url,
        title: p?.title ?? null,
        wordCount: p?.wordCount ?? null,
      };
    })
    .sort((a, b) => {
      const ta = a.title ?? '￿';
      const tb = b.title ?? '￿';
      if (ta !== tb) return ta.localeCompare(tb);
      return a.url.localeCompare(b.url);
    });
}
