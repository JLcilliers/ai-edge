/**
 * Phase 2 (Measurement & Monitoring) triage scanner.
 *
 * Phase 2 has three SOPs, two of which need external infrastructure
 * that isn't wired yet:
 *
 *   - ga4_llm_traffic_setup       → needs GA4 OAuth + Admin API
 *   - ai_bot_log_file_analysis    → needs Cloudflare Logpush / Vercel Log Drain
 *   - bi_weekly_llm_monitoring    → runnable now against existing audit history
 *
 * This scanner makes Phase 2 useful immediately by:
 *   1. Surfacing the credential gaps as manual-tier "Configure X"
 *      tickets so operators can wire up the integrations.
 *   2. Running the bi-weekly LLM monitoring comparison over the past
 *      28 days (two 14-day windows) and emitting regression tickets
 *      when alignment, mention rate, or citation count is trending
 *      worse week-over-week.
 *
 * Lifecycle matches the other scanner-managed SOPs.
 */

import {
  getDb,
  firms,
  sopRuns,
  sopStepStates,
  remediationTickets,
  auditRuns,
  queries as queriesTable,
  consensusResponses,
  alignmentScores,
} from '@ai-edge/db';
import { and, eq, desc, inArray, gte, lt, sql } from 'drizzle-orm';
import { createTicketFromStep } from '../../actions/sop-actions';
import { getSopDefinition } from '../sop/registry';
import { computePriority } from '../sop/priority-score';
import type { SopKey } from '../sop/types';

const SOP_GA4 = 'ga4_llm_traffic_setup' as const;
const SOP_AI_BOT = 'ai_bot_log_file_analysis' as const;
const SOP_BI_WEEKLY = 'bi_weekly_llm_monitoring' as const;

const TICKET_STEP_NUMBER = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 14;

// Trigger thresholds for regression tickets.
const ALIGNMENT_REGRESSION_PCT = 5;     // green-rate dropped by ≥ 5pp
const MENTION_REGRESSION_PCT = 5;       // mention rate dropped by ≥ 5pp

export interface MeasurementTriageResult {
  ga4Configured: boolean;
  aiBotConfigured: boolean;
  biWeeklyAuditsCurrent: number;
  biWeeklyAuditsPrior: number;
  regressionFindings: number;
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

async function findOrCreateSopRun(firmId: string, sopKey: SopKey): Promise<string> {
  const db = getDb();
  const def = getSopDefinition(sopKey);

  const [existing] = await db
    .select({ id: sopRuns.id, status: sopRuns.status })
    .from(sopRuns)
    .where(and(eq(sopRuns.firm_id, firmId), eq(sopRuns.sop_key, sopKey)))
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
      sop_key: sopKey,
      phase: def.phase,
      status: 'in_progress',
      current_step: 1,
      started_at: now,
      meta: { scanner_managed: true },
      created_by: 'scanner:measurement-triage',
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

async function clearPriorOpenTickets(
  firmId: string,
  runId: string,
  stepNumber: number,
): Promise<void> {
  const db = getDb();
  await db
    .delete(remediationTickets)
    .where(
      and(
        eq(remediationTickets.firm_id, firmId),
        eq(remediationTickets.sop_run_id, runId),
        eq(remediationTickets.sop_step_number, stepNumber),
        inArray(remediationTickets.status, ['open', 'in_progress']),
      ),
    );
}

async function markRunAdvanced(runId: string, currentStep: number): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .update(sopStepStates)
    .set({ status: 'completed', started_at: now, completed_at: now })
    .where(
      and(
        eq(sopStepStates.sop_run_id, runId),
        eq(sopStepStates.step_number, currentStep),
      ),
    );
  await db
    .update(sopRuns)
    .set({
      current_step: currentStep + 1,
      status: 'awaiting_input',
      started_at: now,
    })
    .where(eq(sopRuns.id, runId));
}

/**
 * Roll up alignment + mention rate over an audit-run window.
 * Returns null if the window has zero audit runs.
 */
async function rollupWindow(
  firmId: string,
  start: Date,
  end: Date,
): Promise<{
  audits: number;
  greenRate: number;
  mentionRate: number;
  consensusTotal: number;
} | null> {
  const db = getDb();
  const runs = await db
    .select({ id: auditRuns.id })
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.firm_id, firmId),
        gte(auditRuns.started_at, start),
        lt(auditRuns.started_at, end),
      ),
    );
  if (runs.length === 0) return null;

  const qRows = await db
    .select({ id: queriesTable.id })
    .from(queriesTable)
    .where(
      inArray(
        queriesTable.audit_run_id,
        runs.map((r) => r.id),
      ),
    );
  if (qRows.length === 0)
    return { audits: runs.length, greenRate: 0, mentionRate: 0, consensusTotal: 0 };

  const crRows = await db
    .select({ id: consensusResponses.id, mentioned: consensusResponses.mentioned })
    .from(consensusResponses)
    .where(
      inArray(
        consensusResponses.query_id,
        qRows.map((q) => q.id),
      ),
    );
  if (crRows.length === 0)
    return { audits: runs.length, greenRate: 0, mentionRate: 0, consensusTotal: 0 };

  const consensusTotal = crRows.length;
  let mentioned = 0;
  for (const c of crRows) if (c.mentioned) mentioned += 1;

  const scoreRows = await db
    .select({ rag_label: alignmentScores.rag_label })
    .from(alignmentScores)
    .where(
      inArray(
        alignmentScores.consensus_response_id,
        crRows.map((c) => c.id),
      ),
    );
  let green = 0;
  let total = 0;
  for (const s of scoreRows) {
    total += 1;
    if (s.rag_label === 'green') green += 1;
  }
  return {
    audits: runs.length,
    greenRate: total > 0 ? green / total : 0,
    mentionRate: consensusTotal > 0 ? mentioned / consensusTotal : 0,
    consensusTotal,
  };
}

function buildGa4ConfigTicket(): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  return {
    title: 'Configure GA4 OAuth to enable LLM traffic tracking',
    description:
      'GA4 LLM Traffic Setup requires the firm to grant OAuth access to its GA4 property so the tool can read referrer + landing-page data segmented by LLM source (ChatGPT, Perplexity, Gemini, Claude). Until OAuth is wired, the SOP can\'t run.',
    remediationCopy: `**To enable GA4 LLM traffic tracking:**

1. Sign in to the firm's Google account that owns the GA4 property.
2. Go to Settings → Integrations → Google Analytics 4 in the Clixsy dashboard (when wired).
3. Grant read access to the relevant GA4 property.
4. Once connected, this scanner pulls the past 14 days of LLM-attributed traffic + segments it by source on every re-run.

**Why no automation is possible right now:**

GA4 access is per-property OAuth. There's no public-API fallback that exposes the same dimensions. The Admin API is the only path to programmatic GA4 access.

**Manual fallback until OAuth is wired:**

Operators can pull the same data manually from GA4 → Acquisition → Traffic acquisition, filtered by session source/medium matching the patterns documented in the SOP (chatgpt.com, perplexity.ai, gemini.google.com, claude.ai, you.com).`,
    validationSteps: [
      { description: 'Add GA4 OAuth integration to firm Settings' },
      { description: 'Authorize the GA4 property scope' },
      { description: 'Re-run Phase 2 scan' },
      { description: 'Confirm LLM traffic findings populate the execution-task list' },
    ],
  };
}

function buildAiBotConfigTicket(): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  return {
    title: 'Configure log destination to enable AI bot crawler analysis',
    description:
      'AI Bot Log File Analysis requires server-access logs streamed to a queryable destination so the tool can identify GPTBot, Claude-Web, PerplexityBot, etc. visits. Cloudflare Logpush and Vercel Log Drain are both supported; pick the one matching the firm\'s hosting stack. Until logs flow, the SOP can\'t run.',
    remediationCopy: `**To enable AI bot crawler analysis:**

**If hosted on Cloudflare:**
1. Go to Cloudflare → Analytics & Logs → Logpush.
2. Create a Logpush job pointing at a destination this tool can read (R2 + a webhook, or directly into our log-drain endpoint when wired).
3. Filter on user-agents matching the AI-bot patterns documented in the SOP.

**If hosted on Vercel:**
1. Go to Project → Settings → Log Drains.
2. Create a drain pointing at our log-ingest endpoint (when wired).

**Once log delivery is configured, this scanner detects:**

- Frequency of AI bot visits (GPTBot, Claude-Web, PerplexityBot, Google-Extended, FacebookBot, etc.)
- Which pages each bot crawls most often
- Blocked requests (signals robots.txt drift)
- 4xx/5xx errors hit by AI bots (LLM-trust-killer)

**Why no automation is possible right now:**

The tool has no read access to firm-side hosting logs. There's no API-driven path to grab them; the firm has to push them.

**Manual fallback:** Cloudflare and Vercel both expose recent logs in their UIs. Operators can manually check the past 14 days for AI-bot user-agent traffic and 4xx/5xx error rates while log delivery is being wired.`,
    validationSteps: [
      { description: 'Choose log destination (Cloudflare Logpush or Vercel Log Drain)' },
      { description: 'Configure delivery to the log-ingest endpoint' },
      { description: 'Re-run Phase 2 scan' },
      { description: 'Confirm AI bot findings populate the execution-task list' },
    ],
  };
}

function buildRegressionTicket(
  metric: 'alignment' | 'mention',
  current: number,
  prior: number,
): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  const delta = (current - prior) * 100;
  const dropAbs = -delta;
  const metricLabel = metric === 'alignment' ? 'Green-rate' : 'Mention rate';
  const target = metric === 'alignment' ? 'alignment scoring' : 'LLM mention frequency';
  const title = `${metricLabel} dropped ${dropAbs.toFixed(1)}pp week-over-week`;
  const description =
    `Bi-weekly LLM monitoring detected a regression in ${target}.\n\n` +
    `Past 14 days: ${(current * 100).toFixed(1)}%\n` +
    `Prior 14 days: ${(prior * 100).toFixed(1)}%\n` +
    `Delta: ${delta > 0 ? '+' : ''}${delta.toFixed(1)}pp\n\n` +
    `When ${metricLabel.toLowerCase()} drops more than ${metric === 'alignment' ? ALIGNMENT_REGRESSION_PCT : MENTION_REGRESSION_PCT}pp between consecutive 14-day windows, something has changed in the firm's positioning surface — either content drift, new competitor activity, or LLM model updates. Investigate this week.`;
  const remediationCopy = `**Investigation checklist:**

1. **Check recent content changes** — pull the LLM-Friendly + Freshness scanner outputs and look for pages that were modified between the prior window and now. A bad refresh can tank alignment site-wide.
2. **Check competitor share-of-voice** — the Competitive LLM Monitoring report shows whether a competitor has been gaining mentions in the same query set.
3. **Re-check Brand Truth** — was Brand Truth itself edited recently? A change in canonical positioning can shift alignment scoring even if no content moved.
4. **Check for LLM model updates** — major model releases (GPT-5, Claude 4, Gemini 3) shift citation patterns industry-wide. Track the release date against the regression date.

**Action depending on root cause:**
- Content drift → roll back the offending update, or run the LLM-Friendly Content Checklist scan on the affected pages.
- Competitor pressure → re-run Phase 4 to check for new entity divergence + golden-link gaps.
- Brand Truth change → confirm the intentional change is reflected on the rest of the site.
- Model update → log the date and re-baseline; no action needed if the regression is industry-wide.`;
  const validationSteps = [
    { description: 'Investigate the regression per the checklist' },
    { description: 'Document the root cause in the ticket' },
    { description: 'Run any remediation scans (LLM-Friendly, Freshness, Phase 4)' },
    { description: 'Re-check next bi-weekly scan to confirm metric recovered' },
  ];
  return { title, description, remediationCopy, validationSteps };
}

export async function runMeasurementTriageScan(
  firmId: string,
): Promise<MeasurementTriageResult> {
  const firm = await resolveFirm({ id: firmId });
  const now = new Date();
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const priorWindowEnd = windowStart;
  const priorWindowStart = new Date(windowStart.getTime() - WINDOW_DAYS * DAY_MS);

  // ── GA4 + AI Bot config-gate tickets (always emitted until creds wired) ──
  // Both classify as config_gate — prerequisites for site measurement,
  // not site-improvement tasks. priority_score = 0 keeps them out of
  // the main score-sorted queue; the UI renders them in a separate
  // "Prerequisites" strip when it wants.
  const ga4Priority = computePriority({ sourceType: 'sop', sopKey: SOP_GA4 });
  const aiBotPriority = computePriority({ sourceType: 'sop', sopKey: SOP_AI_BOT });

  const ga4RunId = await findOrCreateSopRun(firm.id, SOP_GA4);
  await clearPriorOpenTickets(firm.id, ga4RunId, TICKET_STEP_NUMBER);
  const ga4Payload = buildGa4ConfigTicket();
  await createTicketFromStep({
    firmSlug: firm.slug,
    sopKey: SOP_GA4,
    runId: ga4RunId,
    stepNumber: TICKET_STEP_NUMBER,
    title: ga4Payload.title,
    description: ga4Payload.description,
    priorityRank: 1,
    priorityClass: ga4Priority.priorityClass,
    priorityScore: ga4Priority.priorityScore,
    remediationCopy: ga4Payload.remediationCopy,
    validationSteps: ga4Payload.validationSteps,
    evidenceLinks: [],
    automationTier: 'manual',
    manualReason:
      'GA4 access is per-property OAuth. There\'s no public-API fallback that exposes the same dimensions. The Admin API is the only programmatic path.',
  });
  await markRunAdvanced(ga4RunId, TICKET_STEP_NUMBER);

  const aiBotRunId = await findOrCreateSopRun(firm.id, SOP_AI_BOT);
  await clearPriorOpenTickets(firm.id, aiBotRunId, TICKET_STEP_NUMBER);
  const aiBotPayload = buildAiBotConfigTicket();
  await createTicketFromStep({
    firmSlug: firm.slug,
    sopKey: SOP_AI_BOT,
    runId: aiBotRunId,
    stepNumber: TICKET_STEP_NUMBER,
    title: aiBotPayload.title,
    description: aiBotPayload.description,
    priorityRank: 1,
    priorityClass: aiBotPriority.priorityClass,
    priorityScore: aiBotPriority.priorityScore,
    remediationCopy: aiBotPayload.remediationCopy,
    validationSteps: aiBotPayload.validationSteps,
    evidenceLinks: [],
    automationTier: 'manual',
    manualReason:
      'No read access to firm-side hosting logs. Logs must be pushed via Cloudflare Logpush or Vercel Log Drain; there\'s no API-driven path to pull them.',
  });
  await markRunAdvanced(aiBotRunId, TICKET_STEP_NUMBER);

  // ── Bi-weekly LLM monitoring rollup ─────────────────────────────
  const biRunId = await findOrCreateSopRun(firm.id, SOP_BI_WEEKLY);
  await clearPriorOpenTickets(firm.id, biRunId, TICKET_STEP_NUMBER);

  const current = await rollupWindow(firm.id, windowStart, windowEnd);
  const prior = await rollupWindow(firm.id, priorWindowStart, priorWindowEnd);

  let regressionTickets = 0;

  // Bi-weekly tickets are trend/regression alerts, not site-improvement
  // findings. Classify as unknown for v1 — score 100, surfaces below
  // any actionable ticket. Refine to a real class once we settle on a
  // taxonomy for measurement-side alerts.
  const biWeeklyPriority = computePriority({ sourceType: 'sop', sopKey: SOP_BI_WEEKLY });

  if (!current) {
    // No audits in the current window — surface that as a finding.
    await createTicketFromStep({
      firmSlug: firm.slug,
      sopKey: SOP_BI_WEEKLY,
      runId: biRunId,
      stepNumber: TICKET_STEP_NUMBER,
      title: 'No audits in the past 14 days — bi-weekly monitoring needs fresh data',
      description: `Bi-weekly LLM monitoring rolls up alignment + mention metrics over the past 14 days vs the prior 14. The current window has zero audit runs, so there's nothing to roll up.\n\nWindow: ${windowStart.toISOString()} → ${windowEnd.toISOString()}\n\nQueue a Brand Visibility Audit run to repopulate.`,
      priorityRank: 1,
      priorityClass: biWeeklyPriority.priorityClass,
      priorityScore: biWeeklyPriority.priorityScore,
      remediationCopy:
        'Run a full Brand Visibility Audit (Phase 1) to populate the consensus_response + alignment_score tables. Bi-weekly monitoring re-runs automatically after audits land.',
      validationSteps: [
        { description: 'Run Brand Visibility Audit from Phase 1' },
        { description: 'Wait for the audit to complete' },
        { description: 'Re-run Phase 2 scan to recompute the rollup' },
      ],
      evidenceLinks: [],
      automationTier: 'assist',
      executeUrl: `/dashboard/${firm.slug}/audits`,
      executeLabel: 'Run audit',
    });
    regressionTickets += 1;
  } else if (prior) {
    // Both windows have data — check for regressions.
    const alignmentDelta = current.greenRate - prior.greenRate;
    const mentionDelta = current.mentionRate - prior.mentionRate;

    if (alignmentDelta < -ALIGNMENT_REGRESSION_PCT / 100) {
      const payload = buildRegressionTicket('alignment', current.greenRate, prior.greenRate);
      await createTicketFromStep({
        firmSlug: firm.slug,
        sopKey: SOP_BI_WEEKLY,
        runId: biRunId,
        stepNumber: TICKET_STEP_NUMBER,
        title: payload.title,
        description: payload.description,
        priorityRank: 1,
        priorityClass: biWeeklyPriority.priorityClass,
        priorityScore: biWeeklyPriority.priorityScore,
        remediationCopy: payload.remediationCopy,
        validationSteps: payload.validationSteps,
        evidenceLinks: [],
        automationTier: 'assist',
        executeUrl: `/dashboard/${firm.slug}/audits`,
        executeLabel: 'Investigate alignment trend',
      });
      regressionTickets += 1;
    }

    if (mentionDelta < -MENTION_REGRESSION_PCT / 100) {
      const payload = buildRegressionTicket('mention', current.mentionRate, prior.mentionRate);
      await createTicketFromStep({
        firmSlug: firm.slug,
        sopKey: SOP_BI_WEEKLY,
        runId: biRunId,
        stepNumber: TICKET_STEP_NUMBER,
        title: payload.title,
        description: payload.description,
        priorityRank: 2,
        priorityClass: biWeeklyPriority.priorityClass,
        priorityScore: biWeeklyPriority.priorityScore,
        remediationCopy: payload.remediationCopy,
        validationSteps: payload.validationSteps,
        evidenceLinks: [],
        automationTier: 'assist',
        executeUrl: `/dashboard/${firm.slug}/audits`,
        executeLabel: 'Investigate mention trend',
      });
      regressionTickets += 1;
    }
  }

  await markRunAdvanced(biRunId, TICKET_STEP_NUMBER);

  return {
    ga4Configured: false,
    aiBotConfigured: false,
    biWeeklyAuditsCurrent: current?.audits ?? 0,
    biWeeklyAuditsPrior: prior?.audits ?? 0,
    regressionFindings: regressionTickets,
    ticketsCreated: 2 + regressionTickets, // 2 config gates + regressions
  };
}

export async function runMeasurementTriageScanBySlug(
  firmSlug: string,
): Promise<MeasurementTriageResult> {
  const firm = await resolveFirm({ slug: firmSlug });
  return runMeasurementTriageScan(firm.id);
}
