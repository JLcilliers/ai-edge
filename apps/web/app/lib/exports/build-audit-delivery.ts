/**
 * AEO Audit Delivery export — migrates the Steve Toth Audit Delivery
 * methodology into the export module.
 *
 * The original SOP had 5 steps (assemble findings → craft narrative →
 * build slide deck → present → send follow-up) intended to produce a
 * client-facing 12-15 slide deck. That workflow doesn't fit the
 * scanner-output paradigm — there's no scanner because the input is
 * already-existing ticket data. So we keep the *content* of the
 * methodology and relocate it here as a "compile this from existing
 * tickets" export.
 *
 * Output shape: Markdown document with the same structure the SOP
 * prescribes for the slide deck. The operator drops this into Google
 * Slides / Keynote / Notion and the slide structure is already laid
 * out — they just need to apply branding + present. The Markdown is
 * also valid as a leave-behind document on its own.
 *
 * Structure (Toth methodology):
 *
 *   1. Cover — Firm name + date + "AEO Discovery Audit"
 *   2. Executive Summary — 3-5 bullets across the 7 phases
 *   3. Headline Finding — the single most important issue, computed
 *      from highest-severity / highest-priority ticket
 *   4. Current State per Phase — one section per phase with ticket
 *      counts + key findings
 *   5. Priority Matrix — 2×2 of impact × effort, with example tickets
 *      in each quadrant
 *   6. Top 10 Priorities — top tickets by priority_rank
 *   7. Recommended Next Steps — sequenced action plan
 *   8. Methodology — how the audit works (so the client trusts the
 *      output)
 */

import { put } from '@vercel/blob';
import {
  getDb,
  remediationTickets,
  sopRuns,
  brandTruthVersions,
  auditRuns,
  alignmentScores,
  consensusResponses,
  queries as queriesTable,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { and, eq, inArray, desc, asc, sql } from 'drizzle-orm';
import { PHASES, SOP_REGISTRY } from '../sop/registry';

interface BuildArgs {
  firmId: string;
  firmName: string;
  generatedAt: Date;
}

export interface AuditDeliveryResult {
  filename: string;
  blobUrl: string | null;
  bytes: number;
  /** The full Markdown payload — also returned inline for immediate display. */
  markdown: string;
  headlineFinding: string;
  ticketTotal: number;
}

interface TicketRow {
  id: string;
  title: string;
  description: string | null;
  priorityRank: number | null;
  status: string;
  automationTier: 'auto' | 'assist' | 'manual' | null;
  phase: number;
  sopKey: string;
  createdAt: Date;
}

const OPEN_STATUSES = ['open', 'in_progress'] as const;

async function loadTickets(firmId: string): Promise<TicketRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: remediationTickets.id,
      title: remediationTickets.title,
      description: remediationTickets.description,
      priorityRank: remediationTickets.priority_rank,
      status: remediationTickets.status,
      automationTier: remediationTickets.automation_tier,
      phase: sopRuns.phase,
      sopKey: sopRuns.sop_key,
      createdAt: remediationTickets.created_at,
    })
    .from(remediationTickets)
    .innerJoin(sopRuns, eq(sopRuns.id, remediationTickets.sop_run_id))
    .where(
      and(
        eq(remediationTickets.firm_id, firmId),
        inArray(remediationTickets.status, [...OPEN_STATUSES]),
      ),
    )
    .orderBy(asc(remediationTickets.priority_rank), desc(remediationTickets.created_at));

  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? '(untitled)',
    description: r.description,
    priorityRank: r.priorityRank,
    status: r.status,
    automationTier: r.automationTier as TicketRow['automationTier'],
    phase: r.phase,
    sopKey: r.sopKey,
    createdAt: r.createdAt,
  }));
}

/** Latest full audit's alignment summary — for the executive summary headline. */
async function loadLatestAuditSummary(firmId: string): Promise<{
  ragRed: number;
  ragYellow: number;
  ragGreen: number;
  mentionRate: number;
  totalScored: number;
} | null> {
  const db = getDb();
  const [latest] = await db
    .select({ id: auditRuns.id })
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.firm_id, firmId),
        eq(auditRuns.kind, 'full'),
        sql`${auditRuns.status} IN ('completed', 'completed_partial', 'completed_budget_truncated')`,
      ),
    )
    .orderBy(desc(auditRuns.finished_at))
    .limit(1);
  if (!latest) return null;

  const qRows = await db
    .select({ id: queriesTable.id })
    .from(queriesTable)
    .where(eq(queriesTable.audit_run_id, latest.id));
  if (qRows.length === 0) return null;

  const crRows = await db
    .select({ id: consensusResponses.id, mentioned: consensusResponses.mentioned })
    .from(consensusResponses)
    .where(
      inArray(
        consensusResponses.query_id,
        qRows.map((q) => q.id),
      ),
    );
  if (crRows.length === 0) return null;

  let mentioned = 0;
  for (const c of crRows) if (c.mentioned) mentioned += 1;
  const mentionRate = mentioned / crRows.length;

  const scoreRows = await db
    .select({ rag_label: alignmentScores.rag_label })
    .from(alignmentScores)
    .where(
      inArray(
        alignmentScores.consensus_response_id,
        crRows.map((c) => c.id),
      ),
    );
  let ragRed = 0;
  let ragYellow = 0;
  let ragGreen = 0;
  for (const s of scoreRows) {
    if (s.rag_label === 'red') ragRed += 1;
    else if (s.rag_label === 'yellow') ragYellow += 1;
    else if (s.rag_label === 'green') ragGreen += 1;
  }
  return {
    ragRed,
    ragYellow,
    ragGreen,
    mentionRate,
    totalScored: scoreRows.length,
  };
}

async function loadBrandTruth(firmId: string): Promise<BrandTruth | null> {
  const db = getDb();
  const [bt] = await db
    .select({ payload: brandTruthVersions.payload })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  return (bt?.payload as BrandTruth | undefined) ?? null;
}

/**
 * Pick the single highest-impact finding from the ticket corpus. Heuristic:
 *   1. Prefer priority_rank = 1 from any phase, breaking ties by phase order
 *      (Phase 1 issues are foundational, Phase 7 issues are downstream).
 *   2. Fall back to "most-pages-affected" patterns when no priority_rank=1
 *      ticket exists (rare in practice — most scanners set rank from 1 up).
 */
function computeHeadlineFinding(
  tickets: TicketRow[],
  auditSummary: { ragRed: number; ragYellow: number; ragGreen: number; mentionRate: number; totalScored: number } | null,
): string {
  // Foundation-layer alignment story wins when the audit shows real misalignment.
  if (auditSummary && auditSummary.totalScored > 0) {
    const total = auditSummary.totalScored;
    const greenPct = Math.round((auditSummary.ragGreen / total) * 100);
    const redPct = Math.round((auditSummary.ragRed / total) * 100);
    if (redPct >= 30) {
      return `LLMs disagree with your positioning on ${redPct}% of audited queries (${auditSummary.ragRed} of ${total}). That's the core problem — every other optimization is downstream of fixing the misalignment surface.`;
    }
    if (greenPct < 50) {
      return `Only ${greenPct}% of LLM responses align cleanly with your Brand Truth (${auditSummary.ragGreen} of ${total} queries). Three out of four answers about your firm contain a gap, drift, or factual error that an LLM-citation strategy has to address.`;
    }
    const mentionPct = Math.round(auditSummary.mentionRate * 100);
    if (mentionPct < 50) {
      return `LLMs mention your firm in only ${mentionPct}% of relevant query responses. The biggest lift available isn't fixing what's said — it's getting the firm cited at all.`;
    }
  }

  // Fall back to ticket-pattern-based headlines.
  const phase1 = tickets.filter((t) => t.phase === 1).length;
  const phase3 = tickets.filter((t) => t.phase === 3).length;
  const phase5 = tickets.filter((t) => t.phase === 5).length;

  if (phase1 >= 10) {
    return `${phase1} foundational issues in Brand Audit + Suppression. Until those clear, no amount of new content moves the needle — LLMs are working from a poisoned baseline.`;
  }
  if (phase3 >= 15) {
    return `${phase3} pages need content-level fixes (LLM-Friendly scoring + freshness decay + positioning drift). Content quality is the bottleneck, not visibility.`;
  }
  if (phase5 >= 15) {
    return `${phase5} pages need technical fixes (semantic HTML + schema markup). LLMs can't extract structured information from your pages reliably right now.`;
  }
  if (tickets.length > 0) {
    return `${tickets.length} optimization tasks identified across all 7 phases. The execution plan is well-scoped — the question is sequencing, not discovery.`;
  }
  return 'No open tickets. Either the scanners haven\'t been run, or the site is in unusually clean shape — recommend running every phase scanner before drafting findings.';
}

/**
 * Bucket tickets into the impact × effort priority matrix.
 *
 * Impact heuristic:
 *   High = priority_rank ≤ 3 OR phase 1 (foundational) OR phase 5 (technical
 *          fixes block multiple downstream optimizations)
 *   Low  = priority_rank > 10 OR phase 4 reddit triage (single-page noise)
 *
 * Effort heuristic:
 *   Low effort  = automation_tier === 'auto' (one click) OR 'assist' with
 *                 a single page touched
 *   High effort = automation_tier === 'manual' OR multi-page rewrites
 *
 * The bucketing isn't surgical — clients use this as a discussion frame,
 * not a tracking spreadsheet. The .xlsx export carries the precise list.
 */
function bucketByPriorityMatrix(tickets: TicketRow[]): {
  highImpactLowEffort: TicketRow[];
  highImpactHighEffort: TicketRow[];
  lowImpactLowEffort: TicketRow[];
  lowImpactHighEffort: TicketRow[];
} {
  const buckets = {
    highImpactLowEffort: [] as TicketRow[],
    highImpactHighEffort: [] as TicketRow[],
    lowImpactLowEffort: [] as TicketRow[],
    lowImpactHighEffort: [] as TicketRow[],
  };
  for (const t of tickets) {
    const rank = t.priorityRank ?? 100;
    const highImpact =
      rank <= 3 || t.phase === 1 || (t.phase === 5 && rank <= 5);
    const highEffort =
      t.automationTier === 'manual' ||
      // Heuristic: multi-page rewrites (Repositioning, Trust Alignment year inconsistencies) have descriptions longer than a typical single-page fix.
      (t.description?.length ?? 0) > 600;
    if (highImpact && !highEffort) buckets.highImpactLowEffort.push(t);
    else if (highImpact && highEffort) buckets.highImpactHighEffort.push(t);
    else if (!highImpact && !highEffort) buckets.lowImpactLowEffort.push(t);
    else buckets.lowImpactHighEffort.push(t);
  }
  return buckets;
}

/** Top 3 tickets per quadrant — enough to ground the conversation. */
function bucketDigest(rows: TicketRow[]): string {
  if (rows.length === 0) return '_(empty)_';
  return rows
    .slice(0, 3)
    .map((t, i) => `${i + 1}. ${t.title}`)
    .join('\n');
}

function renderMarkdown(
  firmName: string,
  generatedAt: Date,
  tickets: TicketRow[],
  buckets: ReturnType<typeof bucketByPriorityMatrix>,
  headlineFinding: string,
  auditSummary: { ragRed: number; ragYellow: number; ragGreen: number; mentionRate: number; totalScored: number } | null,
  brandTruth: BrandTruth | null,
): string {
  const dateStr = generatedAt.toISOString().slice(0, 10);
  const ticketsByPhase = new Map<number, TicketRow[]>();
  for (const t of tickets) {
    if (!ticketsByPhase.has(t.phase)) ticketsByPhase.set(t.phase, []);
    ticketsByPhase.get(t.phase)!.push(t);
  }

  const lines: string[] = [];

  // ── Slide 1: Cover ──────────────────────────────────────────
  lines.push(`# AEO Discovery Audit`);
  lines.push(`## ${firmName}`);
  lines.push('');
  lines.push(`**Audit date:** ${dateStr}`);
  if (brandTruth) {
    const bt = brandTruth as { primary_url?: string };
    if (bt.primary_url) lines.push(`**Primary URL:** ${bt.primary_url}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Slide 2: Executive Summary ──────────────────────────────
  lines.push(`## Executive Summary`);
  lines.push('');
  const tierCounts: Record<string, number> = { auto: 0, assist: 0, manual: 0 };
  for (const t of tickets) {
    if (t.automationTier) tierCounts[t.automationTier] = (tierCounts[t.automationTier] ?? 0) + 1;
  }
  lines.push(`- **${tickets.length}** open optimization tasks identified across the 7-phase AEO methodology`);
  if (auditSummary && auditSummary.totalScored > 0) {
    const greenPct = Math.round((auditSummary.ragGreen / auditSummary.totalScored) * 100);
    const mentionPct = Math.round(auditSummary.mentionRate * 100);
    lines.push(`- LLMs align cleanly with Brand Truth on **${greenPct}%** of audited queries; the firm is mentioned in **${mentionPct}%** of relevant responses`);
  }
  lines.push(`- **${tierCounts.auto} auto** / **${tierCounts.assist} assist** / **${tierCounts.manual} manual** by execution tier — automation can carry the first two buckets directly`);
  lines.push(`- Phase distribution: ${[...ticketsByPhase.entries()].sort((a, b) => a[0] - b[0]).map(([p, list]) => `Phase ${p}: ${list.length}`).join(' · ')}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Slide 3: Headline Finding ───────────────────────────────
  lines.push(`## Headline Finding`);
  lines.push('');
  lines.push(`> ${headlineFinding}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Slides 4-10: Current State per Phase ────────────────────
  for (const phase of PHASES) {
    const phaseTickets = ticketsByPhase.get(phase.phase) ?? [];
    lines.push(`## Phase ${phase.phase} — ${phase.name}`);
    lines.push('');
    lines.push(`_${phase.description}_`);
    lines.push('');
    lines.push(`**Open tasks:** ${phaseTickets.length}`);
    if (phaseTickets.length === 0) {
      lines.push('');
      lines.push('No outstanding tasks. Either the phase scanner hasn\'t been run, or the firm is already clean on this dimension.');
    } else {
      lines.push('');
      lines.push('**Top tasks this phase:**');
      lines.push('');
      const phaseTop = [...phaseTickets]
        .sort((a, b) => (a.priorityRank ?? Infinity) - (b.priorityRank ?? Infinity))
        .slice(0, 5);
      for (const t of phaseTop) {
        const tierLabel = t.automationTier ? ` _(${t.automationTier})_` : '';
        lines.push(`- ${t.title}${tierLabel}`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // ── Slide 11: Priority Matrix ───────────────────────────────
  lines.push(`## Priority Matrix`);
  lines.push('');
  lines.push('|  | **Low effort** | **High effort** |');
  lines.push('|---|---|---|');
  lines.push(`| **High impact** | ${buckets.highImpactLowEffort.length} tasks · DO FIRST | ${buckets.highImpactHighEffort.length} tasks · PLAN |`);
  lines.push(`| **Low impact** | ${buckets.lowImpactLowEffort.length} tasks · BACKLOG | ${buckets.lowImpactHighEffort.length} tasks · DEFER |`);
  lines.push('');
  lines.push('### Top examples per quadrant');
  lines.push('');
  lines.push('**High impact · Low effort — DO FIRST**');
  lines.push('');
  lines.push(bucketDigest(buckets.highImpactLowEffort));
  lines.push('');
  lines.push('**High impact · High effort — PLAN**');
  lines.push('');
  lines.push(bucketDigest(buckets.highImpactHighEffort));
  lines.push('');
  lines.push('**Low impact · Low effort — BACKLOG**');
  lines.push('');
  lines.push(bucketDigest(buckets.lowImpactLowEffort));
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Slide 12: Top 10 Priorities ─────────────────────────────
  lines.push(`## Top 10 Priorities Across All Phases`);
  lines.push('');
  const top10 = [...tickets]
    .sort((a, b) => (a.priorityRank ?? Infinity) - (b.priorityRank ?? Infinity))
    .slice(0, 10);
  for (const t of top10) {
    const sopName = SOP_REGISTRY[t.sopKey as keyof typeof SOP_REGISTRY]?.name ?? t.sopKey;
    const tierLabel = t.automationTier ? ` _(${t.automationTier})_` : '';
    lines.push(`${t.priorityRank ?? '–'}. **${t.title}** — Phase ${t.phase}, ${sopName}${tierLabel}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Slide 13: Recommended Sequence ──────────────────────────
  lines.push(`## Recommended Sequence`);
  lines.push('');
  lines.push('1. **Week 1-2:** Clear Phase 1 foundation — Brand Truth standardization, Suppression decisions, messaging alignment. Every later phase reads from this.');
  lines.push('2. **Week 3-4:** Phase 5 technical implementation — semantic HTML + schema + AI Info page. Wins here cascade to every other phase\'s LLM-citation chances.');
  lines.push('3. **Week 5-6:** Phase 3 content optimization — LLM-Friendly rubric fixes + freshness updates + targeted repositioning on high-traffic drifted pages.');
  lines.push('4. **Week 7-8:** Phase 4 third-party + Phase 6 trust — entity divergences + claim consistency + reddit triage.');
  lines.push('5. **Ongoing:** Phase 2 monitoring + Phase 7 weekly reporting. Bi-weekly LLM monitoring catches regressions before they compound.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Slide 14: Methodology ───────────────────────────────────
  lines.push(`## Methodology`);
  lines.push('');
  lines.push('This audit was generated by 18 production scanners covering all 7 phases of the Steve Toth AEO methodology:');
  lines.push('');
  lines.push('- **Phase 1** — Live LLM audit (OpenAI · Anthropic · Gemini · Perplexity · You.com), Brand Truth alignment scoring, legacy content suppression via semantic-distance, cross-platform messaging audit');
  lines.push('- **Phase 2** — Bi-weekly LLM monitoring (alignment + mention rate week-over-week regressions)');
  lines.push('- **Phase 3** — LLM-Friendly Content Checklist (7-criterion rubric per page), Content Freshness Audit (HEAD/GET sweep for Last-Modified / article:modified_time / schema dateModified), Content Repositioning (high-traffic drifted pages)');
  lines.push('- **Phase 4** — Reddit sentiment triage, entity drift across 15 third-party platforms');
  lines.push('- **Phase 5** — Semantic HTML scoring (7-criterion rubric · 0-100), Schema Markup audit (JSON-LD extraction + per-page-kind expectations), AI Info Page existence check');
  lines.push('- **Phase 6** — Trust Alignment claim consistency (year / quantity / award / banned-claim detection)');
  lines.push('- **Phase 7** — Weekly AEO reporting + this audit delivery compile');
  lines.push('');
  lines.push('Every task in this audit links back to a verifiable source: a Brand Visibility Audit consensus row, a Suppression scan finding, a per-page rubric score, etc. Findings are reproducible — re-run any scanner to verify.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`_Generated ${generatedAt.toISOString()} by Clixsy Intercept._`);

  return lines.join('\n');
}

export async function buildAuditDelivery(args: BuildArgs): Promise<AuditDeliveryResult> {
  const tickets = await loadTickets(args.firmId);
  const auditSummary = await loadLatestAuditSummary(args.firmId);
  const brandTruth = await loadBrandTruth(args.firmId);

  const buckets = bucketByPriorityMatrix(tickets);
  const headlineFinding = computeHeadlineFinding(tickets, auditSummary);
  const markdown = renderMarkdown(
    args.firmName,
    args.generatedAt,
    tickets,
    buckets,
    headlineFinding,
    auditSummary,
    brandTruth,
  );

  const slug = args.firmName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const filename = `${slug}-audit-delivery-${args.generatedAt.toISOString().slice(0, 10)}.md`;
  const buffer = Buffer.from(markdown, 'utf-8');

  let blobUrl: string | null = null;
  try {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const blob = await put(`exports/${filename}`, buffer, {
        access: 'public',
        contentType: 'text/markdown; charset=utf-8',
        addRandomSuffix: true,
      });
      blobUrl = blob.url;
    }
  } catch (e) {
    console.error('[audit-delivery] blob upload failed:', e);
  }

  return {
    filename,
    blobUrl,
    bytes: buffer.byteLength,
    markdown,
    headlineFinding,
    ticketTotal: tickets.length,
  };
}
