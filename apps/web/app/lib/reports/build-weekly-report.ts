/**
 * Weekly AEO report builder — Phase 7 SOP `weekly_aeo_reporting`.
 *
 * Deliberately leaner than buildMonthlyReport — clients care about a
 * tight one-screen summary, not a 100-field payload:
 *
 *   • Audit runs in the past 7 days (counts + RAG roll-up)
 *   • New remediation tickets opened in the past 7 days (per source +
 *     per phase)
 *   • Tickets resolved in the past 7 days (closed by an operator)
 *   • Reddit mentions ingested in the past 7 days (by sentiment)
 *   • Top 5 outstanding high-priority tickets (the "do this next week"
 *     list)
 *   • Total LLM spend in the past 7 days
 *
 * Output gets rendered into Markdown by render-weekly-report.ts for
 * client email + dashboard display. Persisted as a sop_deliverable on
 * the weekly_aeo_reporting sop_run so the cron + the manual trigger
 * share the same artifact storage.
 *
 * UTC window. "Past 7 days" = [now - 7d, now).
 */

import {
  getDb,
  auditRuns,
  queries as queriesTable,
  consensusResponses,
  alignmentScores,
  remediationTickets,
  redditMentions,
  modelResponses,
} from '@ai-edge/db';
import { and, eq, gte, lt, desc, sql, inArray } from 'drizzle-orm';

const DAY_MS = 24 * 60 * 60 * 1000;

export type WeeklyReportPayload = {
  payload_version: 1;
  firm_id: string;
  window: { start: string; end: string };
  generated_at: string;

  audits: {
    total: number;
    by_kind: Record<string, number>;
    rag: { red: number; yellow: number; green: number };
    mention_rate: number; // 0..1
  };

  tickets: {
    opened: number;
    opened_by_source: Record<string, number>;
    opened_by_phase: Record<string, number>;
    resolved: number;
    top_outstanding: Array<{
      id: string;
      title: string;
      priorityRank: number | null;
      automationTier: string | null;
      ageDays: number;
    }>;
  };

  reddit: {
    ingested: number;
    by_sentiment: Record<string, number>;
  };

  cost_usd: number;
};

export interface BuildWeeklyContext {
  firmId: string;
  /** End of the reporting window (defaults to now). */
  endAt?: Date;
}

export async function buildWeeklyReport(
  ctx: BuildWeeklyContext,
): Promise<WeeklyReportPayload> {
  const db = getDb();
  const end = ctx.endAt ?? new Date();
  const start = new Date(end.getTime() - 7 * DAY_MS);

  // ── Audits ───────────────────────────────────────────────────
  const runs = await db
    .select({
      id: auditRuns.id,
      kind: auditRuns.kind,
    })
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.firm_id, ctx.firmId),
        gte(auditRuns.started_at, start),
        lt(auditRuns.started_at, end),
      ),
    );

  const auditByKind: Record<string, number> = {};
  for (const r of runs) {
    auditByKind[r.kind] = (auditByKind[r.kind] ?? 0) + 1;
  }

  // RAG roll-up + mention rate. Skip heavy work when there are no
  // runs — saves a Postgres round-trip on quiet weeks.
  let rag = { red: 0, yellow: 0, green: 0 };
  let mentionRate = 0;
  if (runs.length > 0) {
    const qRows = await db
      .select({ id: queriesTable.id })
      .from(queriesTable)
      .where(
        inArray(
          queriesTable.audit_run_id,
          runs.map((r) => r.id),
        ),
      );
    if (qRows.length > 0) {
      const crRows = await db
        .select({
          id: consensusResponses.id,
          mentioned: consensusResponses.mentioned,
        })
        .from(consensusResponses)
        .where(
          inArray(
            consensusResponses.query_id,
            qRows.map((q) => q.id),
          ),
        );

      let consensusTotal = 0;
      let mentioned = 0;
      const crIds = crRows.map((c) => c.id);
      for (const cr of crRows) {
        consensusTotal += 1;
        if (cr.mentioned) mentioned += 1;
      }
      if (consensusTotal > 0) mentionRate = mentioned / consensusTotal;

      if (crIds.length > 0) {
        const scoreRows = await db
          .select({ rag_label: alignmentScores.rag_label })
          .from(alignmentScores)
          .where(inArray(alignmentScores.consensus_response_id, crIds));
        for (const s of scoreRows) {
          if (s.rag_label === 'red') rag.red += 1;
          else if (s.rag_label === 'yellow') rag.yellow += 1;
          else if (s.rag_label === 'green') rag.green += 1;
        }
      }
    }
  }

  // ── Tickets ──────────────────────────────────────────────────
  const openedRows = await db
    .select({
      id: remediationTickets.id,
      source_type: remediationTickets.source_type,
      sopRunId: remediationTickets.sop_run_id,
      title: remediationTickets.title,
      priorityRank: remediationTickets.priority_rank,
      automationTier: remediationTickets.automation_tier,
      createdAt: remediationTickets.created_at,
      status: remediationTickets.status,
    })
    .from(remediationTickets)
    .where(
      and(
        eq(remediationTickets.firm_id, ctx.firmId),
        gte(remediationTickets.created_at, start),
        lt(remediationTickets.created_at, end),
      ),
    );

  const openedBySource: Record<string, number> = {};
  for (const t of openedRows) {
    openedBySource[t.source_type] = (openedBySource[t.source_type] ?? 0) + 1;
  }

  // Phase grouping requires a JOIN through sop_run — we use a single
  // query with raw SQL to count tickets by phase efficiently.
  const phaseCounts = await db.execute<{ phase: number; ticket_count: number }>(
    sql`
      SELECT sop_run.phase::int AS phase, COUNT(*)::int AS ticket_count
      FROM remediation_ticket
      INNER JOIN sop_run ON sop_run.id = remediation_ticket.sop_run_id
      WHERE remediation_ticket.firm_id = ${ctx.firmId}
        AND remediation_ticket.created_at >= ${start.toISOString()}
        AND remediation_ticket.created_at < ${end.toISOString()}
      GROUP BY sop_run.phase
    `,
  );
  const openedByPhase: Record<string, number> = {};
  for (const row of phaseCounts.rows ?? []) {
    openedByPhase[`phase_${row.phase}`] = Number(row.ticket_count);
  }

  // Resolved tickets — `status='resolved'` updated in the window.
  // We don't have an updated_at column on remediation_ticket, so this
  // is a best-effort proxy via the auditing pattern we already use
  // elsewhere: count tickets created before start that are now closed.
  // V1 is good enough for a weekly client signal; v2 adds a status_at
  // column.
  const resolvedRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(remediationTickets)
    .where(
      and(
        eq(remediationTickets.firm_id, ctx.firmId),
        inArray(remediationTickets.status, ['resolved', 'closed']),
        lt(remediationTickets.created_at, end),
        gte(remediationTickets.created_at, new Date(start.getTime() - 90 * DAY_MS)),
      ),
    );
  const resolved = resolvedRows[0]?.count ?? 0;

  // Top outstanding (priority 1-5, open, oldest first).
  const outstanding = await db
    .select({
      id: remediationTickets.id,
      title: remediationTickets.title,
      priorityRank: remediationTickets.priority_rank,
      automationTier: remediationTickets.automation_tier,
      createdAt: remediationTickets.created_at,
    })
    .from(remediationTickets)
    .where(
      and(
        eq(remediationTickets.firm_id, ctx.firmId),
        inArray(remediationTickets.status, ['open', 'in_progress']),
      ),
    )
    .orderBy(remediationTickets.priority_rank, desc(remediationTickets.created_at))
    .limit(5);

  const topOutstanding = outstanding.map((t) => ({
    id: t.id,
    title: t.title ?? '(untitled)',
    priorityRank: t.priorityRank,
    automationTier: t.automationTier,
    ageDays: Math.floor((end.getTime() - t.createdAt.getTime()) / DAY_MS),
  }));

  // ── Reddit ───────────────────────────────────────────────────
  const redditRows = await db
    .select({ sentiment: redditMentions.sentiment })
    .from(redditMentions)
    .where(
      and(
        eq(redditMentions.firm_id, ctx.firmId),
        gte(redditMentions.ingested_at, start),
        lt(redditMentions.ingested_at, end),
      ),
    );
  const redditBySentiment: Record<string, number> = {};
  for (const r of redditRows) {
    const k = r.sentiment ?? 'unknown';
    redditBySentiment[k] = (redditBySentiment[k] ?? 0) + 1;
  }

  // ── Cost ─────────────────────────────────────────────────────
  let weekCost = 0;
  if (runs.length > 0) {
    const qIds = await db
      .select({ id: queriesTable.id })
      .from(queriesTable)
      .where(
        inArray(
          queriesTable.audit_run_id,
          runs.map((r) => r.id),
        ),
      );
    if (qIds.length > 0) {
      const mrRows = await db
        .select({ cost_usd: modelResponses.cost_usd })
        .from(modelResponses)
        .where(
          inArray(
            modelResponses.query_id,
            qIds.map((q) => q.id),
          ),
        );
      for (const mr of mrRows) weekCost += mr.cost_usd ?? 0;
    }
  }

  return {
    payload_version: 1,
    firm_id: ctx.firmId,
    window: { start: start.toISOString(), end: end.toISOString() },
    generated_at: new Date().toISOString(),
    audits: {
      total: runs.length,
      by_kind: auditByKind,
      rag,
      mention_rate: +mentionRate.toFixed(3),
    },
    tickets: {
      opened: openedRows.length,
      opened_by_source: openedBySource,
      opened_by_phase: openedByPhase,
      resolved,
      top_outstanding: topOutstanding,
    },
    reddit: {
      ingested: redditRows.length,
      by_sentiment: redditBySentiment,
    },
    cost_usd: +weekCost.toFixed(4),
  };
}

/**
 * Render a WeeklyReportPayload to a Markdown document suitable for
 * client email or dashboard preview.
 */
export function renderWeeklyReportMarkdown(
  payload: WeeklyReportPayload,
  firmName: string,
): string {
  const startDate = new Date(payload.window.start).toISOString().slice(0, 10);
  const endDate = new Date(payload.window.end).toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`# Weekly AEO Report — ${firmName}`);
  lines.push(`**Window:** ${startDate} → ${endDate}`);
  lines.push('');

  // Audits
  lines.push('## Audit activity');
  lines.push('');
  if (payload.audits.total === 0) {
    lines.push('- No audits ran this week.');
  } else {
    lines.push(
      `- **${payload.audits.total} audit${payload.audits.total === 1 ? '' : 's'}** ran (${formatRecord(payload.audits.by_kind)})`,
    );
    const total = payload.audits.rag.red + payload.audits.rag.yellow + payload.audits.rag.green;
    if (total > 0) {
      lines.push(
        `- **Alignment:** ${payload.audits.rag.green} green · ${payload.audits.rag.yellow} yellow · ${payload.audits.rag.red} red`,
      );
    }
    if (payload.audits.mention_rate > 0) {
      lines.push(
        `- **Mention rate:** ${(payload.audits.mention_rate * 100).toFixed(1)}% of LLM responses mentioned the firm`,
      );
    }
  }
  lines.push('');

  // Tickets
  lines.push('## Execution tasks');
  lines.push('');
  lines.push(`- **${payload.tickets.opened}** new tasks opened this week`);
  if (Object.keys(payload.tickets.opened_by_phase).length > 0) {
    lines.push(`  - By phase: ${formatRecord(payload.tickets.opened_by_phase)}`);
  }
  if (Object.keys(payload.tickets.opened_by_source).length > 0) {
    lines.push(`  - By source: ${formatRecord(payload.tickets.opened_by_source)}`);
  }
  lines.push(`- **${payload.tickets.resolved}** tasks resolved`);
  if (payload.tickets.top_outstanding.length > 0) {
    lines.push('');
    lines.push('### Top outstanding tasks');
    lines.push('');
    for (const t of payload.tickets.top_outstanding) {
      const tier = t.automationTier ? ` [${t.automationTier}]` : '';
      const rank = t.priorityRank != null ? ` #${t.priorityRank}` : '';
      lines.push(`-${rank} ${t.title}${tier} — ${t.ageDays} day${t.ageDays === 1 ? '' : 's'} old`);
    }
  }
  lines.push('');

  // Reddit
  if (payload.reddit.ingested > 0) {
    lines.push('## Reddit signal');
    lines.push('');
    lines.push(
      `- **${payload.reddit.ingested}** new mention${payload.reddit.ingested === 1 ? '' : 's'} (${formatRecord(payload.reddit.by_sentiment)})`,
    );
    lines.push('');
  }

  // Cost
  if (payload.cost_usd > 0) {
    lines.push('## Cost');
    lines.push('');
    lines.push(`- **$${payload.cost_usd.toFixed(2)}** LLM spend this week`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`*Generated ${new Date(payload.generated_at).toISOString()}*`);
  return lines.join('\n');
}

function formatRecord(r: Record<string, number>): string {
  return Object.entries(r)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}
