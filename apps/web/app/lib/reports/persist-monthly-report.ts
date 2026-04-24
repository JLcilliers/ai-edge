/**
 * Persist-and-blob pipeline for monthly reports.
 *
 * Writes the JSON payload to Vercel Blob (public access, so anyone with
 * the firm's dashboard can download without auth gymnastics — the tool
 * is internal-only per product decision 2026-04) and upserts a row in
 * `monthly_report` keyed by (firm_id, month_key).
 *
 * The upsert is done manually (select-then-update-or-insert) because the
 * neon-http driver does not pipeline the full `onConflictDoUpdate` path
 * cleanly in our version. Two round-trips for a monthly cron is fine.
 */

import { put } from '@vercel/blob';
import { getDb, monthlyReports, firms } from '@ai-edge/db';
import { eq, and } from 'drizzle-orm';
import {
  buildMonthlyReport,
  type MonthlyReportPayload,
} from './build-monthly-report';

export type PersistResult = {
  reportId: string;
  blobUrl: string | null;
  payload: MonthlyReportPayload;
};

function blobPathname(firmSlug: string, monthKey: string): string {
  return `reports/${firmSlug}/${monthKey}.json`;
}

async function tryPutBlob(
  firmSlug: string,
  monthKey: string,
  payload: MonthlyReportPayload,
): Promise<string | null> {
  // If BLOB_READ_WRITE_TOKEN isn't wired up, silently skip the Blob
  // write — we still persist the JSON payload in Postgres, so the
  // report is not lost. Operators can add the token later and the next
  // monthly run will populate blob_url.
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;

  const json = JSON.stringify(payload, null, 2);
  const { url } = await put(blobPathname(firmSlug, monthKey), json, {
    access: 'public',
    contentType: 'application/json',
    // Allow the same (firmSlug, monthKey) to overwrite cleanly on a
    // rebuild — Blob defaults to randomly suffixing duplicate paths.
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return url;
}

/**
 * Build the report, push the JSON to Blob, and upsert a row. Returns
 * the persisted id and the URL (if Blob is configured).
 */
export async function generateAndPersistMonthlyReport(params: {
  firmId: string;
  firmSlug: string;
  monthKey: string;
}): Promise<PersistResult> {
  const { firmId, firmSlug, monthKey } = params;

  const payload = await buildMonthlyReport({ firmId, monthKey });

  let blobUrl: string | null = null;
  try {
    blobUrl = await tryPutBlob(firmSlug, monthKey, payload);
  } catch (err) {
    // Blob write failed — log, persist to Postgres anyway.
    console.error('[monthly-report] blob write failed', err);
  }

  const db = getDb();
  const existing = await db
    .select({ id: monthlyReports.id })
    .from(monthlyReports)
    .where(
      and(
        eq(monthlyReports.firm_id, firmId),
        eq(monthlyReports.month_key, monthKey),
      ),
    )
    .limit(1);

  let reportId: string;
  if (existing[0]) {
    reportId = existing[0].id;
    await db
      .update(monthlyReports)
      .set({
        payload: payload as unknown as Record<string, unknown>,
        blob_url: blobUrl,
        generated_at: new Date(),
      })
      .where(eq(monthlyReports.id, reportId));
  } else {
    const [row] = await db
      .insert(monthlyReports)
      .values({
        firm_id: firmId,
        month_key: monthKey,
        payload: payload as unknown as Record<string, unknown>,
        blob_url: blobUrl,
      })
      .returning({ id: monthlyReports.id });
    reportId = row!.id;
  }

  return { reportId, blobUrl, payload };
}

/** Resolve firm id + slug from slug — shared helper for callers. */
export async function resolveFirmIdAndSlug(
  slug: string,
): Promise<{ id: string; slug: string } | null> {
  const db = getDb();
  const [row] = await db
    .select({ id: firms.id, slug: firms.slug })
    .from(firms)
    .where(eq(firms.slug, slug))
    .limit(1);
  return row ?? null;
}
