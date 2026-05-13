/**
 * Weekly AEO Reporting scanner — Phase 7 SOP `weekly_aeo_reporting`.
 *
 * Different shape from the other scanners: instead of emitting many
 * per-finding tickets, this scanner produces *one* sop_deliverable
 * (the weekly report Markdown) plus *one* assist-tier "send to client"
 * ticket. The deliverable is the artifact; the ticket is the action.
 *
 * Per run:
 *   1. Find or create the weekly_aeo_reporting sop_run.
 *   2. Clear prior open "send" tickets from this run (re-runs replace).
 *   3. Build the WeeklyReportPayload (7-day window ending now).
 *   4. Render the payload to Markdown.
 *   5. Persist as sop_deliverable with kind='weekly_report_md'.
 *   6. Emit one assist-tier "Send weekly report to client" ticket.
 *   7. Schedule the next review per cadence (7 days).
 *
 * Re-runs replace the prior deliverable + the prior open send ticket
 * so the operator always sees one current report and one pending send
 * action.
 */

import {
  getDb,
  firms,
  sopRuns,
  sopStepStates,
  sopDeliverables,
  remediationTickets,
} from '@ai-edge/db';
import { and, eq, desc, inArray } from 'drizzle-orm';
import {
  buildWeeklyReport,
  renderWeeklyReportMarkdown,
  type WeeklyReportPayload,
} from '../reports/build-weekly-report';
import { createTicketFromStep } from '../../actions/sop-actions';
import { getSopDefinition } from '../sop/registry';
import { computePriority } from '../sop/priority-score';

const SOP_KEY = 'weekly_aeo_reporting' as const;
const SEND_STEP_NUMBER = 4; // Step 4 = Draft Report; we attach the "send" ticket here
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WeeklyReportingScanResult {
  runId: string;
  deliverableId: string;
  ticketId: string;
  windowStart: string;
  windowEnd: string;
  ticketsOpenedThisWeek: number;
  ticketsResolvedThisWeek: number;
  auditsThisWeek: number;
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
      created_by: 'scanner:weekly-reporting',
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

async function clearPriorOpenSendTickets(firmId: string, runId: string): Promise<void> {
  const db = getDb();
  await db
    .delete(remediationTickets)
    .where(
      and(
        eq(remediationTickets.firm_id, firmId),
        eq(remediationTickets.sop_run_id, runId),
        eq(remediationTickets.sop_step_number, SEND_STEP_NUMBER),
        inArray(remediationTickets.status, ['open', 'in_progress']),
      ),
    );
}

async function clearPriorWeeklyDeliverables(runId: string): Promise<void> {
  const db = getDb();
  await db
    .delete(sopDeliverables)
    .where(
      and(eq(sopDeliverables.sop_run_id, runId), eq(sopDeliverables.kind, 'weekly_report_md')),
    );
}

function buildSendTicket(payload: WeeklyReportPayload, firmName: string): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  const startDate = new Date(payload.window.start).toISOString().slice(0, 10);
  const endDate = new Date(payload.window.end).toISOString().slice(0, 10);

  const title = `Send weekly AEO report (${startDate} → ${endDate})`;
  const description = `The weekly report for ${firmName} is generated and ready to send.\n\nThis week:\n- ${payload.audits.total} audit${payload.audits.total === 1 ? '' : 's'}\n- ${payload.tickets.opened} new tasks · ${payload.tickets.resolved} resolved\n- ${payload.reddit.ingested} Reddit mention${payload.reddit.ingested === 1 ? '' : 's'}\n- $${payload.cost_usd.toFixed(2)} LLM spend\n\nReview the deliverable, customize the email, then send.`;
  const remediationCopy =
    `**The full weekly report is attached as a sop_deliverable on this run (kind: weekly_report_md).** Download it from the deliverables panel, paste into your email client (or your client portal), and send.\n\n**Suggested email subject:** \`[${firmName}] AEO Weekly — ${startDate} → ${endDate}\`\n\n**Suggested cadence:** Send by EOD Friday so clients see it before their weekly leadership reviews.\n\n**Once sent, mark this ticket resolved.** The scanner runs again next week and emits a new "Send" ticket on the next pass.`;
  const validationSteps = [
    { description: 'Review the weekly report deliverable for accuracy' },
    { description: 'Customize the email opening with any client-specific context' },
    { description: 'Send to the client email distribution list' },
    { description: 'Mark this ticket resolved' },
  ];

  return { title, description, remediationCopy, validationSteps };
}

export async function runWeeklyReportingScan(
  firmId: string,
): Promise<WeeklyReportingScanResult> {
  const db = getDb();
  const firm = await resolveFirm({ id: firmId });

  // Build the report payload + markdown.
  const payload = await buildWeeklyReport({ firmId: firm.id });
  const markdown = renderWeeklyReportMarkdown(payload, firm.name);

  // Run + deliverable + ticket lifecycle.
  const runId = await findOrCreateScannerRun(firm.id);
  await clearPriorOpenSendTickets(firm.id, runId);
  await clearPriorWeeklyDeliverables(runId);

  const [delivered] = await db
    .insert(sopDeliverables)
    .values({
      sop_run_id: runId,
      kind: 'weekly_report_md',
      name: `Weekly AEO Report — ${new Date(payload.window.start).toISOString().slice(0, 10)} → ${new Date(payload.window.end).toISOString().slice(0, 10)}`,
      payload: {
        markdown,
        summary: payload,
      } as Record<string, unknown>,
    })
    .returning({ id: sopDeliverables.id });
  const deliverableId = delivered!.id;

  const sendTicketPayload = buildSendTicket(payload, firm.name);
  // Weekly reporting "send the report" tickets are workflow-state, not
  // site-improvement. Defaults to unknown class with score 100.
  const sendPriority = computePriority({ sourceType: 'sop', sopKey: SOP_KEY });
  const ticket = await createTicketFromStep({
    firmSlug: firm.slug,
    sopKey: SOP_KEY,
    runId,
    stepNumber: SEND_STEP_NUMBER,
    title: sendTicketPayload.title,
    description: sendTicketPayload.description,
    priorityRank: 1,
    priorityClass: sendPriority.priorityClass,
    priorityScore: sendPriority.priorityScore,
    remediationCopy: sendTicketPayload.remediationCopy,
    validationSteps: sendTicketPayload.validationSteps,
    evidenceLinks: [],
    automationTier: 'assist',
    executeUrl: `/dashboard/${firm.slug}/sop/${SOP_KEY}`,
    executeLabel: 'Open weekly report',
  });

  // Mark scanner steps complete + schedule next-week review.
  const now = new Date();
  const def = getSopDefinition(SOP_KEY);
  for (const step of def.steps) {
    const targetStatus = step.number <= SEND_STEP_NUMBER ? 'completed' : 'not_started';
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
      current_step: SEND_STEP_NUMBER + 1,
      status: 'awaiting_input',
      started_at: now,
      next_review_at: new Date(Date.now() + 7 * DAY_MS),
    })
    .where(eq(sopRuns.id, runId));

  return {
    runId,
    deliverableId,
    ticketId: ticket.id,
    windowStart: payload.window.start,
    windowEnd: payload.window.end,
    ticketsOpenedThisWeek: payload.tickets.opened,
    ticketsResolvedThisWeek: payload.tickets.resolved,
    auditsThisWeek: payload.audits.total,
  };
}

export async function runWeeklyReportingScanBySlug(
  firmSlug: string,
): Promise<WeeklyReportingScanResult> {
  const firm = await resolveFirm({ slug: firmSlug });
  return runWeeklyReportingScan(firm.id);
}
