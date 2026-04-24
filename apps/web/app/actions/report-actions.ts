'use server';

import { getDb, firms, monthlyReports } from '@ai-edge/db';
import { eq, and, desc } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import {
  generateAndPersistMonthlyReport,
} from '../lib/reports/persist-monthly-report';
import {
  previousMonthKey,
  monthKeyFromDate,
  type MonthlyReportPayload,
} from '../lib/reports/build-monthly-report';

async function resolveFirm(
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

export type ReportListItem = {
  id: string;
  monthKey: string;
  generatedAt: Date;
  blobUrl: string | null;
  /** Derived headline counts for the dashboard table — avoids rehydrating the whole payload. */
  audits: number;
  redditMentions: number;
  ragTotals: { red: number; yellow: number; green: number };
};

/** All persisted monthly reports for a firm, newest first. */
export async function listMonthlyReports(
  firmSlug: string,
): Promise<ReportListItem[]> {
  const firm = await resolveFirm(firmSlug);
  if (!firm) return [];

  const db = getDb();
  const rows = await db
    .select({
      id: monthlyReports.id,
      month_key: monthlyReports.month_key,
      generated_at: monthlyReports.generated_at,
      blob_url: monthlyReports.blob_url,
      payload: monthlyReports.payload,
    })
    .from(monthlyReports)
    .where(eq(monthlyReports.firm_id, firm.id))
    .orderBy(desc(monthlyReports.month_key));

  return rows.map((r) => {
    const p = r.payload as unknown as MonthlyReportPayload | null;
    return {
      id: r.id,
      monthKey: r.month_key,
      generatedAt: r.generated_at,
      blobUrl: r.blob_url,
      audits: p?.audits.total ?? 0,
      redditMentions: p?.reddit.total_mentions ?? 0,
      ragTotals: p?.audits.rag_totals ?? { red: 0, yellow: 0, green: 0 },
    };
  });
}

/** Full payload for a single report. */
export async function getMonthlyReport(
  firmSlug: string,
  monthKey: string,
): Promise<MonthlyReportPayload | null> {
  const firm = await resolveFirm(firmSlug);
  if (!firm) return null;
  const db = getDb();
  const [row] = await db
    .select({ payload: monthlyReports.payload })
    .from(monthlyReports)
    .where(
      and(
        eq(monthlyReports.firm_id, firm.id),
        eq(monthlyReports.month_key, monthKey),
      ),
    )
    .limit(1);
  return (row?.payload as unknown as MonthlyReportPayload) ?? null;
}

/**
 * Metadata summary for the dashboard tile — latest report + previous
 * month's status so the overview can show "March report ready" vs
 * "Generate March report".
 */
export type ReportTileSummary = {
  firmSlug: string;
  latest: ReportListItem | null;
  previousMonthKey: string; // always the most-recently-closed month
  previousMonthHasReport: boolean;
};

export async function getReportTileSummary(
  firmSlug: string,
): Promise<ReportTileSummary | null> {
  const firm = await resolveFirm(firmSlug);
  if (!firm) return null;

  const db = getDb();
  const [latest] = await db
    .select({
      id: monthlyReports.id,
      month_key: monthlyReports.month_key,
      generated_at: monthlyReports.generated_at,
      blob_url: monthlyReports.blob_url,
      payload: monthlyReports.payload,
    })
    .from(monthlyReports)
    .where(eq(monthlyReports.firm_id, firm.id))
    .orderBy(desc(monthlyReports.month_key))
    .limit(1);

  const prevKey = previousMonthKey(new Date());

  let latestItem: ReportListItem | null = null;
  if (latest) {
    const p = latest.payload as unknown as MonthlyReportPayload | null;
    latestItem = {
      id: latest.id,
      monthKey: latest.month_key,
      generatedAt: latest.generated_at,
      blobUrl: latest.blob_url,
      audits: p?.audits.total ?? 0,
      redditMentions: p?.reddit.total_mentions ?? 0,
      ragTotals: p?.audits.rag_totals ?? { red: 0, yellow: 0, green: 0 },
    };
  }

  return {
    firmSlug,
    latest: latestItem,
    previousMonthKey: prevKey,
    previousMonthHasReport: latestItem?.monthKey === prevKey,
  };
}

/**
 * Manual rebuild — used by the dashboard "Generate report" button. Lets
 * operators backfill missing months without waiting for the cron to
 * fire on the 1st.
 */
export async function rebuildMonthlyReport(
  firmSlug: string,
  monthKeyOverride?: string,
): Promise<
  | { ok: true; reportId: string; blobUrl: string | null; monthKey: string }
  | { ok: false; error: string }
> {
  const firm = await resolveFirm(firmSlug);
  if (!firm) return { ok: false, error: 'Firm not found' };

  const monthKey =
    monthKeyOverride && /^\d{4}-\d{2}$/.test(monthKeyOverride)
      ? monthKeyOverride
      : previousMonthKey(new Date());

  try {
    const { reportId, blobUrl } = await generateAndPersistMonthlyReport({
      firmId: firm.id,
      firmSlug: firm.slug,
      monthKey,
    });
    revalidatePath(`/dashboard/${firmSlug}`);
    revalidatePath(`/dashboard/${firmSlug}/reports`);
    return { ok: true, reportId, blobUrl, monthKey };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Convenience: current calendar month key (UTC). */
export async function currentMonthKey(): Promise<string> {
  return monthKeyFromDate(new Date());
}
