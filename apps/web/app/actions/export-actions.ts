'use server';

/**
 * Export server actions — turn ticket data into client-deliverable
 * artifacts (.xlsx, audit delivery Markdown).
 *
 * Each action:
 *   1. Builds the artifact via lib/exports/* (handles Vercel Blob upload).
 *   2. Persists a sop_deliverable row with the blob URL + a summary payload.
 *   3. Returns the blob URL so the UI can offer an immediate download link.
 *
 * The sop_deliverable rows are anchored to the weekly_aeo_reporting
 * sop_run for the firm — that's the closest existing SOP that "owns"
 * client deliverables. (AEO Audit Delivery as a stand-alone scanner is
 * being retired per the paradigm-mismatch decision.)
 */

import { revalidatePath } from 'next/cache';
import {
  getDb,
  firms,
  sopRuns,
  sopStepStates,
  sopDeliverables,
} from '@ai-edge/db';
import { and, eq, desc } from 'drizzle-orm';
import { buildTicketsXlsx, type TicketsXlsxResult } from '../lib/exports/build-tickets-xlsx';
import { buildAuditDelivery, type AuditDeliveryResult } from '../lib/exports/build-audit-delivery';
import { getSopDefinition } from '../lib/sop/registry';

const DELIVERABLE_OWNER_SOP = 'weekly_aeo_reporting' as const;

interface FirmRow {
  id: string;
  slug: string;
  name: string;
}

async function resolveFirmBySlug(slug: string): Promise<FirmRow> {
  const db = getDb();
  const [f] = await db
    .select({ id: firms.id, slug: firms.slug, name: firms.name })
    .from(firms)
    .where(eq(firms.slug, slug))
    .limit(1);
  if (!f) throw new Error(`Firm not found: ${slug}`);
  return f;
}

/**
 * Find or seed a weekly_aeo_reporting sop_run for the firm. Exports
 * persist their `sop_deliverable` row anchored to this run so they
 * show up in the same deliverables panel as the weekly report itself.
 */
async function ensureDeliverableOwnerRun(firmId: string): Promise<string> {
  const db = getDb();
  const def = getSopDefinition(DELIVERABLE_OWNER_SOP);

  const [existing] = await db
    .select({ id: sopRuns.id, status: sopRuns.status })
    .from(sopRuns)
    .where(
      and(eq(sopRuns.firm_id, firmId), eq(sopRuns.sop_key, DELIVERABLE_OWNER_SOP)),
    )
    .orderBy(desc(sopRuns.created_at))
    .limit(1);
  if (existing && existing.status !== 'cancelled') return existing.id;

  const now = new Date();
  const [inserted] = await db
    .insert(sopRuns)
    .values({
      firm_id: firmId,
      sop_key: DELIVERABLE_OWNER_SOP,
      phase: def.phase,
      status: 'in_progress',
      current_step: 1,
      started_at: now,
      meta: { scanner_managed: true, source: 'export-actions' },
      created_by: 'export:owner-seed',
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

export interface TicketsXlsxResponse {
  ok: true;
  blobUrl: string | null;
  filename: string;
  totalTickets: number;
  ticketsByPhase: Record<number, number>;
}

export async function exportTicketsXlsx(
  firmSlug: string,
): Promise<TicketsXlsxResponse | { ok: false; error: string }> {
  try {
    const firm = await resolveFirmBySlug(firmSlug);
    const result: TicketsXlsxResult = await buildTicketsXlsx({
      firmId: firm.id,
      firmName: firm.name,
      generatedAt: new Date(),
    });

    const runId = await ensureDeliverableOwnerRun(firm.id);
    const db = getDb();
    await db.insert(sopDeliverables).values({
      sop_run_id: runId,
      // Reuse priority_actions_list kind for now — the existing
      // DeliverableKind type doesn't have a dedicated xlsx export key.
      // The payload.kind field below disambiguates inside the dashboard
      // deliverables panel.
      kind: 'priority_actions_list',
      name: `Open tickets export — ${result.filename}`,
      payload: {
        kind: 'tickets_xlsx',
        filename: result.filename,
        bytes: result.bytes,
        totalTickets: result.totalTickets,
        ticketsByPhase: result.ticketsByPhase,
      },
      blob_url: result.blobUrl,
    });

    try {
      revalidatePath(`/dashboard/${firmSlug}/tickets`);
      revalidatePath(`/dashboard/${firmSlug}/client-services`);
      revalidatePath(`/dashboard/${firmSlug}/sop/${DELIVERABLE_OWNER_SOP}`);
    } catch {
      /* not in a Next request context — safe to ignore */
    }

    return {
      ok: true,
      blobUrl: result.blobUrl,
      filename: result.filename,
      totalTickets: result.totalTickets,
      ticketsByPhase: result.ticketsByPhase,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface AuditDeliveryResponse {
  ok: true;
  blobUrl: string | null;
  filename: string;
  markdown: string;
  headlineFinding: string;
  ticketTotal: number;
}

export async function exportAuditDelivery(
  firmSlug: string,
): Promise<AuditDeliveryResponse | { ok: false; error: string }> {
  try {
    const firm = await resolveFirmBySlug(firmSlug);
    const result: AuditDeliveryResult = await buildAuditDelivery({
      firmId: firm.id,
      firmName: firm.name,
      generatedAt: new Date(),
    });

    const runId = await ensureDeliverableOwnerRun(firm.id);
    const db = getDb();
    await db.insert(sopDeliverables).values({
      sop_run_id: runId,
      kind: 'audit_delivery_pdf',
      name: `AEO Discovery Audit Delivery — ${result.filename}`,
      payload: {
        kind: 'audit_delivery_md',
        markdown: result.markdown,
        headlineFinding: result.headlineFinding,
        ticketTotal: result.ticketTotal,
        bytes: result.bytes,
      },
      blob_url: result.blobUrl,
    });

    try {
      revalidatePath(`/dashboard/${firmSlug}/tickets`);
      revalidatePath(`/dashboard/${firmSlug}/client-services`);
      revalidatePath(`/dashboard/${firmSlug}/sop/${DELIVERABLE_OWNER_SOP}`);
    } catch {
      /* not in a Next request context — safe to ignore */
    }

    return {
      ok: true,
      blobUrl: result.blobUrl,
      filename: result.filename,
      markdown: result.markdown,
      headlineFinding: result.headlineFinding,
      ticketTotal: result.ticketTotal,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
