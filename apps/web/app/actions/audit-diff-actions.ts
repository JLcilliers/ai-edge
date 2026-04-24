'use server';

import {
  getDb,
  firms,
  auditRuns,
  queries as queriesTable,
  modelResponses,
  consensusResponses,
  alignmentScores,
} from '@ai-edge/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

/**
 * audit-diff-actions: server actions for comparing audit runs and charting
 * alignment over time.
 *
 * Why this lives next to audit-actions.ts instead of inside it:
 *  - audit-actions is the "one audit" surface (start, list, detail, csv).
 *  - diffing + trending are "between audits" — a different mental model. Keeping
 *    them separate keeps the query shapes smaller and lets callers import only
 *    what they need.
 *
 * All readers treat both `completed` and `completed_budget_truncated` as valid
 * sources — a budget-truncated run still produced real scored rows, so we'd
 * rather show partial data than hide a regression behind an opaque "no data"
 * state.
 *
 * Movement taxonomy (per query × provider):
 *  - regressed: label dropped a rank (green→yellow/red, yellow→red)
 *  - improved:  label rose a rank (red→yellow/green, yellow→green)
 *  - stable:    same label on both runs
 *  - new:       appears only on the latest run (new seed query added)
 *  - dropped:   appears only on the previous run (query removed from the seed set)
 *
 * Matching is on the pair (queryText, provider) because the same query can be
 * fanned out to OpenAI + Anthropic + Gemini + Perplexity and each needs to be
 * tracked independently — a query might regress on one provider but not another.
 */

// ─── Shared helpers (mirrors visibility-actions.ts) ─────────

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

const COMPLETED_STATUSES = ['completed', 'completed_budget_truncated'] as const;
const SCORING_AUDIT_KINDS = ['full', 'daily-priority'] as const;

// ─── Alignment Trend (overview sparkline) ───────────────────

export type AlignmentTrendPoint = {
  runId: string;
  startedAt: Date | null;
  kind: string;
  total: number;
  redPct: number;
  yellowPct: number;
  greenPct: number;
};

/**
 * Last N completed scoring runs in chronological order (oldest first, newest
 * last) for charting. Returned oldest-first so the caller can render left-to-
 * right without re-sorting.
 *
 * Default limit=10; callers pass smaller for tight sparklines.
 */
export async function getAlignmentTrend(
  firmSlug: string,
  opts: { limit?: number } = {},
): Promise<AlignmentTrendPoint[]> {
  const { limit = 10 } = opts;
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  // Pull runs newest-first so we can LIMIT efficiently, then reverse for display.
  const runs = await db
    .select({
      id: auditRuns.id,
      startedAt: auditRuns.started_at,
      kind: auditRuns.kind,
    })
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.firm_id, firmId),
        inArray(auditRuns.status, [...COMPLETED_STATUSES]),
        inArray(auditRuns.kind, [...SCORING_AUDIT_KINDS]),
      ),
    )
    .orderBy(desc(auditRuns.started_at))
    .limit(limit);

  if (runs.length === 0) return [];

  // Fetch per-run RAG pcts in parallel — each is one small SQL round-trip.
  const pcts = await Promise.all(
    runs.map(async (r) => {
      const [row] = await db
        .select({
          total: sql<number>`count(*)::int`,
          red: sql<number>`count(*) filter (where ${alignmentScores.rag_label} = 'red')::int`,
          yellow: sql<number>`count(*) filter (where ${alignmentScores.rag_label} = 'yellow')::int`,
          green: sql<number>`count(*) filter (where ${alignmentScores.rag_label} = 'green')::int`,
        })
        .from(alignmentScores)
        .innerJoin(
          consensusResponses,
          eq(consensusResponses.id, alignmentScores.consensus_response_id),
        )
        .innerJoin(queriesTable, eq(queriesTable.id, consensusResponses.query_id))
        .where(eq(queriesTable.audit_run_id, r.id));
      const total = Number(row?.total ?? 0);
      const pct = (n: number) =>
        total === 0 ? 0 : Math.round((Number(n) / total) * 10000) / 100;
      return {
        runId: r.id,
        startedAt: r.startedAt,
        kind: r.kind,
        total,
        redPct: pct(Number(row?.red ?? 0)),
        yellowPct: pct(Number(row?.yellow ?? 0)),
        greenPct: pct(Number(row?.green ?? 0)),
      };
    }),
  );

  // Oldest-first for chart rendering.
  return pcts.reverse();
}

// ─── Diff (latest vs comparison run) ────────────────────────

export type RagLabel = 'red' | 'yellow' | 'green';
export type Movement = 'regressed' | 'improved' | 'stable' | 'new' | 'dropped';

export type AuditDiffRow = {
  queryText: string;
  provider: string;
  previousLabel: RagLabel | null;
  latestLabel: RagLabel | null;
  previousToneScore: number | null;
  latestToneScore: number | null;
  previousGapReasons: string[];
  latestGapReasons: string[];
  movement: Movement;
};

export type AuditDiffSummary = {
  regressed: number;
  improved: number;
  stable: number;
  new: number;
  dropped: number;
  /** Total rows in the diff (sum of above). */
  total: number;
};

export type AuditDiffContext = {
  runId: string;
  startedAt: Date | null;
  kind: string | null;
  status: string | null;
  redPct: number;
  yellowPct: number;
  greenPct: number;
  total: number;
};

export type AuditDiff = {
  latest: AuditDiffContext;
  previous: AuditDiffContext | null;
  rows: AuditDiffRow[];
  summary: AuditDiffSummary;
};

/**
 * Walk queries → model_responses → consensus_responses → alignment_scores
 * for one run and flatten into a `(queryText, provider) → { label, tone,
 * gapReasons }` map. Uses a single join-query instead of N+1.
 *
 * Model responses carry provider; consensus responses join 1:1 with a model
 * response via `(query_id, provider)` in practice (the scoring pipeline writes
 * one consensus row per provider per query). We match on query_id+provider to
 * stay robust even if the pipeline ever changes its insertion order.
 */
async function getLabeledRowsForRun(
  db: ReturnType<typeof getDb>,
  auditRunId: string,
): Promise<
  Map<
    string, // `${queryText}|${provider}`
    {
      queryText: string;
      provider: string;
      label: RagLabel;
      toneScore: number | null;
      gapReasons: string[];
    }
  >
> {
  // One join pulls everything per (query, provider). We select provider from
  // model_responses because consensus_responses doesn't carry it directly.
  const rows = await db
    .select({
      queryText: queriesTable.text,
      provider: modelResponses.provider,
      label: alignmentScores.rag_label,
      tone: alignmentScores.tone_1_10,
      gapReasons: alignmentScores.gap_reasons,
      queryId: queriesTable.id,
      consensusId: consensusResponses.id,
    })
    .from(queriesTable)
    .innerJoin(
      modelResponses,
      eq(modelResponses.query_id, queriesTable.id),
    )
    .innerJoin(
      consensusResponses,
      eq(consensusResponses.query_id, queriesTable.id),
    )
    .innerJoin(
      alignmentScores,
      eq(alignmentScores.consensus_response_id, consensusResponses.id),
    )
    .where(eq(queriesTable.audit_run_id, auditRunId));

  const map = new Map<
    string,
    {
      queryText: string;
      provider: string;
      label: RagLabel;
      toneScore: number | null;
      gapReasons: string[];
    }
  >();

  // The join above can produce duplicate (query, provider) rows because
  // model_responses and consensus_responses can each have multiple rows per
  // query (k=3 self-consistency + one consensus per provider). We de-dupe by
  // taking the row with the highest `consensusId` wins — which is the latest
  // consensus write for that pair and therefore the one the UI expects.
  const latestConsensusByKey = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.queryText}|${r.provider}`;
    const prevConsensus = latestConsensusByKey.get(key);
    if (!prevConsensus || r.consensusId > prevConsensus) {
      latestConsensusByKey.set(key, r.consensusId);
      map.set(key, {
        queryText: r.queryText,
        provider: r.provider,
        label: (r.label as RagLabel) ?? 'red',
        toneScore: r.tone ?? null,
        gapReasons: (r.gapReasons as string[] | null) ?? [],
      });
    }
  }

  return map;
}

async function getRunContext(
  db: ReturnType<typeof getDb>,
  auditRunId: string,
): Promise<AuditDiffContext> {
  const [run] = await db
    .select({
      id: auditRuns.id,
      startedAt: auditRuns.started_at,
      kind: auditRuns.kind,
      status: auditRuns.status,
    })
    .from(auditRuns)
    .where(eq(auditRuns.id, auditRunId))
    .limit(1);

  const [ragRow] = await db
    .select({
      total: sql<number>`count(*)::int`,
      red: sql<number>`count(*) filter (where ${alignmentScores.rag_label} = 'red')::int`,
      yellow: sql<number>`count(*) filter (where ${alignmentScores.rag_label} = 'yellow')::int`,
      green: sql<number>`count(*) filter (where ${alignmentScores.rag_label} = 'green')::int`,
    })
    .from(alignmentScores)
    .innerJoin(
      consensusResponses,
      eq(consensusResponses.id, alignmentScores.consensus_response_id),
    )
    .innerJoin(queriesTable, eq(queriesTable.id, consensusResponses.query_id))
    .where(eq(queriesTable.audit_run_id, auditRunId));

  const total = Number(ragRow?.total ?? 0);
  const pct = (n: number) =>
    total === 0 ? 0 : Math.round((Number(n) / total) * 10000) / 100;

  return {
    runId: auditRunId,
    startedAt: run?.startedAt ?? null,
    kind: run?.kind ?? null,
    status: run?.status ?? null,
    redPct: pct(Number(ragRow?.red ?? 0)),
    yellowPct: pct(Number(ragRow?.yellow ?? 0)),
    greenPct: pct(Number(ragRow?.green ?? 0)),
    total,
  };
}

/**
 * Find the previous scoring run (completed or completed_budget_truncated)
 * strictly older than the given run for the same firm. Returns null if
 * there's no earlier run — the UI shows an "insufficient data" state.
 *
 * We match on firm (not kind) because a full run's red% is comparable to a
 * daily-priority run's red% — both use the same rubric. If we filtered by
 * kind, a firm with alternating weekly full and daily priority runs would
 * see most diffs skip the interesting comparisons.
 */
async function findPreviousRunId(
  db: ReturnType<typeof getDb>,
  firmId: string,
  runId: string,
  runStartedAt: Date,
): Promise<string | null> {
  const [prev] = await db
    .select({ id: auditRuns.id })
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.firm_id, firmId),
        inArray(auditRuns.status, [...COMPLETED_STATUSES]),
        inArray(auditRuns.kind, [...SCORING_AUDIT_KINDS]),
        sql`${auditRuns.started_at} < ${runStartedAt.toISOString()}`,
        sql`${auditRuns.id} <> ${runId}`,
      ),
    )
    .orderBy(desc(auditRuns.started_at))
    .limit(1);
  return prev?.id ?? null;
}

/**
 * Diff two runs. `compareToRunId` is optional — when omitted, we auto-pick
 * the scoring run immediately preceding `latestRunId`. When provided, we
 * trust the caller — both runs must belong to the same firm (enforced by
 * the caller via URL scoping).
 */
export async function getAuditDiff(
  latestRunId: string,
  opts: { compareToRunId?: string } = {},
): Promise<AuditDiff> {
  const db = getDb();

  const latestCtx = await getRunContext(db, latestRunId);
  if (!latestCtx.startedAt) {
    throw new Error(`Audit run not found: ${latestRunId}`);
  }

  // Fetch firm_id from the latest run to scope the previous-run lookup.
  const [latestRunRow] = await db
    .select({ firmId: auditRuns.firm_id })
    .from(auditRuns)
    .where(eq(auditRuns.id, latestRunId))
    .limit(1);
  if (!latestRunRow) throw new Error(`Audit run not found: ${latestRunId}`);

  const previousRunId =
    opts.compareToRunId ??
    (await findPreviousRunId(
      db,
      latestRunRow.firmId,
      latestRunId,
      latestCtx.startedAt,
    ));

  if (!previousRunId) {
    return {
      latest: latestCtx,
      previous: null,
      rows: [],
      summary: { regressed: 0, improved: 0, stable: 0, new: 0, dropped: 0, total: 0 },
    };
  }

  const previousCtx = await getRunContext(db, previousRunId);

  const [latestMap, previousMap] = await Promise.all([
    getLabeledRowsForRun(db, latestRunId),
    getLabeledRowsForRun(db, previousRunId),
  ]);

  // Union of keys across both runs — catches new, dropped, and matched pairs.
  const keys = new Set<string>([...latestMap.keys(), ...previousMap.keys()]);

  const rank: Record<RagLabel, number> = { red: 0, yellow: 1, green: 2 };

  const rows: AuditDiffRow[] = [];
  for (const key of keys) {
    const latest = latestMap.get(key);
    const previous = previousMap.get(key);

    let movement: Movement;
    if (!previous && latest) movement = 'new';
    else if (previous && !latest) movement = 'dropped';
    else if (!previous && !latest) continue; // shouldn't happen
    else {
      const l = rank[latest!.label];
      const p = rank[previous!.label];
      movement = l > p ? 'improved' : l < p ? 'regressed' : 'stable';
    }

    // Prefer the latest row for queryText/provider display when both exist;
    // fall back to previous when the query was dropped.
    const displayRow = latest ?? previous!;
    rows.push({
      queryText: displayRow.queryText,
      provider: displayRow.provider,
      previousLabel: previous?.label ?? null,
      latestLabel: latest?.label ?? null,
      previousToneScore: previous?.toneScore ?? null,
      latestToneScore: latest?.toneScore ?? null,
      previousGapReasons: previous?.gapReasons ?? [],
      latestGapReasons: latest?.gapReasons ?? [],
      movement,
    });
  }

  // Sort: regressed first (most actionable), then improved, new, dropped, stable.
  const movementOrder: Record<Movement, number> = {
    regressed: 0,
    improved: 1,
    new: 2,
    dropped: 3,
    stable: 4,
  };
  rows.sort((a, b) => {
    const m = movementOrder[a.movement] - movementOrder[b.movement];
    if (m !== 0) return m;
    // Within same movement, stable sort by query text for determinism.
    const t = a.queryText.localeCompare(b.queryText);
    if (t !== 0) return t;
    return a.provider.localeCompare(b.provider);
  });

  const summary: AuditDiffSummary = {
    regressed: rows.filter((r) => r.movement === 'regressed').length,
    improved: rows.filter((r) => r.movement === 'improved').length,
    stable: rows.filter((r) => r.movement === 'stable').length,
    new: rows.filter((r) => r.movement === 'new').length,
    dropped: rows.filter((r) => r.movement === 'dropped').length,
    total: rows.length,
  };

  return {
    latest: latestCtx,
    previous: previousCtx,
    rows,
    summary,
  };
}

// ─── Helper exposed for the overview banner ─────────────────

/**
 * Returns the `(latestRunId, previousRunId)` pair for the firm's two most
 * recent scoring runs. Null if fewer than one completed scoring run exists;
 * previousRunId is null if exactly one exists.
 *
 * Used by the overview regression banner so it can construct a direct link
 * to the diff page without the client component having to run its own query.
 */
export async function getLatestScoringRunPair(firmSlug: string): Promise<{
  latestRunId: string | null;
  previousRunId: string | null;
}> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);
  const runs = await db
    .select({ id: auditRuns.id })
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.firm_id, firmId),
        inArray(auditRuns.status, [...COMPLETED_STATUSES]),
        inArray(auditRuns.kind, [...SCORING_AUDIT_KINDS]),
      ),
    )
    .orderBy(desc(auditRuns.started_at))
    .limit(2);

  return {
    latestRunId: runs[0]?.id ?? null,
    previousRunId: runs[1]?.id ?? null,
  };
}
