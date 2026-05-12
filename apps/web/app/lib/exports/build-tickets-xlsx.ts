/**
 * Tickets .xlsx export — the single thing currently blocking client
 * delivery. 18 SOPs are emitting tickets to Postgres + the dashboard;
 * agencies need to hand the list to clients in a format they already
 * use (Excel / Google Sheets) without inviting them into the dashboard.
 *
 * Workbook shape:
 *   Sheet 1 "Summary"
 *     - Per-phase ticket counts
 *     - Per-tier counts (auto / assist / manual)
 *     - Per-status counts (open / in_progress / resolved / closed)
 *     - Top 10 priorities across all phases
 *
 *   Sheets 2-8 "Phase N — [Phase name]"
 *     One sheet per phase. Columns:
 *       Priority # | Title | SOP | Status | Tier | Execute URL |
 *       Owner | Due | Age (days) | Description | Manual reason
 *     Pre-filtered to open + in_progress only — closed tickets are
 *     historical noise on a client-facing deliverable.
 *
 *   Sheet 9 "All Open"
 *     Flat list of every open + in_progress ticket across all phases.
 *     Same columns as the per-phase sheets, plus a Phase column.
 *
 * Auto-fits column widths, applies header styling, freezes header row.
 * Persists to Vercel Blob (when configured) and returns the public URL.
 */

import ExcelJS from 'exceljs';
import { put } from '@vercel/blob';
import {
  getDb,
  firms,
  remediationTickets,
  sopRuns,
} from '@ai-edge/db';
import { and, eq, inArray, desc, asc } from 'drizzle-orm';
import { PHASES, SOP_REGISTRY } from '../sop/registry';

interface BuildArgs {
  firmId: string;
  firmName: string;
  generatedAt: Date;
}

export interface TicketsXlsxResult {
  filename: string;
  blobUrl: string | null;
  bytes: number;
  totalTickets: number;
  ticketsByPhase: Record<number, number>;
}

interface TicketRow {
  id: string;
  title: string;
  description: string | null;
  priorityRank: number | null;
  status: string;
  automationTier: 'auto' | 'assist' | 'manual' | null;
  executeUrl: string | null;
  manualReason: string | null;
  owner: string | null;
  dueAt: Date | null;
  createdAt: Date;
  phase: number;
  sopKey: string;
}

const OPEN_STATUSES = ['open', 'in_progress'] as const;
const HEADER_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF1F2937' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
const TIER_FILL: Record<string, { type: 'pattern'; pattern: 'solid'; fgColor: { argb: string } }> = {
  auto: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FADF' } },     // green tint
  assist: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } },   // yellow tint
  manual: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } },   // red tint
};

/** Pull open tickets joined with their sop_run to get phase + sop_key. */
async function loadOpenTickets(firmId: string): Promise<TicketRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: remediationTickets.id,
      title: remediationTickets.title,
      description: remediationTickets.description,
      priorityRank: remediationTickets.priority_rank,
      status: remediationTickets.status,
      automationTier: remediationTickets.automation_tier,
      executeUrl: remediationTickets.execute_url,
      manualReason: remediationTickets.manual_reason,
      owner: remediationTickets.owner,
      dueAt: remediationTickets.due_at,
      createdAt: remediationTickets.created_at,
      phase: sopRuns.phase,
      sopKey: sopRuns.sop_key,
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
    executeUrl: r.executeUrl,
    manualReason: r.manualReason,
    owner: r.owner,
    dueAt: r.dueAt,
    createdAt: r.createdAt,
    phase: r.phase,
    sopKey: r.sopKey,
  }));
}

function dayAge(createdAt: Date, now: Date): number {
  return Math.floor((now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000));
}

function applyHeader(worksheet: ExcelJS.Worksheet): void {
  const row = worksheet.getRow(1);
  row.font = HEADER_FONT;
  row.fill = HEADER_FILL;
  row.height = 24;
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function applyTierTint(worksheet: ExcelJS.Worksheet, tierColumn: string): void {
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const tier = String(row.getCell(tierColumn).value ?? '').toLowerCase();
    const fill = TIER_FILL[tier];
    if (fill) row.fill = fill;
    row.alignment = { wrapText: true, vertical: 'top' };
  });
}

function ticketColumnsForPhaseSheet(): Partial<ExcelJS.Column>[] {
  return [
    { header: '#', key: 'priority', width: 6 },
    { header: 'Title', key: 'title', width: 52 },
    { header: 'SOP', key: 'sop', width: 30 },
    { header: 'Status', key: 'status', width: 13 },
    { header: 'Tier', key: 'tier', width: 8 },
    { header: 'Execute URL', key: 'executeUrl', width: 50 },
    { header: 'Owner', key: 'owner', width: 18 },
    { header: 'Due', key: 'due', width: 12 },
    { header: 'Age (days)', key: 'age', width: 11 },
    { header: 'Description', key: 'description', width: 60 },
    { header: 'Manual reason', key: 'manualReason', width: 40 },
  ];
}

export async function buildTicketsXlsx(args: BuildArgs): Promise<TicketsXlsxResult> {
  const tickets = await loadOpenTickets(args.firmId);
  const now = args.generatedAt;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Clixsy Intercept';
  wb.created = now;

  // ── Summary sheet ───────────────────────────────────────────
  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: 'Metric', key: 'metric', width: 36 },
    { header: 'Value', key: 'value', width: 24 },
  ];
  applyHeader(summary);

  summary.addRow({ metric: 'Firm', value: args.firmName });
  summary.addRow({ metric: 'Generated at (UTC)', value: now.toISOString() });
  summary.addRow({ metric: 'Total open / in-progress tickets', value: tickets.length });
  summary.addRow({});

  // Per-phase counts.
  const phaseCounts: Record<number, number> = {};
  for (const t of tickets) phaseCounts[t.phase] = (phaseCounts[t.phase] ?? 0) + 1;
  summary.addRow({ metric: 'PHASE BREAKDOWN', value: '' }).font = { bold: true };
  for (const phase of PHASES) {
    summary.addRow({
      metric: `  Phase ${phase.phase} — ${phase.name}`,
      value: phaseCounts[phase.phase] ?? 0,
    });
  }
  summary.addRow({});

  // Per-tier counts.
  const tierCounts: Record<string, number> = { auto: 0, assist: 0, manual: 0, untagged: 0 };
  for (const t of tickets) {
    const k = t.automationTier ?? 'untagged';
    tierCounts[k] = (tierCounts[k] ?? 0) + 1;
  }
  summary.addRow({ metric: 'AUTOMATION TIER', value: '' }).font = { bold: true };
  summary.addRow({ metric: '  Auto (tool can fix)', value: tierCounts.auto });
  summary.addRow({ metric: '  Assist (operator pastes)', value: tierCounts.assist });
  summary.addRow({ metric: '  Manual (human-only)', value: tierCounts.manual });
  const untaggedCount = tierCounts.untagged ?? 0;
  if (untaggedCount > 0) {
    summary.addRow({ metric: '  Untagged (legacy)', value: untaggedCount });
  }
  summary.addRow({});

  // Status counts.
  const statusCounts: Record<string, number> = {};
  for (const t of tickets) statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
  summary.addRow({ metric: 'STATUS', value: '' }).font = { bold: true };
  for (const [s, n] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    summary.addRow({ metric: `  ${s}`, value: n });
  }
  summary.addRow({});

  // Top 10 priorities across all phases.
  summary.addRow({ metric: 'TOP 10 PRIORITIES (any phase)', value: '' }).font = { bold: true };
  const summaryPriorityRow = summary.getRow(summary.rowCount + 1);
  summaryPriorityRow.values = ['#', 'Title — SOP — Tier'];
  summaryPriorityRow.font = { bold: true };
  const topTen = [...tickets]
    .sort((a, b) => (a.priorityRank ?? Infinity) - (b.priorityRank ?? Infinity))
    .slice(0, 10);
  for (const t of topTen) {
    const sopName = SOP_REGISTRY[t.sopKey as keyof typeof SOP_REGISTRY]?.name ?? t.sopKey;
    summary.addRow({
      metric: `  #${t.priorityRank ?? '–'}`,
      value: `${t.title} — ${sopName} — ${t.automationTier ?? 'assist'}`,
    });
  }
  summary.eachRow((row) => {
    row.alignment = { wrapText: true, vertical: 'top' };
  });

  // ── Per-phase sheets ────────────────────────────────────────
  for (const phase of PHASES) {
    const phaseTickets = tickets.filter((t) => t.phase === phase.phase);
    const sheetName = `Phase ${phase.phase} — ${phase.name}`.slice(0, 31); // Excel limit
    const ws = wb.addWorksheet(sheetName);
    ws.columns = ticketColumnsForPhaseSheet();
    applyHeader(ws);

    if (phaseTickets.length === 0) {
      ws.addRow({
        priority: '',
        title: '(no open tickets for this phase)',
        sop: '',
        status: '',
        tier: '',
      });
      continue;
    }

    for (const t of phaseTickets) {
      const sopName = SOP_REGISTRY[t.sopKey as keyof typeof SOP_REGISTRY]?.name ?? t.sopKey;
      ws.addRow({
        priority: t.priorityRank,
        title: t.title,
        sop: sopName,
        status: t.status,
        tier: t.automationTier ?? '',
        executeUrl: t.executeUrl ?? '',
        owner: t.owner ?? '',
        due: t.dueAt ? t.dueAt.toISOString().slice(0, 10) : '',
        age: dayAge(t.createdAt, now),
        description: (t.description ?? '').slice(0, 500),
        manualReason: t.manualReason ?? '',
      });
    }
    applyTierTint(ws, 'tier');
  }

  // ── All Open sheet ──────────────────────────────────────────
  const all = wb.addWorksheet('All Open');
  all.columns = [
    { header: 'Phase', key: 'phase', width: 8 },
    ...ticketColumnsForPhaseSheet(),
  ];
  applyHeader(all);
  for (const t of tickets) {
    const sopName = SOP_REGISTRY[t.sopKey as keyof typeof SOP_REGISTRY]?.name ?? t.sopKey;
    all.addRow({
      phase: t.phase,
      priority: t.priorityRank,
      title: t.title,
      sop: sopName,
      status: t.status,
      tier: t.automationTier ?? '',
      executeUrl: t.executeUrl ?? '',
      owner: t.owner ?? '',
      due: t.dueAt ? t.dueAt.toISOString().slice(0, 10) : '',
      age: dayAge(t.createdAt, now),
      description: (t.description ?? '').slice(0, 500),
      manualReason: t.manualReason ?? '',
    });
  }
  applyTierTint(all, 'tier');

  // ── Serialize + upload ──────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const slug = args.firmName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const filename = `${slug}-tickets-${now.toISOString().slice(0, 10)}.xlsx`;

  let blobUrl: string | null = null;
  try {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const blob = await put(`exports/${filename}`, buffer as ArrayBuffer, {
        access: 'public',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        // Random suffix so re-exports don't 409 on the same filename.
        addRandomSuffix: true,
      });
      blobUrl = blob.url;
    }
  } catch (e) {
    console.error('[tickets-xlsx] blob upload failed:', e);
  }

  return {
    filename,
    blobUrl,
    bytes: (buffer as ArrayBuffer).byteLength,
    totalTickets: tickets.length,
    ticketsByPhase: phaseCounts,
  };
}
