/**
 * Phase 4 (Third-Party Optimization) triage scanner.
 *
 * Phase 4 has three SOPs:
 *   - golden_links_opportunity_analysis  (needs Ahrefs API — out of scope)
 *   - entity_optimization                (covered by lib/entity/scan.ts)
 *   - reddit_brand_sentiment_monitoring  (covered by lib/reddit/scan.ts)
 *
 * The existing entity + reddit scanners write tickets directly to the
 * remediation_ticket table without a sop_run_id, so they don't surface
 * in the new Phase 4 page (which filters by sop_run.phase=4). This
 * scanner is a *triage pass* — it reads the existing data those
 * scanners already produced and emits scanner-style tickets attached
 * to the right sop_runs.
 *
 * It does NOT re-run the underlying entity or reddit scans. The
 * operator triggers those from the /entity and reddit triage pages
 * directly. This scanner's job is to surface the existing findings
 * inside the new phase-page-shell execution-task list and to seed the
 * sop_runs so the phase page can display per-SOP status pills.
 *
 * Per run:
 *   1. Resolve firm + ensure sop_runs exist for all 3 Phase 4 SOPs.
 *   2. Reddit pass:
 *        - Find open mentions with sentiment='complaint', karma >= 5,
 *          posted in the last 60 days. Top 30 by karma.
 *        - One assist-tier ticket each, executeUrl = reddit thread,
 *          executeLabel = "Open thread".
 *   3. Entity pass:
 *        - Find entity_signal rows with divergence_flags non-empty.
 *        - One assist-tier ticket each, executeUrl = platform admin
 *          URL where known, otherwise the source profile URL.
 *   4. Golden Links pass:
 *        - Create one manual-tier "config gate" ticket explaining
 *          that automated Golden Links analysis requires an Ahrefs
 *          API key in firm settings. Once the key is wired, the
 *          scanner will run the full analysis.
 *
 * Lifecycle matches the other scanners — idempotent over (firm × SOP),
 * clears prior open tickets on re-run, leaves runs in awaiting_input
 * so the operator ratifies.
 */

import {
  getDb,
  firms,
  sopRuns,
  sopStepStates,
  remediationTickets,
  redditMentions,
  entitySignals,
} from '@ai-edge/db';
import { and, eq, desc, inArray, gte, sql } from 'drizzle-orm';
import { createTicketFromStep } from '../../actions/sop-actions';
import { getSopDefinition } from '../sop/registry';
import type { SopKey } from '../sop/types';

const SOP_REDDIT = 'reddit_brand_sentiment_monitoring' as const;
const SOP_ENTITY = 'entity_optimization' as const;
const SOP_GOLDEN_LINKS = 'golden_links_opportunity_analysis' as const;

// Step the triage tickets attach to per SOP — the synthesis step
// where findings get reviewed.
const REDDIT_TRIAGE_STEP = 3; // Triage Mentions
const ENTITY_AUDIT_STEP = 2;  // Identify Entity Gaps
const GOLDEN_LINKS_STEP = 2;  // Analyze Competitor Link Profiles

const REDDIT_MIN_KARMA = 5;
const REDDIT_RECENT_DAYS = 60;
const REDDIT_MAX_TICKETS = 30;

const PLATFORM_ADMIN_URLS: Record<string, string> = {
  // Mapping from entity_signal.source values to platform admin URLs.
  // We use these as executeUrl so the operator clicks straight into
  // the right CMS for the listing they need to fix.
  bbb: 'https://www.bbb.org/get-listed',
  superlawyers: 'https://www.superlawyers.com/contact',
  avvo: 'https://support.avvo.com/hc/en-us/categories/4407466091789-Manage-Your-Profile',
  justia: 'https://www.justia.com/lawyers/',
  lawyers_com: 'https://www.lawyers.com/profile-claim',
  martindale: 'https://www.martindale.com/profile-claim',
  healthgrades: 'https://www.healthgrades.com/dms/jss/jsi',
  zocdoc: 'https://www.zocdoc.com/professionals',
  yelp: 'https://biz.yelp.com',
  clutch: 'https://clutch.co/profile/edit',
  g2: 'https://my.g2.com',
  gbp: 'https://business.google.com',
  linkedin: 'https://www.linkedin.com/help/linkedin/answer/a554362',
  crunchbase: 'https://www.crunchbase.com/profile/about',
  capterra: 'https://www.capterra.com/vendors',
  trustradius: 'https://www.trustradius.com/vendor-portal',
};

export interface ThirdPartyTriageResult {
  redditFindings: number;
  redditTicketsCreated: number;
  entityFindings: number;
  entityTicketsCreated: number;
  goldenLinksConfigured: boolean;
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
      created_by: 'scanner:third-party-triage',
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
        // Mark all steps up to and including currentStep as completed.
        // Drizzle doesn't have <= without sql template; we just update
        // the synthesis step status. The operator's ratification on
        // step 5/6 is what closes the workflow.
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

/** Build a triage ticket for one Reddit complaint mention. */
function buildRedditTicket(row: {
  url: string;
  subreddit: string;
  karma: number | null;
  text: string | null;
  postedAt: Date | null;
}): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  const snippet =
    row.text && row.text.length > 200 ? `${row.text.slice(0, 200)}…` : row.text ?? '';
  const title = `Reddit complaint: r/${row.subreddit} — review${row.karma ? ` (${row.karma} karma)` : ''}`;
  const description =
    `A complaint-classified Reddit mention was detected. Review and decide: engage, escalate to support, or dismiss as off-brand.\n\n` +
    `Thread: ${row.url}\n` +
    `Subreddit: r/${row.subreddit}\n` +
    `Karma: ${row.karma ?? 'unknown'}\n` +
    `Posted: ${row.postedAt?.toISOString() ?? 'unknown'}\n` +
    `Excerpt: ${snippet || '(empty selftext)'}`;
  const remediationCopy = `**Thread:** ${row.url}\n\n**Action options:**\n\n1. **Engage** — Reply to the thread if the complaint can be resolved publicly (refund, follow-up, clarification). Use the firm's verified Reddit account, never a sock-puppet.\n2. **Escalate** — Forward to support/legal if the complaint involves a real customer issue that needs internal action.\n3. **Dismiss** — If the mention is off-brand (wrong firm with similar name, satire, irrelevant context), update the triage status in the Reddit dashboard.\n\n**Mark the triage status in the Reddit dashboard once handled.** Open complaints leaking to LLMs influence the firm's overall sentiment surface.`;

  const validationSteps = [
    { description: 'Read the thread and surrounding context' },
    { description: 'Choose: engage / escalate / dismiss' },
    { description: 'Update triage status in the Reddit dashboard' },
    { description: 'Document the outcome in the ticket comment thread' },
  ];

  return { title, description, remediationCopy, validationSteps };
}

/** Build an entity-divergence ticket for one entity_signal row. */
function buildEntityTicket(row: {
  source: string;
  url: string | null;
  divergence_flags: string[];
}): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
  executeUrl: string | undefined;
} {
  const flags = (row.divergence_flags ?? []).slice(0, 5);
  const flagsLabel = flags.length > 0 ? flags.join(', ') : 'divergence';
  const title = `Entity drift on ${row.source}: ${flagsLabel}`;
  const description =
    `The cross-source scan detected divergence between ${row.source} and Brand Truth.\n\n` +
    `Source: ${row.source}\n` +
    `Source URL: ${row.url ?? 'unknown'}\n` +
    `Divergence flags: ${(row.divergence_flags ?? []).join(', ') || '(none)'}`;

  const adminUrl = PLATFORM_ADMIN_URLS[row.source.toLowerCase()] ?? row.url ?? undefined;

  const remediationCopy = `**Platform:** ${row.source}\n\n**Profile:** ${row.url ?? '(unknown)'}\n\n**Drift flags:** ${(row.divergence_flags ?? []).join(', ') || '(none)'}\n\n**Resolve:**\n\n1. Open the platform admin (link above).\n2. Compare the live listing against the current Brand Truth payload.\n3. Update the listing to match Brand Truth (firm name, NAP, primary description, primary URL).\n4. Save and re-run the entity scan to verify the divergence flag clears.`;

  const validationSteps = [
    { description: 'Open the platform admin URL' },
    { description: 'Compare live listing to Brand Truth' },
    { description: 'Update divergent fields' },
    { description: 'Re-run entity scan to confirm divergence cleared' },
  ];

  return { title, description, remediationCopy, validationSteps, executeUrl: adminUrl };
}

/** Build the manual-tier Golden Links config gate ticket. */
function buildGoldenLinksConfigTicket(): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  return {
    title: 'Configure Ahrefs API key to enable Golden Links analysis',
    description:
      'Golden Links Opportunity Analysis identifies high-authority publications that link to competitors but not to this firm. The full automated analysis requires an Ahrefs API key (paid tier) configured at the firm settings level.\n\nUntil the key is configured, the scanner can\'t run — there\'s no fallback data source for backlink profiles.',
    remediationCopy:
      `**To enable Golden Links automation:**\n\n1. Obtain an Ahrefs API key (Standard tier or higher).\n2. Add the key to firm Settings → Integrations → Ahrefs API.\n3. Re-run the Phase 4 scan.\n\n**Why no automation is possible without it:**\n\nGolden Links analysis requires:\n- Backlink profile of every direct competitor\n- Domain Rating (DR) lookups per linking domain\n- Anchor-text breakdown per linking domain\n\nAhrefs is the industry-standard data source for this. Moz, SEMrush, and Majestic alternatives are not currently wired.\n\n**Manual fallback:** If automation isn't possible right now, the SOP can still be executed manually using Ahrefs site explorer in a browser — but every linking domain has to be looked up by hand, which scales poorly past 10-20 candidates.`,
    validationSteps: [
      { description: 'Add Ahrefs API key to firm Settings' },
      { description: 'Re-run Phase 4 scan' },
      { description: 'Confirm Golden Links findings populate the execution-task list' },
    ],
  };
}

export async function runThirdPartyTriageScan(firmId: string): Promise<ThirdPartyTriageResult> {
  const db = getDb();
  const firm = await resolveFirm({ id: firmId });

  // ── Reddit pass ──────────────────────────────────────────────
  const cutoff = new Date(Date.now() - REDDIT_RECENT_DAYS * 24 * 60 * 60 * 1000);
  const redditRows = await db
    .select({
      id: redditMentions.id,
      url: redditMentions.url,
      subreddit: redditMentions.subreddit,
      karma: redditMentions.karma,
      text: redditMentions.text,
      postedAt: redditMentions.posted_at,
      triageStatus: redditMentions.triage_status,
      sentiment: redditMentions.sentiment,
    })
    .from(redditMentions)
    .where(
      and(
        eq(redditMentions.firm_id, firm.id),
        eq(redditMentions.sentiment, 'complaint'),
        eq(redditMentions.triage_status, 'open'),
        sql`COALESCE(${redditMentions.karma}, 0) >= ${REDDIT_MIN_KARMA}`,
        gte(redditMentions.ingested_at, cutoff),
      ),
    )
    .orderBy(desc(redditMentions.karma))
    .limit(REDDIT_MAX_TICKETS);

  const redditRunId = await findOrCreateSopRun(firm.id, SOP_REDDIT);
  await clearPriorOpenTickets(firm.id, redditRunId, REDDIT_TRIAGE_STEP);

  let priorityRank = 1;
  let redditTickets = 0;
  for (const r of redditRows) {
    const payload = buildRedditTicket({
      url: r.url,
      subreddit: r.subreddit,
      karma: r.karma,
      text: r.text,
      postedAt: r.postedAt,
    });
    await createTicketFromStep({
      firmSlug: firm.slug,
      sopKey: SOP_REDDIT,
      runId: redditRunId,
      stepNumber: REDDIT_TRIAGE_STEP,
      title: payload.title,
      description: payload.description,
      priorityRank: priorityRank++,
      remediationCopy: payload.remediationCopy,
      validationSteps: payload.validationSteps,
      evidenceLinks: [{ kind: 'reddit_thread', url: r.url, description: `r/${r.subreddit}` }],
      automationTier: 'assist',
      executeUrl: r.url,
      executeLabel: 'Open thread',
    });
    redditTickets += 1;
  }
  await markRunAdvanced(redditRunId, REDDIT_TRIAGE_STEP);

  // ── Entity pass ──────────────────────────────────────────────
  // Pull entity_signal rows for the firm where divergence_flags is non-empty.
  // jsonb_array_length on the column gives us a length filter that
  // works whether divergence_flags is null, [], or ['name', 'desc'].
  const entityRows = await db
    .select({
      id: entitySignals.id,
      source: entitySignals.source,
      url: entitySignals.url,
      divergence_flags: entitySignals.divergence_flags,
    })
    .from(entitySignals)
    .where(
      and(
        eq(entitySignals.firm_id, firm.id),
        sql`jsonb_array_length(coalesce(${entitySignals.divergence_flags}, '[]'::jsonb)) > 0`,
      ),
    );

  const entityRunId = await findOrCreateSopRun(firm.id, SOP_ENTITY);
  await clearPriorOpenTickets(firm.id, entityRunId, ENTITY_AUDIT_STEP);

  priorityRank = 1;
  let entityTickets = 0;
  for (const e of entityRows) {
    const payload = buildEntityTicket({
      source: e.source,
      url: e.url,
      divergence_flags: (e.divergence_flags ?? []) as string[],
    });
    await createTicketFromStep({
      firmSlug: firm.slug,
      sopKey: SOP_ENTITY,
      runId: entityRunId,
      stepNumber: ENTITY_AUDIT_STEP,
      title: payload.title,
      description: payload.description,
      priorityRank: priorityRank++,
      remediationCopy: payload.remediationCopy,
      validationSteps: payload.validationSteps,
      evidenceLinks: e.url
        ? [{ kind: 'third_party_listing', url: e.url, description: e.source }]
        : [],
      automationTier: 'assist',
      executeUrl: payload.executeUrl,
      executeLabel: payload.executeUrl ? `Open ${e.source} admin` : undefined,
    });
    entityTickets += 1;
  }
  await markRunAdvanced(entityRunId, ENTITY_AUDIT_STEP);

  // ── Golden Links pass (config gate) ──────────────────────────
  // Always seeds a single manual-tier ticket explaining the credential
  // gap. Once Ahrefs creds are wired, this gets replaced by a real
  // analysis output.
  const goldenRunId = await findOrCreateSopRun(firm.id, SOP_GOLDEN_LINKS);
  await clearPriorOpenTickets(firm.id, goldenRunId, GOLDEN_LINKS_STEP);
  const goldenPayload = buildGoldenLinksConfigTicket();
  await createTicketFromStep({
    firmSlug: firm.slug,
    sopKey: SOP_GOLDEN_LINKS,
    runId: goldenRunId,
    stepNumber: GOLDEN_LINKS_STEP,
    title: goldenPayload.title,
    description: goldenPayload.description,
    priorityRank: 1,
    remediationCopy: goldenPayload.remediationCopy,
    validationSteps: goldenPayload.validationSteps,
    evidenceLinks: [],
    automationTier: 'manual',
    manualReason:
      'Golden Links analysis requires an Ahrefs API key (Standard tier+). Without an authoritative backlink data source there is no fallback automation path — Moz, SEMrush, and Majestic adapters are not currently wired.',
  });
  await markRunAdvanced(goldenRunId, GOLDEN_LINKS_STEP);

  return {
    redditFindings: redditRows.length,
    redditTicketsCreated: redditTickets,
    entityFindings: entityRows.length,
    entityTicketsCreated: entityTickets,
    goldenLinksConfigured: false,
  };
}

export async function runThirdPartyTriageScanBySlug(
  firmSlug: string,
): Promise<ThirdPartyTriageResult> {
  const firm = await resolveFirm({ slug: firmSlug });
  return runThirdPartyTriageScan(firm.id);
}
