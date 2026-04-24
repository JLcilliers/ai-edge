'use server';

import {
  getDb,
  firms,
  auditRuns,
  queries as queriesTable,
  consensusResponses,
  citations,
  citationDiffs,
  alignmentScores,
  competitors,
  competitorMentions,
} from '@ai-edge/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

// ─── Shared helpers ─────────────────────────────────────────
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
 * Completed-audit predicate. `completed_budget_truncated` still carries
 * useful signal — the queries that did execute produced real citations and
 * mention counts — so visibility aggregations count them as valid runs.
 */
const COMPLETED_STATUSES = ['completed', 'completed_budget_truncated'] as const;

/**
 * Audit kinds that represent "the actual workload" for visibility purposes.
 * `citation-diff` heartbeat rows carry no queries/citations and must be
 * filtered out — otherwise they pollute "last audit" lookups.
 */
const SCORING_AUDIT_KINDS = ['full', 'daily-priority'] as const;

// ─── Share of Voice (§5.2) ──────────────────────────────────
export type ShareOfVoiceEntity = {
  /** 'self' for the firm itself, or competitor UUID. */
  id: string;
  /** Display label — firm name or competitor name. */
  name: string;
  /** Whether this is the firm itself. */
  isSelf: boolean;
  /** Total mentions across the window. */
  mentions: number;
  /** Percentage of total mentions (0–100). */
  sharePct: number;
};

export type ShareOfVoiceResult = {
  /** Totals across the window used for pct calc. */
  totalMentions: number;
  /** Window description (latest N runs or date range). */
  windowDescription: string;
  entities: ShareOfVoiceEntity[];
};

/**
 * Share-of-voice across the most recent N completed audit runs.
 *
 * "Self" mentions = count of `consensus_responses.mentioned = true` joined
 *   via queries to recent audit_runs.
 * Competitor mentions = count of `competitor_mentions` joined via queries.
 *
 * Both use the same query set, so the denominator is consistent. Percentage
 * is each entity's share of the union.
 */
export async function getShareOfVoice(
  firmSlug: string,
  opts: { recentRuns?: number } = {},
): Promise<ShareOfVoiceResult> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);
  const recentRuns = opts.recentRuns ?? 5;

  // Pull recent audit runs (full + daily-priority only).
  const runs = await db
    .select({ id: auditRuns.id, name: firms.name })
    .from(auditRuns)
    .innerJoin(firms, eq(firms.id, auditRuns.firm_id))
    .where(
      and(
        eq(auditRuns.firm_id, firmId),
        inArray(auditRuns.status, [...COMPLETED_STATUSES]),
        inArray(auditRuns.kind, [...SCORING_AUDIT_KINDS]),
      ),
    )
    .orderBy(desc(auditRuns.started_at))
    .limit(recentRuns);

  const windowDescription =
    runs.length === 0
      ? 'no completed runs yet'
      : runs.length < recentRuns
        ? `last ${runs.length} run${runs.length === 1 ? '' : 's'}`
        : `last ${recentRuns} runs`;

  if (runs.length === 0) {
    return { totalMentions: 0, windowDescription, entities: [] };
  }

  const runIds = runs.map((r) => r.id);
  const firmName = runs[0]?.name ?? 'Firm';

  // Queries under those runs
  const queryRows = await db
    .select({ id: queriesTable.id })
    .from(queriesTable)
    .where(inArray(queriesTable.audit_run_id, runIds));

  if (queryRows.length === 0) {
    return { totalMentions: 0, windowDescription, entities: [] };
  }
  const queryIds = queryRows.map((q) => q.id);

  // Our firm: mentioned-count on consensus rows
  const [selfRow] = await db
    .select({
      mentions: sql<number>`count(*) filter (where ${consensusResponses.mentioned})::int`,
    })
    .from(consensusResponses)
    .where(inArray(consensusResponses.query_id, queryIds));
  const selfMentions = Number(selfRow?.mentions ?? 0);

  // Competitors: aggregate competitor_mention rows scoped to this firm and
  // the queries in window
  const competitorRows = await db
    .select({
      competitor_id: competitorMentions.competitor_id,
      name: competitors.name,
      mentions: sql<number>`count(*)::int`,
    })
    .from(competitorMentions)
    .innerJoin(competitors, eq(competitors.id, competitorMentions.competitor_id))
    .where(
      and(
        eq(competitorMentions.firm_id, firmId),
        inArray(competitorMentions.query_id, queryIds),
      ),
    )
    .groupBy(competitorMentions.competitor_id, competitors.name);

  const totalMentions =
    selfMentions +
    competitorRows.reduce((sum, r) => sum + Number(r.mentions), 0);

  if (totalMentions === 0) {
    return { totalMentions, windowDescription, entities: [] };
  }

  const pct = (n: number) => Math.round((n / totalMentions) * 10000) / 100;

  const entities: ShareOfVoiceEntity[] = [
    {
      id: 'self',
      name: firmName,
      isSelf: true,
      mentions: selfMentions,
      sharePct: pct(selfMentions),
    },
    ...competitorRows.map((r) => ({
      id: r.competitor_id,
      name: r.name,
      isSelf: false,
      mentions: Number(r.mentions),
      sharePct: pct(Number(r.mentions)),
    })),
  ].sort((a, b) => b.mentions - a.mentions);

  return { totalMentions, windowDescription, entities };
}

// ─── Citation Source Graph (§5.2) ───────────────────────────
export type CitationSourceRow = {
  domain: string;
  /** Total citations across the window. */
  total: number;
  /** Unique queries this domain was cited on. */
  uniqueQueries: number;
  /** Most recent audit_run this domain appeared in. */
  lastSeenAt: Date | null;
};

export type CitationSourceGraph = {
  windowDescription: string;
  rows: CitationSourceRow[];
};

/**
 * Domains LLMs cite when describing the firm — the "source-origin graph"
 * from PLAN §5.2. Ranked by total citation count across the most recent N
 * completed audit runs. Surfaces which domains the LLM trusts as sources
 * for this firm's narrative → prioritize those for link/PR effort.
 */
export async function getCitationSourceGraph(
  firmSlug: string,
  opts: { recentRuns?: number; limit?: number } = {},
): Promise<CitationSourceGraph> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);
  const recentRuns = opts.recentRuns ?? 5;
  const limit = opts.limit ?? 50;

  const runs = await db
    .select({ id: auditRuns.id, started_at: auditRuns.started_at })
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.firm_id, firmId),
        inArray(auditRuns.status, [...COMPLETED_STATUSES]),
        inArray(auditRuns.kind, [...SCORING_AUDIT_KINDS]),
      ),
    )
    .orderBy(desc(auditRuns.started_at))
    .limit(recentRuns);

  const windowDescription =
    runs.length === 0
      ? 'no completed runs yet'
      : runs.length < recentRuns
        ? `last ${runs.length} run${runs.length === 1 ? '' : 's'}`
        : `last ${recentRuns} runs`;

  if (runs.length === 0) return { windowDescription, rows: [] };

  const runIds = runs.map((r) => r.id);

  // Walk audit_run → query → consensus → citation and aggregate.
  const rows = await db
    .select({
      domain: citations.domain,
      total: sql<number>`count(*)::int`,
      uniqueQueries: sql<number>`count(distinct ${queriesTable.id})::int`,
      lastRunStartedAt: sql<Date>`max(${auditRuns.started_at})`,
    })
    .from(citations)
    .innerJoin(
      consensusResponses,
      eq(consensusResponses.id, citations.consensus_response_id),
    )
    .innerJoin(queriesTable, eq(queriesTable.id, consensusResponses.query_id))
    .innerJoin(auditRuns, eq(auditRuns.id, queriesTable.audit_run_id))
    .where(inArray(auditRuns.id, runIds))
    .groupBy(citations.domain)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return {
    windowDescription,
    rows: rows.map((r) => ({
      domain: r.domain,
      total: Number(r.total),
      uniqueQueries: Number(r.uniqueQueries),
      lastSeenAt: r.lastRunStartedAt ? new Date(r.lastRunStartedAt) : null,
    })),
  };
}

// ─── Citation Drift (§5.2) ──────────────────────────────────
export type CitationDriftRow = {
  id: string;
  latestRunId: string;
  previousRunId: string;
  gained: string[];
  lost: string[];
  gainedCount: number;
  lostCount: number;
  detectedAt: Date;
};

/**
 * Most recent N citation-drift rows for a firm, newest first. Populated by
 * the nightly citation-diff cron.
 */
export async function getCitationDriftHistory(
  firmSlug: string,
  opts: { limit?: number } = {},
): Promise<CitationDriftRow[]> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);
  const limit = opts.limit ?? 10;

  const rows = await db
    .select({
      id: citationDiffs.id,
      latestRunId: citationDiffs.latest_run_id,
      previousRunId: citationDiffs.previous_run_id,
      gained: citationDiffs.gained,
      lost: citationDiffs.lost,
      gainedCount: citationDiffs.gained_count,
      lostCount: citationDiffs.lost_count,
      detectedAt: citationDiffs.detected_at,
    })
    .from(citationDiffs)
    .where(eq(citationDiffs.firm_id, firmId))
    .orderBy(desc(citationDiffs.detected_at))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    latestRunId: r.latestRunId,
    previousRunId: r.previousRunId,
    gained: (r.gained ?? []) as string[],
    lost: (r.lost ?? []) as string[],
    gainedCount: r.gainedCount,
    lostCount: r.lostCount,
    detectedAt: r.detectedAt,
  }));
}

// ─── Alignment Gap Regression Alert (§6) ────────────────────
export type AlignmentRegression = {
  /** Latest completed 'full' or 'daily-priority' audit run. */
  latestRunId: string | null;
  latestRunStartedAt: Date | null;
  latestRedPct: number;
  latestYellowPct: number;
  latestGreenPct: number;
  /** Previous completed audit run of same kind (for like-for-like comparison). */
  previousRunId: string | null;
  previousRunStartedAt: Date | null;
  previousRedPct: number;
  /** Delta in percentage points (latest - previous). Positive = regression. */
  redDeltaPp: number;
  /**
   * Severity bucket:
   *  - 'critical': red rose by ≥10pp
   *  - 'warning':  red rose by ≥5pp
   *  - 'stable':   red moved less than 5pp in either direction
   *  - 'improving': red fell by ≥5pp
   *  - 'insufficient_data': fewer than 2 runs, or total results = 0
   */
  severity: 'critical' | 'warning' | 'stable' | 'improving' | 'insufficient_data';
};

/**
 * Compare the two most recent completed audit runs (full or daily-priority)
 * for red-label movement. Surfaces an operator-visible regression alert on
 * the firm overview page.
 *
 * Matching `kind` isn't enforced — a daily-priority run's red% is still
 * comparable to a full run's red% because both use the same scoring rubric.
 */
export async function getAlignmentRegression(
  firmSlug: string,
): Promise<AlignmentRegression> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  const runs = await db
    .select({
      id: auditRuns.id,
      started_at: auditRuns.started_at,
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
    .limit(2);

  const empty = {
    latestRunId: null,
    latestRunStartedAt: null,
    latestRedPct: 0,
    latestYellowPct: 0,
    latestGreenPct: 0,
    previousRunId: null,
    previousRunStartedAt: null,
    previousRedPct: 0,
    redDeltaPp: 0,
    severity: 'insufficient_data' as const,
  };

  if (runs.length === 0) return empty;

  const latestRagPcts = await getRunRagPcts(db, runs[0]!.id);
  if (latestRagPcts.total === 0) {
    return {
      ...empty,
      latestRunId: runs[0]!.id,
      latestRunStartedAt: runs[0]!.started_at,
    };
  }

  if (runs.length === 1) {
    return {
      latestRunId: runs[0]!.id,
      latestRunStartedAt: runs[0]!.started_at,
      latestRedPct: latestRagPcts.redPct,
      latestYellowPct: latestRagPcts.yellowPct,
      latestGreenPct: latestRagPcts.greenPct,
      previousRunId: null,
      previousRunStartedAt: null,
      previousRedPct: 0,
      redDeltaPp: 0,
      severity: 'insufficient_data',
    };
  }

  const previousRagPcts = await getRunRagPcts(db, runs[1]!.id);
  if (previousRagPcts.total === 0) {
    return {
      latestRunId: runs[0]!.id,
      latestRunStartedAt: runs[0]!.started_at,
      latestRedPct: latestRagPcts.redPct,
      latestYellowPct: latestRagPcts.yellowPct,
      latestGreenPct: latestRagPcts.greenPct,
      previousRunId: runs[1]!.id,
      previousRunStartedAt: runs[1]!.started_at,
      previousRedPct: 0,
      redDeltaPp: 0,
      severity: 'insufficient_data',
    };
  }

  const delta = latestRagPcts.redPct - previousRagPcts.redPct;
  const severity: AlignmentRegression['severity'] =
    delta >= 10 ? 'critical' : delta >= 5 ? 'warning' : delta <= -5 ? 'improving' : 'stable';

  return {
    latestRunId: runs[0]!.id,
    latestRunStartedAt: runs[0]!.started_at,
    latestRedPct: latestRagPcts.redPct,
    latestYellowPct: latestRagPcts.yellowPct,
    latestGreenPct: latestRagPcts.greenPct,
    previousRunId: runs[1]!.id,
    previousRunStartedAt: runs[1]!.started_at,
    previousRedPct: previousRagPcts.redPct,
    redDeltaPp: Math.round(delta * 100) / 100,
    severity,
  };
}

async function getRunRagPcts(
  db: ReturnType<typeof getDb>,
  auditRunId: string,
): Promise<{ total: number; redPct: number; yellowPct: number; greenPct: number }> {
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
    .where(eq(queriesTable.audit_run_id, auditRunId));

  const total = Number(row?.total ?? 0);
  if (total === 0) return { total: 0, redPct: 0, yellowPct: 0, greenPct: 0 };

  const pct = (n: number) => Math.round((Number(n) / total) * 10000) / 100;
  return {
    total,
    redPct: pct(Number(row?.red ?? 0)),
    yellowPct: pct(Number(row?.yellow ?? 0)),
    greenPct: pct(Number(row?.green ?? 0)),
  };
}
