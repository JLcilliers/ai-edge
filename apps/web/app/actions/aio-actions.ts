'use server';

import { getDb, firms } from '@ai-edge/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import {
  captureAioForFirm,
  listRecentAioCaptures,
  getAioProvider,
} from '../lib/aio/capture';

/**
 * Server actions for the AI Overview capture surface (Phase B #7).
 *
 * Two operator-facing flows:
 *   - triggerAioCapture(slug)  → manually run AIO capture for the firm's
 *                                 top seed_query_intents
 *   - listAioCaptures(slug)    → read for the visibility-tab AIO panel
 *
 * Plus getAioProviderName() so the UI can display "DataForSEO" /
 * "Playwright" / "none" alongside the captures.
 */

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

export interface AioCaptureUiOutcome {
  attempted: number;
  hasAio: number;
  firmCited: number;
  errors: number;
  provider: string;
  /**
   * `notConfigured` is true when no AIO provider is wired up (the resolver
   * returned `NullAioProvider`). The UI uses this to suppress the
   * "5 attempted / 5 errors" red banner and instead show a one-time
   * "AI Overviews capture isn't configured for this workspace — set
   * DATAFORSEO_LOGIN/PASSWORD in Vercel env to enable" hint. We return
   * `attempted=0` in this branch so the panel doesn't pretend captures
   * fired and the cron-health log doesn't record fake activity.
   */
  notConfigured: boolean;
  perQuery: Array<{
    query: string;
    ok: boolean;
    hasAio: boolean;
    firmCited: boolean;
    sourceCount: number;
    reason?: string;
  }>;
}

export async function triggerAioCapture(
  firmSlug: string,
  options: { maxQueries?: number } = {},
): Promise<AioCaptureUiOutcome> {
  const firmId = await resolveFirmId(firmSlug);
  const provider = getAioProvider();

  // Short-circuit when no provider is configured. Hitting captureAioForFirm
  // would write 5 throwaway `aio_capture` rows with raw={error:'No AIO
  // provider configured'} — pollutes the table and surfaces in the UI as a
  // generic "5 errors" red flag with no actionable explanation. Better to
  // tell the operator directly that AIO isn't wired up yet.
  if (provider.name === 'none') {
    return {
      attempted: 0,
      hasAio: 0,
      firmCited: 0,
      errors: 0,
      provider: provider.name,
      notConfigured: true,
      perQuery: [],
    };
  }

  const r = await captureAioForFirm(firmId, {
    maxQueries: options.maxQueries ?? 5,
    country: 'United States',
    language: 'English',
  });
  revalidatePath(`/dashboard/${firmSlug}/visibility`);
  return {
    attempted: r.attempted,
    hasAio: r.hasAio,
    firmCited: r.firmCited,
    errors: r.errors,
    provider: provider.name,
    notConfigured: false,
    perQuery: r.perQuery.map((p) => ({
      query: p.query,
      ok: p.outcome.ok,
      hasAio: p.outcome.hasAio,
      firmCited: p.outcome.firmCited,
      sourceCount: p.outcome.sourceCount,
      reason: p.outcome.reason,
    })),
  };
}

export interface AioCaptureRow {
  id: string;
  query: string;
  hasAio: boolean;
  firmCited: boolean;
  sourceCount: number;
  fetchedAt: Date;
  provider: string;
}

export async function listAioCaptures(firmSlug: string): Promise<AioCaptureRow[]> {
  const firmId = await resolveFirmId(firmSlug);
  return listRecentAioCaptures(firmId, 20);
}

export async function getAioProviderName(): Promise<string> {
  return getAioProvider().name;
}
