/**
 * Monthly report payload builder.
 *
 * Aggregates a firm's full data footprint for a given calendar month:
 *   • audit runs (full + daily-priority + competitive) with RAG roll-up
 *   • reddit scan stats + top mentions
 *   • competitor mention share of voice
 *   • suppression findings + open remediation tickets
 *   • entity signal divergences
 *   • LLM cost breakdown by provider
 *
 * Shape is stable and versioned (`payload_version`) so downstream
 * consumers — the dashboard panel, the Blob JSON download, and any
 * future "Aidan asks an AI to summarize the month" feature — can
 * deserialize it safely.
 *
 * UTC is the canonical timezone. A "month" is [YYYY-MM-01T00:00:00Z,
 * next-month-01T00:00:00Z) — any audit or mention with started_at /
 * posted_at / detected_at in that window counts.
 */

import {
  getDb,
  auditRuns,
  queries as queriesTable,
  consensusResponses,
  alignmentScores,
  citations as citationsTable,
  modelResponses,
  redditMentions,
  competitorMentions,
  competitors,
  legacyFindings,
  pages,
  remediationTickets,
  entitySignals,
} from '@ai-edge/db';
import { and, eq, gte, lt, desc, sql } from 'drizzle-orm';

export const REPORT_PAYLOAD_VERSION = 1 as const;

export type MonthlyReportPayload = {
  payload_version: typeof REPORT_PAYLOAD_VERSION;
  firm_id: string;
  month_key: string; // 'YYYY-MM'
  window: { start: string; end: string }; // ISO UTC
  generated_at: string; // ISO UTC

  audits: {
    total: number;
    by_kind: Record<string, number>;
    rag_totals: { red: number; yellow: number; green: number };
    mention_rate: number; // 0..1, share of consensus_responses with mentioned=true
    avg_tone_1_10: number | null;
    total_cost_usd: number;
    runs: Array<{
      id: string;
      kind: string;
      status: string;
      started_at: string | null;
      finished_at: string | null;
      cost_usd: number;
      rag: { red: number; yellow: number; green: number };
    }>;
  };

  reddit: {
    total_mentions: number;
    by_sentiment: Record<string, number>;
    top_mentions: Array<{
      subreddit: string;
      url: string;
      sentiment: string | null;
      karma: number | null;
      posted_at: string | null;
      excerpt: string;
    }>;
  };

  competitive: {
    total_mentions: number;
    by_competitor: Array<{
      competitor_id: string;
      name: string;
      mention_count: number;
      avg_share: number | null;
      praise_count: number;
    }>;
  };

  suppression: {
    new_findings: number;
    by_action: Record<string, number>;
    open_tickets_at_end: number;
  };

  entity: {
    new_signals: number;
    divergence_count: number;
    by_source: Record<string, number>;
  };

  cost: {
    total_usd: number;
    by_provider: Record<string, number>;
  };
};

export type BuildContext = {
  firmId: string;
  /** YYYY-MM in UTC. */
  monthKey: string;
};

/** Parse 'YYYY-MM' → inclusive start / exclusive end as ISO UTC strings. */
export function monthWindow(monthKey: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) throw new Error(`Invalid month_key (expected YYYY-MM): ${monthKey}`);
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)); // auto-rolls Dec→Jan
  return { start, end };
}

/**
 * Build the full payload. Callers (cron route, manual rebuild action)
 * decide whether to persist it to the `monthly_report` table, write it
 * to Vercel Blob, or both.
 */
export async function buildMonthlyReport(
  ctx: BuildContext,
): Promise<MonthlyReportPayload> {
  const db = getDb();
  const { firmId, monthKey } = ctx;
  const { start, end } = monthWindow(monthKey);

  // ── Audits ───────────────────────────────────────────────────
  const runs = await db
    .select({
      id: auditRuns.id,
      kind: auditRuns.kind,
      status: auditRuns.status,
      started_at: auditRuns.started_at,
      finished_at: auditRuns.finished_at,
      cost_usd: auditRuns.cost_usd,
    })
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.firm_id, firmId),
        gte(auditRuns.started_at, start),
        lt(auditRuns.started_at, end),
      ),
    )
    .orderBy(desc(auditRuns.started_at));

  const runRagTotals = new Map<string, { red: number; yellow: number; green: number }>();
  let ragRed = 0;
  let ragYellow = 0;
  let ragGreen = 0;
  let mentionedHits = 0;
  let consensusTotal = 0;
  let toneSum = 0;
  let toneCount = 0;
  const byProviderCost: Record<string, number> = {};

  for (const run of runs) {
    const qIds = await db
      .select({ id: queriesTable.id })
      .from(queriesTable)
      .where(eq(queriesTable.audit_run_id, run.id));

    const runRag = { red: 0, yellow: 0, green: 0 };

    for (const q of qIds) {
      // Consensus + alignment
      const crRows = await db
        .select({
          id: consensusResponses.id,
          mentioned: consensusResponses.mentioned,
        })
        .from(consensusResponses)
        .where(eq(consensusResponses.query_id, q.id));

      for (const cr of crRows) {
        consensusTotal += 1;
        if (cr.mentioned) mentionedHits += 1;
        const [score] = await db
          .select({
            rag_label: alignmentScores.rag_label,
            tone: alignmentScores.tone_1_10,
          })
          .from(alignmentScores)
          .where(eq(alignmentScores.consensus_response_id, cr.id))
          .limit(1);
        if (score) {
          if (score.rag_label === 'red') {
            ragRed += 1;
            runRag.red += 1;
          } else if (score.rag_label === 'yellow') {
            ragYellow += 1;
            runRag.yellow += 1;
          } else if (score.rag_label === 'green') {
            ragGreen += 1;
            runRag.green += 1;
          }
          if (score.tone != null) {
            toneSum += score.tone;
            toneCount += 1;
          }
        }
      }

      // Cost by provider
      const mrRows = await db
        .select({
          provider: modelResponses.provider,
          cost_usd: modelResponses.cost_usd,
        })
        .from(modelResponses)
        .where(eq(modelResponses.query_id, q.id));
      for (const mr of mrRows) {
        if (mr.cost_usd != null) {
          byProviderCost[mr.provider] =
            (byProviderCost[mr.provider] ?? 0) + mr.cost_usd;
        }
      }
    }

    runRagTotals.set(run.id, runRag);
  }

  const auditByKind: Record<string, number> = {};
  let auditCostTotal = 0;
  for (const r of runs) {
    auditByKind[r.kind] = (auditByKind[r.kind] ?? 0) + 1;
    auditCostTotal += r.cost_usd ?? 0;
  }

  // ── Reddit ───────────────────────────────────────────────────
  const redditRows = await db
    .select({
      subreddit: redditMentions.subreddit,
      sentiment: redditMentions.sentiment,
      karma: redditMentions.karma,
      text: redditMentions.text,
      url: redditMentions.url,
      posted_at: redditMentions.posted_at,
      ingested_at: redditMentions.ingested_at,
    })
    .from(redditMentions)
    .where(
      and(
        eq(redditMentions.firm_id, firmId),
        gte(redditMentions.ingested_at, start),
        lt(redditMentions.ingested_at, end),
      ),
    );
  const redditBySentiment: Record<string, number> = {};
  for (const rm of redditRows) {
    const key = rm.sentiment ?? 'unknown';
    redditBySentiment[key] = (redditBySentiment[key] ?? 0) + 1;
  }
  const redditTopMentions = [...redditRows]
    .sort((a, b) => (b.karma ?? 0) - (a.karma ?? 0))
    .slice(0, 10)
    .map((r) => ({
      subreddit: r.subreddit,
      url: r.url,
      sentiment: r.sentiment,
      karma: r.karma,
      posted_at: r.posted_at?.toISOString() ?? null,
      excerpt: (r.text ?? '').slice(0, 280),
    }));

  // ── Competitive ──────────────────────────────────────────────
  const compMentionRows = await db
    .select({
      competitor_id: competitorMentions.competitor_id,
      name: competitors.name,
      share: competitorMentions.share,
      praise_flag: competitorMentions.praise_flag,
    })
    .from(competitorMentions)
    .leftJoin(competitors, eq(competitorMentions.competitor_id, competitors.id))
    .where(
      and(
        eq(competitorMentions.firm_id, firmId),
        gte(competitorMentions.detected_at, start),
        lt(competitorMentions.detected_at, end),
      ),
    );

  const compByCompetitor = new Map<
    string,
    { name: string; count: number; shareSum: number; shareCount: number; praise: number }
  >();
  for (const cm of compMentionRows) {
    const bucket =
      compByCompetitor.get(cm.competitor_id) ??
      { name: cm.name ?? 'unknown', count: 0, shareSum: 0, shareCount: 0, praise: 0 };
    bucket.count += 1;
    if (cm.share != null) {
      bucket.shareSum += cm.share;
      bucket.shareCount += 1;
    }
    if (cm.praise_flag) bucket.praise += 1;
    compByCompetitor.set(cm.competitor_id, bucket);
  }

  // ── Suppression ──────────────────────────────────────────────
  const findings = await db
    .select({
      action: legacyFindings.action,
      detected_at: legacyFindings.detected_at,
    })
    .from(legacyFindings)
    .innerJoin(pages, eq(legacyFindings.page_id, pages.id))
    .where(
      and(
        eq(pages.firm_id, firmId),
        gte(legacyFindings.detected_at, start),
        lt(legacyFindings.detected_at, end),
      ),
    );
  const suppressionByAction: Record<string, number> = {};
  for (const f of findings) {
    suppressionByAction[f.action] = (suppressionByAction[f.action] ?? 0) + 1;
  }
  const openTicketsRows = await db
    .select({
      openTickets: sql<number>`count(*)::int`,
    })
    .from(remediationTickets)
    .where(
      and(
        eq(remediationTickets.firm_id, firmId),
        eq(remediationTickets.status, 'open'),
        lt(remediationTickets.created_at, end),
      ),
    );
  const openTickets = openTicketsRows[0]?.openTickets ?? 0;

  // ── Entity ───────────────────────────────────────────────────
  const entityRows = await db
    .select({
      source: entitySignals.source,
      divergence_flags: entitySignals.divergence_flags,
    })
    .from(entitySignals)
    .where(
      and(
        eq(entitySignals.firm_id, firmId),
        gte(entitySignals.verified_at, start),
        lt(entitySignals.verified_at, end),
      ),
    );
  const entityBySource: Record<string, number> = {};
  let divergenceCount = 0;
  for (const es of entityRows) {
    entityBySource[es.source] = (entityBySource[es.source] ?? 0) + 1;
    const flags = (es.divergence_flags ?? []) as string[];
    if (flags.length > 0) divergenceCount += 1;
  }

  // ── Compose ──────────────────────────────────────────────────
  const payload: MonthlyReportPayload = {
    payload_version: REPORT_PAYLOAD_VERSION,
    firm_id: firmId,
    month_key: monthKey,
    window: { start: start.toISOString(), end: end.toISOString() },
    generated_at: new Date().toISOString(),

    audits: {
      total: runs.length,
      by_kind: auditByKind,
      rag_totals: { red: ragRed, yellow: ragYellow, green: ragGreen },
      mention_rate: consensusTotal > 0 ? mentionedHits / consensusTotal : 0,
      avg_tone_1_10: toneCount > 0 ? toneSum / toneCount : null,
      total_cost_usd: auditCostTotal,
      runs: runs.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        started_at: r.started_at?.toISOString() ?? null,
        finished_at: r.finished_at?.toISOString() ?? null,
        cost_usd: r.cost_usd ?? 0,
        rag: runRagTotals.get(r.id) ?? { red: 0, yellow: 0, green: 0 },
      })),
    },

    reddit: {
      total_mentions: redditRows.length,
      by_sentiment: redditBySentiment,
      top_mentions: redditTopMentions,
    },

    competitive: {
      total_mentions: compMentionRows.length,
      by_competitor: [...compByCompetitor.entries()].map(([id, v]) => ({
        competitor_id: id,
        name: v.name,
        mention_count: v.count,
        avg_share: v.shareCount > 0 ? v.shareSum / v.shareCount : null,
        praise_count: v.praise,
      })),
    },

    suppression: {
      new_findings: findings.length,
      by_action: suppressionByAction,
      open_tickets_at_end: openTickets,
    },

    entity: {
      new_signals: entityRows.length,
      divergence_count: divergenceCount,
      by_source: entityBySource,
    },

    cost: {
      total_usd: auditCostTotal,
      by_provider: byProviderCost,
    },
  };

  // Mention rate uses consensus (one per provider per query), so downstream
  // dashboards can display a single "share of prompts mentioning us" figure
  // without mixing citation-level and response-level counts.
  return payload;
}

/** YYYY-MM key for the calendar month that contains `date` (UTC). */
export function monthKeyFromDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** YYYY-MM key for the previous calendar month relative to `date` (UTC). */
export function previousMonthKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return monthKeyFromDate(d);
}
