/**
 * Deep Research Content Audit scanner — Phase 3 SOP
 * `deep_research_content_audit`.
 *
 * The one scanner in the catalog that costs real money per run. Uses
 * an LLM synthesis pass to identify content gaps from the firm's
 * existing page corpus + audit citations + competitor mentions, then
 * emits assist-tier "Create new page about X" tickets.
 *
 * Per Toth SOP, this is the *strategic* content scanner:
 *   - Step 1: Identify Refinement-Style Queries
 *   - Step 2: Audit Existing Page Coverage
 *   - Step 3: Identify Coverage Gaps   ← what this scanner outputs
 *   - Step 4: Prioritize Pages for Optimization
 *   - Step 5: Generate Per-Page Recommendations
 *
 * Budget gate (firm_budget.deep_research_quarterly_cap_usd, default $5/quarter):
 *   1. Before calling the LLM, compute estimated_cost ≈ $0.20.
 *   2. Refresh quarter_to_date_usd by checking deep_research_quarter_key
 *      against the current YYYY-Qn — if it rolled over, reset to 0.
 *   3. If quarter_to_date_usd + estimated_cost > cap → refuse, emit a
 *      manual-tier "Budget cap reached" ticket explaining the gap.
 *   4. After the call, add actual cost to quarter_to_date_usd.
 *
 * Cost profile (single openai:gpt-4.1-mini call):
 *   ~5-10K input tokens (Brand Truth + 20 top pages + competitor list +
 *   audit citations) + ~2-4K output tokens (structured findings).
 *   Pricing: input $0.40 / output $1.60 per 1M → ~$0.01-$0.03 per scan.
 *   The $5/quarter default thus covers ~150-500 scans per firm per
 *   quarter, comfortably above any realistic operator cadence.
 */

import OpenAI from 'openai';
import { z } from 'zod';
import {
  getDb,
  firms,
  firmBudgets,
  pages,
  sopRuns,
  sopStepStates,
  remediationTickets,
  brandTruthVersions,
  competitors as competitorsTable,
  competitorMentions,
  queries as queriesTable,
  auditRuns,
  consensusResponses,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { createTicketFromStep } from '../../actions/sop-actions';
import { getSopDefinition } from '../sop/registry';
import { calculateCost } from '../audit/pricing';

const SOP_KEY = 'deep_research_content_audit' as const;
// Tickets attach to step 3 (Identify Coverage Gaps).
const TICKET_STEP_NUMBER = 3;
const MODEL = 'gpt-4.1-mini';
const DAY_MS = 24 * 60 * 60 * 1000;

// Reserve some headroom on top of the estimated cost so a slightly-larger-
// than-typical output still fits under the cap rather than mid-run-failing.
const ESTIMATED_RUN_COST_USD = 0.10;

// Limits on what we feed into the prompt — keep token budget bounded.
const MAX_PAGES_IN_PROMPT = 30;
const MAX_COMPETITORS_IN_PROMPT = 8;
const MAX_AUDIT_QUERIES_IN_PROMPT = 25;

const findingSchema = z.object({
  topic: z.string().min(3).max(100).describe('The content gap topic, 3-100 chars'),
  rationale: z.string().min(20).max(500).describe('Why this gap matters: which competitors win on it, which query intent is missed, what audience'),
  target_query: z.string().min(5).max(150).describe('The primary search query the new page should rank for'),
  suggested_h1: z.string().min(10).max(120).describe('A specific H1 the new page should use'),
  suggested_url_slug: z.string().min(3).max(60).regex(/^[a-z0-9-]+$/).describe('URL slug for the new page'),
  priority: z.enum(['high', 'medium', 'low']).describe('Priority: high = competitors dominating + clear intent match; medium = real gap but lower traffic; low = nice-to-have'),
  page_kind: z.enum(['article', 'comparison', 'guide', 'service', 'faq']).describe('What kind of page to create — drives schema markup choice'),
});

const findingsResponseSchema = z.object({
  findings: z.array(findingSchema).min(0).max(20),
});

export type DeepResearchFinding = z.infer<typeof findingSchema>;

export interface DeepResearchScanResult {
  runId: string;
  blockedByBudget: boolean;
  budgetCapUsd: number;
  quarterToDateUsd: number;
  actualCostUsd: number;
  findingsFound: number;
  ticketsCreated: number;
  modelUsed: string;
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

function currentQuarterKey(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

/**
 * Ensure a firm_budget row exists and the quarter-to-date counter is
 * up-to-date for the current quarter. Returns the budget snapshot.
 */
async function loadOrInitBudget(firmId: string): Promise<{
  capUsd: number;
  qtdUsd: number;
  quarterKey: string;
}> {
  const db = getDb();
  const qKey = currentQuarterKey();

  const [row] = await db
    .select({
      capUsd: firmBudgets.deep_research_quarterly_cap_usd,
      qtdUsd: firmBudgets.deep_research_quarter_to_date_usd,
      currentQuarter: firmBudgets.deep_research_quarter_key,
      monthlyCap: firmBudgets.monthly_cap_usd,
    })
    .from(firmBudgets)
    .where(eq(firmBudgets.firm_id, firmId))
    .limit(1);

  if (!row) {
    // Seed a default firm_budget row. monthly_cap_usd is required so we
    // pick a conservative default of $100/mo (the existing per-firm
    // default for unconfigured firms) — the operator can adjust later.
    const defaultMonthlyCapUsd = Number(process.env.DEFAULT_FIRM_MONTHLY_CAP_USD ?? '100');
    await db.insert(firmBudgets).values({
      firm_id: firmId,
      monthly_cap_usd: defaultMonthlyCapUsd,
      deep_research_quarterly_cap_usd: 5.0,
      deep_research_quarter_to_date_usd: 0,
      deep_research_quarter_key: qKey,
      note: 'Auto-seeded by Deep Research scanner',
    });
    return { capUsd: 5.0, qtdUsd: 0, quarterKey: qKey };
  }

  // Reset quarter-to-date when the quarter rolls over.
  if (row.currentQuarter !== qKey) {
    await db
      .update(firmBudgets)
      .set({
        deep_research_quarter_to_date_usd: 0,
        deep_research_quarter_key: qKey,
        updated_at: new Date(),
      })
      .where(eq(firmBudgets.firm_id, firmId));
    return { capUsd: row.capUsd, qtdUsd: 0, quarterKey: qKey };
  }

  return { capUsd: row.capUsd, qtdUsd: row.qtdUsd, quarterKey: qKey };
}

async function addToQuarterToDate(firmId: string, deltaUsd: number): Promise<void> {
  const db = getDb();
  await db
    .update(firmBudgets)
    .set({
      deep_research_quarter_to_date_usd: sql`${firmBudgets.deep_research_quarter_to_date_usd} + ${deltaUsd}`,
      updated_at: new Date(),
    })
    .where(eq(firmBudgets.firm_id, firmId));
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

  if (existing && existing.status !== 'cancelled') return existing.id;

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
      created_by: 'scanner:deep-research',
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

async function markScannerStepsComplete(runId: string, fullySatisfied: boolean): Promise<void> {
  const db = getDb();
  const now = new Date();
  const def = getSopDefinition(SOP_KEY);

  for (const step of def.steps) {
    const shouldComplete = fullySatisfied
      ? step.number <= TICKET_STEP_NUMBER
      : step.number <= TICKET_STEP_NUMBER;
    await db
      .update(sopStepStates)
      .set({
        status: shouldComplete ? 'completed' : 'not_started',
        started_at: shouldComplete ? now : null,
        completed_at: shouldComplete ? now : null,
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
      next_review_at: new Date(Date.now() + 90 * DAY_MS),
    })
    .where(eq(sopRuns.id, runId));
}

/**
 * Load the inputs the synthesis prompt needs. Cap each list aggressively
 * — the prompt should stay under 10K tokens or so to keep cost predictable.
 */
async function loadPromptInputs(firmId: string): Promise<{
  brandTruth: BrandTruth | null;
  pages: Array<{ url: string; title: string | null; wordCount: number | null }>;
  competitorsOrdered: Array<{ name: string; website: string | null; mentions: number }>;
  topAuditQueries: Array<{ text: string; firmMentioned: number; competitorMentions: number }>;
}> {
  const db = getDb();

  // Brand Truth.
  const [btv] = await db
    .select({ payload: brandTruthVersions.payload })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  const brandTruth = (btv?.payload as BrandTruth | undefined) ?? null;

  // Top pages by word count (proxy for "this is real content, not a thin page").
  const pageRows = await db
    .select({
      url: pages.url,
      title: pages.title,
      wordCount: pages.word_count,
    })
    .from(pages)
    .where(eq(pages.firm_id, firmId))
    .orderBy(desc(pages.word_count))
    .limit(MAX_PAGES_IN_PROMPT);

  // Competitors with mention counts (descending).
  const compRows = await db
    .select({
      id: competitorsTable.id,
      name: competitorsTable.name,
      website: competitorsTable.website,
    })
    .from(competitorsTable)
    .where(eq(competitorsTable.firm_id, firmId))
    .limit(50);

  const competitorMentionCounts = await db
    .select({
      competitorId: competitorMentions.competitor_id,
      count: sql<number>`count(*)::int`,
    })
    .from(competitorMentions)
    .where(eq(competitorMentions.firm_id, firmId))
    .groupBy(competitorMentions.competitor_id);
  const countByCompetitor = new Map(
    competitorMentionCounts.map((r) => [r.competitorId, Number(r.count)]),
  );
  const competitorsOrdered = compRows
    .map((c) => ({
      name: c.name,
      website: c.website,
      mentions: countByCompetitor.get(c.id) ?? 0,
    }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, MAX_COMPETITORS_IN_PROMPT);

  // Top audit queries — pull from latest full audit, sorted by where
  // competitors are mentioned but the firm isn't (= "gap" queries).
  const [latestAudit] = await db
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

  let topAuditQueries: Array<{ text: string; firmMentioned: number; competitorMentions: number }> = [];
  if (latestAudit) {
    const qRows = await db
      .select({
        id: queriesTable.id,
        text: queriesTable.text,
      })
      .from(queriesTable)
      .where(eq(queriesTable.audit_run_id, latestAudit.id));
    if (qRows.length > 0) {
      // Per-query firm mention rate.
      const consensusRows = await db
        .select({
          queryId: consensusResponses.query_id,
          mentioned: consensusResponses.mentioned,
        })
        .from(consensusResponses)
        .where(
          inArray(
            consensusResponses.query_id,
            qRows.map((q) => q.id),
          ),
        );
      const firmMentionedByQuery = new Map<string, number>();
      for (const c of consensusRows) {
        firmMentionedByQuery.set(c.queryId, (firmMentionedByQuery.get(c.queryId) ?? 0) + (c.mentioned ? 1 : 0));
      }
      // Per-query competitor mention count.
      const compByQuery = await db
        .select({
          queryId: competitorMentions.query_id,
          count: sql<number>`count(*)::int`,
        })
        .from(competitorMentions)
        .where(
          and(
            eq(competitorMentions.firm_id, firmId),
            inArray(
              competitorMentions.query_id,
              qRows.map((q) => q.id),
            ),
          ),
        )
        .groupBy(competitorMentions.query_id);
      const compMentionsByQuery = new Map(compByQuery.map((c) => [c.queryId, Number(c.count)]));

      topAuditQueries = qRows
        .map((q) => ({
          text: q.text,
          firmMentioned: firmMentionedByQuery.get(q.id) ?? 0,
          competitorMentions: compMentionsByQuery.get(q.id) ?? 0,
        }))
        // Prefer queries where competitors are mentioned but firm isn't.
        .sort((a, b) => (b.competitorMentions - b.firmMentioned) - (a.competitorMentions - a.firmMentioned))
        .slice(0, MAX_AUDIT_QUERIES_IN_PROMPT);
    }
  }

  return {
    brandTruth,
    pages: pageRows,
    competitorsOrdered,
    topAuditQueries,
  };
}

function buildPrompt(
  firmName: string,
  inputs: Awaited<ReturnType<typeof loadPromptInputs>>,
): string {
  const bt = inputs.brandTruth as Record<string, unknown> | null;
  const btSummary = bt
    ? [
        `Firm name: ${firmName}`,
        bt.firm_type ? `Firm type: ${bt.firm_type}` : '',
        bt.primary_url ? `Primary URL: ${bt.primary_url}` : '',
        Array.isArray(bt.unique_differentiators)
          ? `Differentiators: ${(bt.unique_differentiators as string[]).join(', ')}`
          : '',
        Array.isArray(bt.practice_areas)
          ? `Practice areas: ${(bt.practice_areas as string[]).join(', ')}`
          : Array.isArray(bt.service_offerings)
            ? `Services: ${(bt.service_offerings as Array<{ name?: string }>).map((s) => s.name).filter(Boolean).join(', ')}`
            : '',
        Array.isArray(bt.geographies_served)
          ? `Geographies: ${(bt.geographies_served as Array<{ city?: string; state?: string }>).map((g) => `${g.city ?? ''} ${g.state ?? ''}`.trim()).join('; ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : `Firm name: ${firmName}\n(No Brand Truth on file — make conservative recommendations.)`;

  const pageList = inputs.pages
    .map(
      (p, i) =>
        `${i + 1}. ${p.title ?? '(untitled)'} — ${p.url}${p.wordCount ? ` (${p.wordCount} words)` : ''}`,
    )
    .join('\n');

  const competitorList = inputs.competitorsOrdered
    .map(
      (c, i) =>
        `${i + 1}. ${c.name}${c.website ? ` (${c.website})` : ''} — ${c.mentions} LLM mention${c.mentions === 1 ? '' : 's'}`,
    )
    .join('\n');

  const gapQueries = inputs.topAuditQueries
    .filter((q) => q.competitorMentions > q.firmMentioned)
    .map((q) => `- "${q.text}" — competitors mentioned ${q.competitorMentions}× · firm mentioned ${q.firmMentioned}×`)
    .join('\n');

  return [
    `You are an AEO (Answer Engine Optimization) strategist auditing a firm's content gaps. Your output drives content creation decisions, so be specific.`,
    ``,
    `# Firm context`,
    btSummary,
    ``,
    `# Current content`,
    `Top ${inputs.pages.length} pages by depth (highest word count first):`,
    pageList || '(no crawled pages)',
    ``,
    `# Competitive landscape`,
    `Competitors and how often LLMs cite them:`,
    competitorList || '(no competitor mentions tracked yet)',
    ``,
    `# Gap queries`,
    `Queries from the latest LLM audit where competitors are mentioned more than the firm:`,
    gapQueries || '(no clear gap queries)',
    ``,
    `# Your task`,
    `Identify the highest-impact content gaps — topics where this firm should create NEW pages to capture LLM citation share. Look for:`,
    ``,
    `1. Refinement-style queries (e.g. "best [service] for [audience]") where the firm has no matching page`,
    `2. Comparison topics where competitors are dominating LLM responses`,
    `3. Multi-hop topics where the firm's expertise should map to a specific intent but no page exists`,
    `4. FAQ-style topics where short, definition-rich content would capture extraction-style citations`,
    ``,
    `For each gap, output a structured finding with:`,
    `  - topic: the gap topic`,
    `  - rationale: WHY this gap matters (cite specific competitor / query evidence above)`,
    `  - target_query: the primary search/LLM query the new page should serve`,
    `  - suggested_h1: a specific, citable H1`,
    `  - suggested_url_slug: lowercase-with-hyphens slug`,
    `  - priority: high | medium | low`,
    `  - page_kind: article | comparison | guide | service | faq`,
    ``,
    `Return 5-15 findings, ordered by priority (highest first). Skip gaps the firm has already covered. Be specific — vague suggestions like "blog about AEO" are useless.`,
  ].join('\n');
}

interface LlmResult {
  findings: DeepResearchFinding[];
  costUsd: number;
  model: string;
}

async function runLlmSynthesis(prompt: string): Promise<LlmResult> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: 'You output strictly valid JSON matching the schema described in the user message. No prose outside JSON.' },
      { role: 'user', content: prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'deep_research_findings',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['findings'],
          properties: {
            findings: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['topic', 'rationale', 'target_query', 'suggested_h1', 'suggested_url_slug', 'priority', 'page_kind'],
                properties: {
                  topic: { type: 'string' },
                  rationale: { type: 'string' },
                  target_query: { type: 'string' },
                  suggested_h1: { type: 'string' },
                  suggested_url_slug: { type: 'string' },
                  priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                  page_kind: { type: 'string', enum: ['article', 'comparison', 'guide', 'service', 'faq'] },
                },
              },
            },
          },
        },
      },
    },
    temperature: 0.2,
  });

  const rawJson = completion.choices[0]?.message.content ?? '{}';
  const parsed = findingsResponseSchema.parse(JSON.parse(rawJson));

  const usage = {
    input_tokens: completion.usage?.prompt_tokens ?? 0,
    output_tokens: completion.usage?.completion_tokens ?? 0,
    total_tokens: completion.usage?.total_tokens ?? 0,
  };
  const costUsd = calculateCost('openai', MODEL, usage);

  return {
    findings: parsed.findings,
    costUsd,
    model: MODEL,
  };
}

function buildBudgetGateTicket(
  cap: number,
  qtd: number,
  est: number,
): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  return {
    title: `Deep Research Content Audit — budget cap reached this quarter`,
    description: `Deep Research uses an LLM synthesis pass costing roughly $${est.toFixed(2)} per run. This firm has consumed $${qtd.toFixed(2)} of its $${cap.toFixed(2)} quarterly cap; running the scan now would exceed the cap.`,
    remediationCopy: `**Quarterly cap:** $${cap.toFixed(2)}\n**Used so far:** $${qtd.toFixed(2)}\n**Next run estimate:** $${est.toFixed(2)}\n\n**Options:**\n\n1. **Raise the cap** in firm Settings → Budget if Deep Research adds enough value for this firm to justify monthly runs.\n2. **Wait for the quarter to reset** — the counter rolls over on the first day of the next calendar quarter.\n3. **Pull the data manually** using ChatGPT Deep Research with the queries from the most recent Brand Visibility Audit as input.\n\nThis is a deliberate guardrail, not an error. Most firms run Deep Research quarterly — the default cap of $5/quarter comfortably covers that cadence with ~50-100× headroom.`,
    validationSteps: [
      { description: 'Decide: raise cap, wait for quarter reset, or run manually' },
      { description: 'If raising: update firm.deep_research_quarterly_cap_usd' },
      { description: 'Re-run the scan after the cap is updated' },
    ],
  };
}

function buildFindingTicket(f: DeepResearchFinding, primaryUrl: string | null): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  const priorityLabel = f.priority[0]!.toUpperCase() + f.priority.slice(1);
  const title = `[${priorityLabel}] Create page: ${f.topic}`;
  const description =
    `${f.rationale}\n\n` +
    `Target query: "${f.target_query}"\n` +
    `Suggested H1: ${f.suggested_h1}\n` +
    `Suggested URL: ${primaryUrl ? `${primaryUrl.replace(/\/$/, '')}/${f.suggested_url_slug}` : `/${f.suggested_url_slug}`}\n` +
    `Page kind: ${f.page_kind}`;

  const schemaByKind: Record<string, string> = {
    article: 'Article + BreadcrumbList',
    comparison: 'Article + FAQPage (compare-and-contrast Q&A)',
    guide: 'Article + HowTo',
    service: 'Service + LocalBusiness (or industry-specific subtype) + FAQPage',
    faq: 'FAQPage + WebPage',
  };

  const remediationCopy = `**Page kind:** ${f.page_kind}

**Suggested URL:** \`${primaryUrl ? `${primaryUrl.replace(/\/$/, '')}/${f.suggested_url_slug}` : `/${f.suggested_url_slug}`}\`

**Suggested H1:** ${f.suggested_h1}

**Target query (primary):** "${f.target_query}"

**Why this gap matters:** ${f.rationale}

**Build plan:**

1. **Draft the page** following the LLM-Friendly Content Checklist (Phase 3 scanner):
   - Direct answer to the target query in the first 100 words
   - 400-6000 words
   - Include 3+ citable facts (years, %, dates, named entities)
   - Use Brand Truth required positioning phrases verbatim
   - H2/H3 section headers as question-shaped where possible
   - Definition list (\`<dl>\`) for any key terms

2. **Add schema markup:** ${schemaByKind[f.page_kind] ?? 'Article + WebPage'}

3. **Add internal links** from related existing pages (use anchor text that includes the target query)

4. **Publish + submit to GSC** for indexing

5. **Verify after 2-4 weeks** by running the next Brand Visibility Audit — does the new page get cited for the target query?`;

  const validationSteps = [
    { description: 'Draft the page meeting LLM-Friendly Content Checklist criteria' },
    { description: 'Implement the recommended schema markup' },
    { description: 'Add internal links from related pages' },
    { description: 'Publish and submit to GSC for indexing' },
    { description: 'Re-run Brand Visibility Audit after 2-4 weeks; confirm page citation appears' },
  ];

  return { title, description, remediationCopy, validationSteps };
}

export async function runDeepResearchScan(firmId: string): Promise<DeepResearchScanResult> {
  const db = getDb();
  const firm = await resolveFirm({ id: firmId });
  const runId = await findOrCreateScannerRun(firm.id);
  await clearPriorOpenTickets(firm.id, runId);

  // ── Budget gate ─────────────────────────────────────────────
  const budget = await loadOrInitBudget(firm.id);
  if (budget.qtdUsd + ESTIMATED_RUN_COST_USD > budget.capUsd) {
    const gate = buildBudgetGateTicket(budget.capUsd, budget.qtdUsd, ESTIMATED_RUN_COST_USD);
    await createTicketFromStep({
      firmSlug: firm.slug,
      sopKey: SOP_KEY,
      runId,
      stepNumber: TICKET_STEP_NUMBER,
      title: gate.title,
      description: gate.description,
      priorityRank: 1,
      remediationCopy: gate.remediationCopy,
      validationSteps: gate.validationSteps,
      evidenceLinks: [],
      automationTier: 'manual',
      manualReason: `Deep Research quarterly budget cap of $${budget.capUsd.toFixed(2)} would be exceeded by the estimated $${ESTIMATED_RUN_COST_USD.toFixed(2)} next-run cost (quarter-to-date: $${budget.qtdUsd.toFixed(2)}).`,
    });
    await markScannerStepsComplete(runId, false);
    return {
      runId,
      blockedByBudget: true,
      budgetCapUsd: budget.capUsd,
      quarterToDateUsd: budget.qtdUsd,
      actualCostUsd: 0,
      findingsFound: 0,
      ticketsCreated: 1,
      modelUsed: MODEL,
    };
  }

  // ── Synthesis pass ──────────────────────────────────────────
  const inputs = await loadPromptInputs(firm.id);
  if (inputs.pages.length === 0) {
    throw new Error('No crawled pages found — run the Suppression scan first to populate the page corpus.');
  }
  const prompt = buildPrompt(firm.name, inputs);
  const llm = await runLlmSynthesis(prompt);

  // Update quarter-to-date with actual cost.
  await addToQuarterToDate(firm.id, llm.costUsd);

  // ── Get primary URL for suggested URL composition ──────────
  const [btv] = await db
    .select({ payload: brandTruthVersions.payload })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firm.id))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  const primaryUrl =
    (btv?.payload as { primary_url?: string } | undefined)?.primary_url ?? null;

  // Sort findings by priority then by topic length (more specific first).
  const priorityOrder: Record<DeepResearchFinding['priority'], number> = {
    high: 1,
    medium: 2,
    low: 3,
  };
  const sorted = [...llm.findings].sort((a, b) => {
    if (priorityOrder[a.priority] !== priorityOrder[b.priority])
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    return b.topic.length - a.topic.length;
  });

  let priorityRank = 1;
  let ticketsCreated = 0;
  for (const f of sorted) {
    const payload = buildFindingTicket(f, primaryUrl);
    await createTicketFromStep({
      firmSlug: firm.slug,
      sopKey: SOP_KEY,
      runId,
      stepNumber: TICKET_STEP_NUMBER,
      title: payload.title,
      description: payload.description,
      priorityRank: priorityRank++,
      remediationCopy: payload.remediationCopy,
      validationSteps: payload.validationSteps,
      evidenceLinks: [],
      automationTier: 'assist',
      executeUrl: primaryUrl ?? undefined,
      executeLabel: primaryUrl ? 'Open CMS' : undefined,
    });
    ticketsCreated += 1;
  }

  await markScannerStepsComplete(runId, true);

  return {
    runId,
    blockedByBudget: false,
    budgetCapUsd: budget.capUsd,
    quarterToDateUsd: budget.qtdUsd + llm.costUsd,
    actualCostUsd: llm.costUsd,
    findingsFound: llm.findings.length,
    ticketsCreated,
    modelUsed: llm.model,
  };
}

export async function runDeepResearchScanBySlug(firmSlug: string): Promise<DeepResearchScanResult> {
  const firm = await resolveFirm({ slug: firmSlug });
  return runDeepResearchScan(firm.id);
}
