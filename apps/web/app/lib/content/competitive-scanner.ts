/**
 * Competitive LLM Monitoring scanner — Phase 7 SOP
 * `competitive_llm_monitoring`.
 *
 * Reads existing `competitor_mention` data populated by every audit
 * run. Each row records when an LLM mentioned a named competitor in
 * response to a firm-relevant query, with `share` (rough share-of-
 * voice estimate, 0..1) and `praise_flag` (whether the mention was
 * positive).
 *
 * The scanner:
 *   1. Rolls up the past 30 days of competitor mentions per competitor.
 *   2. Compares to the prior 30 days.
 *   3. Identifies THREATS — competitors gaining share or praise (mention
 *      count or share rose meaningfully).
 *   4. Identifies OPPORTUNITIES — competitors with high praise but
 *      where the firm is also being mentioned in the same query set,
 *      i.e. queries where a comparison page or counter-positioning
 *      content would peel share.
 *   5. Emits one assist-tier ticket per threat + opportunity, with
 *      kind-specific remediation copy.
 *
 * The SOP per Toth doc has 5 steps (query per competitor → compare →
 * identify threats → identify opportunities → recommend responses).
 * Steps 1-2 are covered by the audit pipeline that's already running.
 * Steps 3-4 are this scanner. Step 5 (recommend responses) lives in
 * the ticket remediation copy.
 */

import {
  getDb,
  firms,
  sopRuns,
  sopStepStates,
  remediationTickets,
  competitorMentions,
  competitors as competitorsTable,
  queries as queriesTable,
  auditRuns,
} from '@ai-edge/db';
import { and, eq, desc, inArray, gte, lt, sql } from 'drizzle-orm';
import { createTicketFromStep } from '../../actions/sop-actions';
import { getSopDefinition } from '../sop/registry';
import { computePriority } from '../sop/priority-score';

const SOP_KEY = 'competitive_llm_monitoring' as const;
// Tickets attach to step 3 (Identify Threats) — the synthesis step.
const TICKET_STEP_NUMBER = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const DAY_MS_30 = WINDOW_DAYS * DAY_MS;

// Trigger thresholds.
const MENTION_GROWTH_PCT = 25;        // Threat: mentions rose ≥ 25%
const SHARE_GROWTH_PCT = 10;          // Threat: share-of-voice rose ≥ 10pp
const PRAISE_RATIO_THRESHOLD = 0.4;   // Opportunity: ≥ 40% of competitor's mentions praise
const MIN_CURRENT_MENTIONS = 3;       // Don't flag noise — need ≥ 3 mentions to count

export type CompetitiveFindingKind = 'threat_gaining_share' | 'threat_gaining_mentions' | 'opportunity_high_praise';

export interface CompetitiveFinding {
  competitorId: string;
  competitorName: string;
  competitorWebsite: string | null;
  kind: CompetitiveFindingKind;
  current: { mentions: number; avgShare: number; praiseRatio: number };
  prior: { mentions: number; avgShare: number; praiseRatio: number };
  /** Queries where this competitor was mentioned — for evidence. */
  topQueries: Array<{ queryText: string; share: number | null }>;
}

export interface CompetitiveScanResult {
  runId: string;
  windowStart: string;
  windowEnd: string;
  competitorsTracked: number;
  threatsFound: number;
  opportunitiesFound: number;
  ticketsCreated: number;
}

interface FirmRow {
  id: string;
  slug: string;
  name: string;
}

async function resolveFirm(arg: { id?: string; slug?: string }): Promise<FirmRow> {
  const db = getDb();
  if (arg.id) {
    const [f] = await db
      .select({ id: firms.id, slug: firms.slug, name: firms.name })
      .from(firms)
      .where(eq(firms.id, arg.id))
      .limit(1);
    if (!f) throw new Error(`Firm not found: ${arg.id}`);
    return f;
  }
  if (arg.slug) {
    const [f] = await db
      .select({ id: firms.id, slug: firms.slug, name: firms.name })
      .from(firms)
      .where(eq(firms.slug, arg.slug))
      .limit(1);
    if (!f) throw new Error(`Firm not found: ${arg.slug}`);
    return f;
  }
  throw new Error('resolveFirm: id or slug required');
}

async function findOrCreateScannerRun(firmId: string): Promise<string> {
  const db = getDb();
  const def = getSopDefinition(SOP_KEY);

  const [existing] = await db
    .select({ id: sopRuns.id, status: sopRuns.status })
    .from(sopRuns)
    .where(and(eq(sopRuns.firm_id, firmId), eq(sopRuns.sop_key, SOP_KEY)))
    .orderBy(desc(sopRuns.created_at))
    .limit(1);

  if (existing && existing.status !== 'cancelled') {
    return existing.id;
  }

  const now = new Date();
  const [inserted] = await db
    .insert(sopRuns)
    .values({
      firm_id: firmId,
      sop_key: SOP_KEY,
      phase: def.phase,
      status: 'in_progress',
      current_step: 1,
      started_at: now,
      meta: { scanner_managed: true },
      created_by: 'scanner:competitive-llm',
    })
    .returning({ id: sopRuns.id });
  const runId = inserted!.id;

  await db.insert(sopStepStates).values(
    def.steps.map((s) => ({
      sop_run_id: runId,
      step_number: s.number,
      step_key: s.key,
      status: 'not_started' as const,
    })),
  );
  return runId;
}

async function clearPriorOpenTickets(firmId: string, runId: string): Promise<void> {
  const db = getDb();
  await db
    .delete(remediationTickets)
    .where(
      and(
        eq(remediationTickets.firm_id, firmId),
        eq(remediationTickets.sop_run_id, runId),
        eq(remediationTickets.sop_step_number, TICKET_STEP_NUMBER),
        inArray(remediationTickets.status, ['open', 'in_progress']),
      ),
    );
}

async function markScannerStepsComplete(runId: string): Promise<void> {
  const db = getDb();
  const now = new Date();
  const def = getSopDefinition(SOP_KEY);

  for (const step of def.steps) {
    const targetStatus = step.number <= TICKET_STEP_NUMBER ? 'completed' : 'not_started';
    await db
      .update(sopStepStates)
      .set({
        status: targetStatus,
        started_at: targetStatus === 'completed' ? now : null,
        completed_at: targetStatus === 'completed' ? now : null,
      })
      .where(
        and(eq(sopStepStates.sop_run_id, runId), eq(sopStepStates.step_number, step.number)),
      );
  }

  await db
    .update(sopRuns)
    .set({
      current_step: TICKET_STEP_NUMBER + 1,
      status: 'awaiting_input',
      started_at: now,
      next_review_at: new Date(Date.now() + 30 * DAY_MS),
    })
    .where(eq(sopRuns.id, runId));
}

interface WindowRollup {
  byCompetitor: Map<string, { mentions: number; shareSum: number; shareCount: number; praiseCount: number }>;
}

/**
 * Roll up competitor_mention rows in a window, keyed by competitor.
 * We join through query → audit_run to filter by audit completion
 * time (mentions get a detected_at when the audit completes, so the
 * window filter on competitorMentions.detected_at is sufficient).
 */
async function rollupWindow(
  firmId: string,
  start: Date,
  end: Date,
): Promise<WindowRollup> {
  const db = getDb();
  const rows = await db
    .select({
      competitorId: competitorMentions.competitor_id,
      share: competitorMentions.share,
      praise: competitorMentions.praise_flag,
    })
    .from(competitorMentions)
    .where(
      and(
        eq(competitorMentions.firm_id, firmId),
        gte(competitorMentions.detected_at, start),
        lt(competitorMentions.detected_at, end),
      ),
    );

  const byCompetitor = new Map<
    string,
    { mentions: number; shareSum: number; shareCount: number; praiseCount: number }
  >();
  for (const r of rows) {
    const bucket = byCompetitor.get(r.competitorId) ?? {
      mentions: 0,
      shareSum: 0,
      shareCount: 0,
      praiseCount: 0,
    };
    bucket.mentions += 1;
    if (r.share != null) {
      bucket.shareSum += r.share;
      bucket.shareCount += 1;
    }
    if (r.praise) bucket.praiseCount += 1;
    byCompetitor.set(r.competitorId, bucket);
  }
  return { byCompetitor };
}

/**
 * Pull the top 5 queries where this competitor was mentioned in the
 * current window — for the ticket's evidence section.
 */
async function loadTopQueriesForCompetitor(
  firmId: string,
  competitorId: string,
  start: Date,
  end: Date,
): Promise<Array<{ queryText: string; share: number | null }>> {
  const db = getDb();
  const rows = await db
    .select({
      queryText: queriesTable.text,
      share: competitorMentions.share,
    })
    .from(competitorMentions)
    .innerJoin(queriesTable, eq(queriesTable.id, competitorMentions.query_id))
    .where(
      and(
        eq(competitorMentions.firm_id, firmId),
        eq(competitorMentions.competitor_id, competitorId),
        gte(competitorMentions.detected_at, start),
        lt(competitorMentions.detected_at, end),
      ),
    )
    .orderBy(desc(competitorMentions.share))
    .limit(5);
  return rows.map((r) => ({ queryText: r.queryText, share: r.share }));
}

function buildThreatTicket(f: CompetitiveFinding): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  const mentionDelta = f.current.mentions - f.prior.mentions;
  const mentionPct =
    f.prior.mentions === 0 ? 'newly tracked' : `+${Math.round(((f.current.mentions - f.prior.mentions) / f.prior.mentions) * 100)}%`;
  const shareDeltaPP = ((f.current.avgShare - f.prior.avgShare) * 100).toFixed(1);

  const title =
    f.kind === 'threat_gaining_share'
      ? `Competitive threat: ${f.competitorName} gained ${shareDeltaPP}pp share-of-voice`
      : `Competitive threat: ${f.competitorName} gained ${mentionDelta} mention${mentionDelta === 1 ? '' : 's'} (${mentionPct})`;

  const description =
    `LLMs are increasingly citing ${f.competitorName} in response to queries about your space.\n\n` +
    `Past 30 days: ${f.current.mentions} mentions · avg share ${(f.current.avgShare * 100).toFixed(1)}% · praise ratio ${(f.current.praiseRatio * 100).toFixed(0)}%\n` +
    `Prior 30 days: ${f.prior.mentions} mentions · avg share ${(f.prior.avgShare * 100).toFixed(1)}% · praise ratio ${(f.prior.praiseRatio * 100).toFixed(0)}%\n\n` +
    `Top queries where ${f.competitorName} appeared:\n` +
    f.topQueries.map((q) => `- "${q.queryText}"${q.share != null ? ` (share: ${(q.share * 100).toFixed(0)}%)` : ''}`).join('\n');

  const remediationCopy =
    `**Competitor:** ${f.competitorName}${f.competitorWebsite ? ` (${f.competitorWebsite})` : ''}\n\n**What changed:** Either mention count or share-of-voice rose meaningfully period-over-period. LLMs are surfacing this competitor in conversations where you should also be appearing.\n\n**Response options (Toth methodology, Step 5):**\n\n1. **Comparison page** — for any query where this competitor is dominant and you have a real differentiation angle, draft a "vs ${f.competitorName}" page. LLMs cite comparison content frequently. (Use the Comparison Page Creation SOP when wired.)\n\n2. **Counter-positioning content** — write a thought-leadership post answering the same queries with your firm's framing. Cross-link from existing high-traffic pages.\n\n3. **Entity signal boost** — if ${f.competitorName} is gaining Knowledge Graph + schema mentions, check whether your Wikidata + Organization JSON-LD is keeping up (Phase 4 Entity Optimization scan).\n\n4. **Direct rebuttal in /ai-info** — if the firm has an /ai-info page, add a "How we're different from [competitor]" section in canonical language.\n\n5. **Defer** — if the queries where ${f.competitorName} is winning are genuinely outside your service offering, document it and move on. Not every fight is worth fighting.`;

  const validationSteps = [
    { description: 'Review the top queries — confirm they are in scope for your firm' },
    { description: 'Pick a response strategy from the 5 options' },
    { description: 'Execute the chosen response (comparison page / content / entity work)' },
    { description: 'Re-run Phase 7 Competitive scan after the next audit cycle to verify movement' },
  ];
  return { title, description, remediationCopy, validationSteps };
}

function buildOpportunityTicket(f: CompetitiveFinding): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  const praisePct = Math.round(f.current.praiseRatio * 100);
  const title = `Opportunity: ${f.competitorName} drawing ${praisePct}% praise — counter-position`;
  const description =
    `${f.competitorName} is being praised in ${praisePct}% of LLM responses about your space. That's a signal worth examining: what are LLMs praising them for, and can you legitimately make the same claim?\n\n` +
    `Past 30 days: ${f.current.mentions} mentions · ${Math.round(f.current.mentions * f.current.praiseRatio)} praise (${praisePct}%) · share ${(f.current.avgShare * 100).toFixed(1)}%\n\n` +
    `Top queries:\n` +
    f.topQueries.map((q) => `- "${q.queryText}"`).join('\n');

  const remediationCopy =
    `**Competitor:** ${f.competitorName}${f.competitorWebsite ? ` (${f.competitorWebsite})` : ''}\n\n**What this tells us:** LLMs aren't just citing ${f.competitorName} — they're praising them. That praise is being constructed from some combination of (a) third-party reviews, (b) press / awards, (c) on-site claims. The praise pattern reveals what attribute LLMs consider valuable in your space.\n\n**Action:**\n\n1. **Run an LLM query yourself** on one of the top queries above. Note specifically what LLMs say is good about ${f.competitorName} — credentials, results, niche, longevity, price, geographic reach, whatever it is.\n\n2. **Check whether the same claim is true of your firm** but absent from your positioning surface. If yes → that's your fastest counter — add the missing claim verbatim to your Brand Truth + propagate to top pages + /ai-info.\n\n3. **If the claim isn't true of your firm**, the action is harder but more interesting: pick a different attribute where you objectively win, and build content + entity signals around it. LLMs reward consistent, citable, verifiable positioning.\n\n4. **Track the next monthly scan.** If the firm's mention rate on the same queries rises while ${f.competitorName}'s praise stays flat, the counter-positioning worked.`;

  const validationSteps = [
    { description: 'Manually run one of the top queries on ChatGPT / Claude / Perplexity' },
    { description: 'Identify the specific attribute LLMs are praising the competitor for' },
    { description: 'Confirm whether the firm has a legitimate equivalent claim' },
    { description: 'Update Brand Truth + propagate to top pages' },
    { description: 'Re-run Phase 7 Competitive scan after next audit cycle' },
  ];
  return { title, description, remediationCopy, validationSteps };
}

export async function runCompetitiveScan(firmId: string): Promise<CompetitiveScanResult> {
  const db = getDb();
  const firm = await resolveFirm({ id: firmId });
  const now = new Date();
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - DAY_MS_30);
  const priorWindowStart = new Date(windowStart.getTime() - DAY_MS_30);

  const current = await rollupWindow(firm.id, windowStart, windowEnd);
  const prior = await rollupWindow(firm.id, priorWindowStart, windowStart);

  // Load competitor metadata for every competitor that appeared in either window.
  const competitorIds = new Set<string>([
    ...current.byCompetitor.keys(),
    ...prior.byCompetitor.keys(),
  ]);
  const competitorRows =
    competitorIds.size > 0
      ? await db
          .select({
            id: competitorsTable.id,
            name: competitorsTable.name,
            website: competitorsTable.website,
          })
          .from(competitorsTable)
          .where(inArray(competitorsTable.id, [...competitorIds]))
      : [];
  const competitorById = new Map(competitorRows.map((c) => [c.id, c]));

  // Detect findings.
  const findings: CompetitiveFinding[] = [];
  for (const id of competitorIds) {
    const c = current.byCompetitor.get(id) ?? {
      mentions: 0,
      shareSum: 0,
      shareCount: 0,
      praiseCount: 0,
    };
    const p = prior.byCompetitor.get(id) ?? {
      mentions: 0,
      shareSum: 0,
      shareCount: 0,
      praiseCount: 0,
    };
    if (c.mentions < MIN_CURRENT_MENTIONS) continue; // skip noise

    const meta = competitorById.get(id);
    if (!meta) continue;

    const currentAvgShare = c.shareCount > 0 ? c.shareSum / c.shareCount : 0;
    const priorAvgShare = p.shareCount > 0 ? p.shareSum / p.shareCount : 0;
    const currentPraiseRatio = c.mentions > 0 ? c.praiseCount / c.mentions : 0;
    const priorPraiseRatio = p.mentions > 0 ? p.praiseCount / p.mentions : 0;

    const mentionDelta = c.mentions - p.mentions;
    const mentionPctGrowth = p.mentions > 0 ? (mentionDelta / p.mentions) * 100 : Infinity;
    const shareDeltaPP = (currentAvgShare - priorAvgShare) * 100;

    let kind: CompetitiveFindingKind | null = null;
    if (shareDeltaPP >= SHARE_GROWTH_PCT) kind = 'threat_gaining_share';
    else if (mentionPctGrowth >= MENTION_GROWTH_PCT && mentionDelta >= 2)
      kind = 'threat_gaining_mentions';
    else if (currentPraiseRatio >= PRAISE_RATIO_THRESHOLD) kind = 'opportunity_high_praise';

    if (!kind) continue;

    const topQueries = await loadTopQueriesForCompetitor(firm.id, id, windowStart, windowEnd);
    findings.push({
      competitorId: id,
      competitorName: meta.name,
      competitorWebsite: meta.website,
      kind,
      current: {
        mentions: c.mentions,
        avgShare: currentAvgShare,
        praiseRatio: currentPraiseRatio,
      },
      prior: {
        mentions: p.mentions,
        avgShare: priorAvgShare,
        praiseRatio: priorPraiseRatio,
      },
      topQueries,
    });
  }

  // Sort: threats first, then opportunities, both by mention count DESC.
  const threatRank: Record<CompetitiveFindingKind, number> = {
    threat_gaining_share: 1,
    threat_gaining_mentions: 2,
    opportunity_high_praise: 3,
  };
  findings.sort((a, b) => {
    if (threatRank[a.kind] !== threatRank[b.kind]) return threatRank[a.kind] - threatRank[b.kind];
    return b.current.mentions - a.current.mentions;
  });

  const runId = await findOrCreateScannerRun(firm.id);
  await clearPriorOpenTickets(firm.id, runId);

  let priorityRank = 1;
  let ticketsCreated = 0;
  let threats = 0;
  let opportunities = 0;
  // Competitive monitoring tickets are trend/threat alerts about
  // competitor positioning — not direct site-improvement tasks.
  // Defaults to unknown class for v1; refine once the operator
  // workflow for these signals is clearer.
  const competitivePriority = computePriority({ sourceType: 'sop', sopKey: SOP_KEY });
  for (const f of findings) {
    const isThreat = f.kind !== 'opportunity_high_praise';
    if (isThreat) threats += 1;
    else opportunities += 1;
    const payload = isThreat ? buildThreatTicket(f) : buildOpportunityTicket(f);
    await createTicketFromStep({
      firmSlug: firm.slug,
      sopKey: SOP_KEY,
      runId,
      stepNumber: TICKET_STEP_NUMBER,
      title: payload.title,
      description: payload.description,
      priorityRank: priorityRank++,
      priorityClass: competitivePriority.priorityClass,
      priorityScore: competitivePriority.priorityScore,
      remediationCopy: payload.remediationCopy,
      validationSteps: payload.validationSteps,
      evidenceLinks: f.competitorWebsite
        ? [{ kind: 'third_party_listing', url: f.competitorWebsite, description: `${f.competitorName} site` }]
        : [],
      automationTier: 'assist',
      executeUrl: f.competitorWebsite ?? undefined,
      executeLabel: f.competitorWebsite ? `Open ${f.competitorName}` : undefined,
    });
    ticketsCreated += 1;
  }

  await markScannerStepsComplete(runId);

  return {
    runId,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    competitorsTracked: competitorIds.size,
    threatsFound: threats,
    opportunitiesFound: opportunities,
    ticketsCreated,
  };
}

export async function runCompetitiveScanBySlug(firmSlug: string): Promise<CompetitiveScanResult> {
  const firm = await resolveFirm({ slug: firmSlug });
  return runCompetitiveScan(firm.id);
}
