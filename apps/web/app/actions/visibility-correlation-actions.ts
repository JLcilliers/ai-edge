'use server';

import {
  getDb,
  firms,
  gscDailyMetrics,
  gscConnections,
  aioCaptures,
} from '@ai-edge/db';
import { eq, and, gte } from 'drizzle-orm';

/**
 * Visibility correlation read API (Phase B #6 visualization layer).
 *
 * The canonical Phase B framing: "did Google AI Overviews eat our
 * organic clicks?" To answer that, the operator needs to see organic-
 * search behavior (GSC clicks/impressions over time) and AIO panel
 * behavior (when did Google start showing AIO for our queries; when
 * did it cite us; when did it stop) on the same timeline.
 *
 * Data sources
 * ------------
 *   gsc_daily_metric  — one row per (firm, date), populated by the
 *                       gsc-sync cron. Dense daily signal across the
 *                       last 30+ days (when GSC is connected).
 *   aio_capture       — one row per (firm, query) capture event,
 *                       populated by the aio-capture cron + manual
 *                       triggers. Sparse (typically weekly per firm)
 *                       so we aggregate to per-day buckets.
 *
 * Output shape
 * ------------
 * Per-day rows over the requested window:
 *   { date,
 *     clicks, impressions, ctr, position,    // GSC daily
 *     aioCaptureCount,                        // # captures that day
 *     aioTriggeredCount,                      // # captures with has_aio=true
 *     aioFirmCitedCount }                     // # captures with firm_cited=true
 *
 * The UI plots `clicks` as a daily line and overlays AIO markers on
 * the days where captures occurred. When data is missing on a side
 * (no GSC connection / no AIO captures), the corresponding fields
 * are 0 and the UI renders an honest "this side isn't connected yet"
 * panel.
 */

export interface CorrelationDailyRow {
  date: string; // YYYY-MM-DD
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  aioCaptureCount: number;
  aioTriggeredCount: number;
  aioFirmCitedCount: number;
}

export interface VisibilityCorrelation {
  daysRequested: number;
  daysWithData: number;
  // Connection presence so the UI knows what to render.
  gscConnected: boolean;
  hasAioCaptures: boolean;
  // Aggregates over the window so the UI can show "30d totals" tiles
  // without re-summing on the client.
  totalClicks: number;
  totalImpressions: number;
  avgCtr: number | null;        // weighted by impressions
  avgPosition: number | null;    // weighted by impressions
  totalAioCaptures: number;
  totalAioTriggered: number;
  totalAioFirmCited: number;
  // Per-day rows, oldest → newest so the chart x-axis sweeps left → right.
  daily: CorrelationDailyRow[];
}

async function resolveFirmId(slug: string): Promise<string> {
  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id })
    .from(firms)
    .where(eq(firms.slug, slug))
    .limit(1);
  if (!firm) throw new Error(`Firm not found: ${slug}`);
  return firm.id;
}

function dateOnlyUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getVisibilityCorrelation(
  firmSlug: string,
  daysBack: number = 30,
): Promise<VisibilityCorrelation> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  // Window bounds. We use UTC midnight as the day boundary because GSC
  // daily aggregates are UTC and the AIO capture timestamps are server-
  // time (also UTC on Vercel/Neon). Timezone alignment matters here —
  // mixing local and UTC produces off-by-one bucketing.
  const windowEnd = new Date();
  const windowStart = new Date();
  windowStart.setUTCDate(windowEnd.getUTCDate() - daysBack);
  windowStart.setUTCHours(0, 0, 0, 0);
  const startStr = dateOnlyUtc(windowStart);

  // ── GSC connection presence ────────────────────────────────
  const [gscRow] = await db
    .select({ id: gscConnections.firm_id })
    .from(gscConnections)
    .where(eq(gscConnections.firm_id, firmId))
    .limit(1);
  const gscConnected = !!gscRow;

  // ── GSC daily metrics in window ────────────────────────────
  const gscRows = gscConnected
    ? await db
        .select()
        .from(gscDailyMetrics)
        .where(
          and(
            eq(gscDailyMetrics.firm_id, firmId),
            gte(gscDailyMetrics.date, startStr),
          ),
        )
    : [];
  const gscByDate = new Map<string, (typeof gscRows)[number]>();
  for (const r of gscRows) gscByDate.set(r.date, r);

  // ── AIO captures in window ─────────────────────────────────
  const aioRows = await db
    .select({
      fetchedAt: aioCaptures.fetched_at,
      hasAio: aioCaptures.has_aio,
      firmCited: aioCaptures.firm_cited,
    })
    .from(aioCaptures)
    .where(
      and(
        eq(aioCaptures.firm_id, firmId),
        gte(aioCaptures.fetched_at, windowStart),
      ),
    );
  // Bucket per UTC date.
  const aioByDate = new Map<
    string,
    { count: number; triggered: number; firmCited: number }
  >();
  for (const r of aioRows) {
    const date = dateOnlyUtc(new Date(r.fetchedAt));
    const bucket =
      aioByDate.get(date) ?? { count: 0, triggered: 0, firmCited: 0 };
    bucket.count += 1;
    if (r.hasAio) bucket.triggered += 1;
    if (r.firmCited) bucket.firmCited += 1;
    aioByDate.set(date, bucket);
  }
  const hasAioCaptures = aioRows.length > 0;

  // ── Build per-day rows from earliest → latest ──────────────
  const daily: CorrelationDailyRow[] = [];
  const cursor = new Date(windowStart);
  while (cursor <= windowEnd) {
    const date = dateOnlyUtc(cursor);
    const g = gscByDate.get(date);
    const a = aioByDate.get(date);
    daily.push({
      date,
      clicks: g?.clicks ?? 0,
      impressions: g?.impressions ?? 0,
      ctr: g?.ctr ?? null,
      position: g?.position ?? null,
      aioCaptureCount: a?.count ?? 0,
      aioTriggeredCount: a?.triggered ?? 0,
      aioFirmCitedCount: a?.firmCited ?? 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // ── Aggregates ─────────────────────────────────────────────
  let totalClicks = 0;
  let totalImpressions = 0;
  let weightedCtrSum = 0;
  let weightedPositionSum = 0;
  let totalAioCaptures = 0;
  let totalAioTriggered = 0;
  let totalAioFirmCited = 0;
  let daysWithData = 0;
  for (const d of daily) {
    if (
      d.clicks > 0 ||
      d.impressions > 0 ||
      d.aioCaptureCount > 0
    ) {
      daysWithData += 1;
    }
    totalClicks += d.clicks;
    totalImpressions += d.impressions;
    if (d.impressions > 0) {
      if (d.ctr != null) weightedCtrSum += d.ctr * d.impressions;
      if (d.position != null) weightedPositionSum += d.position * d.impressions;
    }
    totalAioCaptures += d.aioCaptureCount;
    totalAioTriggered += d.aioTriggeredCount;
    totalAioFirmCited += d.aioFirmCitedCount;
  }
  const avgCtr =
    totalImpressions > 0 ? weightedCtrSum / totalImpressions : null;
  const avgPosition =
    totalImpressions > 0 ? weightedPositionSum / totalImpressions : null;

  return {
    daysRequested: daysBack,
    daysWithData,
    gscConnected,
    hasAioCaptures,
    totalClicks,
    totalImpressions,
    avgCtr,
    avgPosition,
    totalAioCaptures,
    totalAioTriggered,
    totalAioFirmCited,
    daily,
  };
}
