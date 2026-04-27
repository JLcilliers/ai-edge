'use server';

import { getDb, firms } from '@ai-edge/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import {
  buildAuthorizeUrl,
  isOAuthConfigured,
  disconnectGsc,
} from '../lib/gsc/oauth';
import {
  getGscConnectionStatus,
  syncFirmGscMetrics,
  getRecentDailyMetrics,
} from '../lib/gsc/client';

/**
 * Server actions for the Search Console integration (Phase B #6).
 *
 * Surface area kept tight — three operator-facing flows:
 *   - Start the OAuth dance         → connectGsc(firmSlug)
 *   - Disconnect (revoke locally)   → disconnectGscConnection(firmSlug)
 *   - Trigger an ad-hoc sync        → triggerGscSync(firmSlug)
 *
 * Plus a read for the settings page → getGscStatus(firmSlug).
 */

async function resolveFirm(slug: string) {
  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id, slug: firms.slug })
    .from(firms)
    .where(eq(firms.slug, slug))
    .limit(1);
  if (!firm) throw new Error(`Firm not found: ${slug}`);
  return firm;
}

export interface GscStatusUi {
  oauthConfigured: boolean;
  connected: boolean;
  siteUrl: string | null;
  connectedAt: Date | null;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
  recentDays: number;
  totalClicks: number;
  totalImpressions: number;
}

export async function getGscStatus(firmSlug: string): Promise<GscStatusUi> {
  const firm = await resolveFirm(firmSlug);
  const oauthConfigured = isOAuthConfigured();
  const status = await getGscConnectionStatus(firm.id);
  let totalClicks = 0;
  let totalImpressions = 0;
  let recentDays = 0;
  if (status.connected) {
    const rows = await getRecentDailyMetrics(firm.id, 30);
    recentDays = rows.length;
    for (const r of rows) {
      totalClicks += r.clicks;
      totalImpressions += r.impressions;
    }
  }
  return {
    oauthConfigured,
    connected: status.connected,
    siteUrl: status.siteUrl,
    connectedAt: status.connectedAt,
    lastSyncedAt: status.lastSyncedAt,
    lastSyncError: status.lastSyncError,
    recentDays,
    totalClicks,
    totalImpressions,
  };
}

export async function connectGsc(
  firmSlug: string,
): Promise<{ ok: true; redirectUrl: string } | { ok: false; error: string }> {
  try {
    if (!isOAuthConfigured()) {
      return {
        ok: false,
        error:
          'OAuth not configured — set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI on Vercel.',
      };
    }
    // Resolve to verify the firm exists; the actual OAuth state is the slug.
    await resolveFirm(firmSlug);
    return { ok: true, redirectUrl: buildAuthorizeUrl(firmSlug) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function disconnectGscConnection(
  firmSlug: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const firm = await resolveFirm(firmSlug);
    await disconnectGsc(firm.id);
    revalidatePath(`/dashboard/${firmSlug}/settings`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function triggerGscSync(
  firmSlug: string,
): Promise<
  | { ok: true; rowsFetched: number }
  | { ok: false; error: string }
> {
  try {
    const firm = await resolveFirm(firmSlug);
    const r = await syncFirmGscMetrics(firm.id, { lookbackDays: 30 });
    revalidatePath(`/dashboard/${firmSlug}/settings`);
    if (!r.ok) return { ok: false, error: r.reason };
    return { ok: true, rowsFetched: r.rowsFetched };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
