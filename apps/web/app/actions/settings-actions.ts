'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getDb, firms, firmBudgets } from '@ai-edge/db';
import { eq } from 'drizzle-orm';
import {
  getFirmBySlug,
  type FirmRow,
  type FirmType,
} from './firm-actions';
import {
  getFirmBudgetStatus,
  setFirmMonthlyCap,
  type FirmBudgetStatus,
} from '../lib/audit/budget';
import {
  getFirmMonthToDateBreakdown,
  getFirmTrailingYearBreakdown,
  type CostBreakdown,
} from '../lib/cost/telemetry';

/**
 * Server actions for the firm-level Settings page.
 *
 * Everything here is firm-scoped by slug — no cross-firm writes are
 * possible because the first thing every mutation does is resolve the slug
 * back to a firm and 404 if it doesn't exist.
 *
 * Kept separate from firm-actions.ts so we don't balloon the file the
 * overview page depends on. The overview uses the already-exported
 * `setFirmBudget` from firm-actions; the settings page uses the richer
 * bundle below.
 */

const FIRM_TYPES: ReadonlySet<FirmType> = new Set([
  'law_firm',
  'dental_practice',
  'marketing_agency',
  'other',
]);

export interface FirmSettingsBundle {
  firm: FirmRow;
  budget: FirmBudgetStatus;
  /** Operator note last saved alongside the cap. */
  budgetNote: string | null;
  monthToDate: CostBreakdown;
  trailingYear: CostBreakdown[];
}

/**
 * Full settings payload for the page. Shapes the firm row, current budget
 * status + note, MTD breakdown, and 12-month trend in one round trip.
 */
export async function getFirmSettings(
  slug: string,
): Promise<FirmSettingsBundle | null> {
  const firm = await getFirmBySlug(slug);
  if (!firm) return null;

  const db = getDb();
  const [budget, mtd, trailing, noteRows] = await Promise.all([
    getFirmBudgetStatus(firm.id),
    getFirmMonthToDateBreakdown(firm.id),
    getFirmTrailingYearBreakdown(firm.id),
    // We don't export a `getFirmBudgetNote`, so we select the note column
    // directly here — small enough that doing it at the action layer keeps
    // the budget module's public API focused on spend calculation.
    db
      .select({ note: firmBudgets.note })
      .from(firmBudgets)
      .where(eq(firmBudgets.firm_id, firm.id))
      .limit(1),
  ]);

  const budgetNote = noteRows[0]?.note ?? null;

  return {
    firm,
    budget,
    budgetNote,
    monthToDate: mtd,
    trailingYear: trailing,
  };
}

/**
 * Update the firm's display metadata. Slug is intentionally immutable —
 * changing it would break bookmarks, cron references, and any outbound
 * links the operator has shared. If they really need a new slug they can
 * delete + recreate, which surfaces the impact clearly.
 */
export async function updateFirmMetadata(
  slug: string,
  input: { name: string; firm_type: FirmType },
): Promise<{ ok: true; firm: FirmRow } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Client name is required' };
  if (!FIRM_TYPES.has(input.firm_type)) {
    return { ok: false, error: 'Invalid firm type' };
  }

  const firm = await getFirmBySlug(slug);
  if (!firm) return { ok: false, error: 'Firm not found' };

  const db = getDb();
  try {
    await db
      .update(firms)
      .set({ name, firm_type: input.firm_type })
      .where(eq(firms.id, firm.id));
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  revalidatePath(`/dashboard/${slug}`);
  revalidatePath(`/dashboard/${slug}/settings`);
  revalidatePath('/dashboard');

  return {
    ok: true,
    firm: { ...firm, name, firm_type: input.firm_type },
  };
}

/**
 * Upsert the firm's monthly spend cap + optional note. Passing `null` as
 * the cap deletes the override row (falls back to env default). Surfaces
 * a fresh FirmBudgetStatus so the page can re-render without a reload.
 */
export async function updateFirmBudget(
  slug: string,
  capUsd: number | null,
  note?: string | null,
): Promise<{ ok: true; budget: FirmBudgetStatus } | { ok: false; error: string }> {
  const firm = await getFirmBySlug(slug);
  if (!firm) return { ok: false, error: 'Firm not found' };
  try {
    await setFirmMonthlyCap(firm.id, capUsd, note ?? null);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  revalidatePath(`/dashboard/${slug}`);
  revalidatePath(`/dashboard/${slug}/settings`);
  return { ok: true, budget: await getFirmBudgetStatus(firm.id) };
}

/**
 * Permanently delete a firm + all its scoped data (audits, findings,
 * Brand Truth history, etc. — cascades are configured in the schema).
 * After deletion, redirect the operator back to the firm list.
 *
 * Requires the caller to pass the firm's current name as confirmation, to
 * prevent one-click misfires from the dashboard. This is a nuclear action
 * with no undo — the cascade fan-out wipes every table that references
 * firm_id, including paid-for audit history.
 */
export async function deleteFirm(
  slug: string,
  confirmationName: string,
): Promise<{ ok: false; error: string }> {
  const firm = await getFirmBySlug(slug);
  if (!firm) return { ok: false, error: 'Firm not found' };
  if (confirmationName.trim() !== firm.name) {
    return {
      ok: false,
      error: `Confirmation name didn't match. Type "${firm.name}" exactly to confirm.`,
    };
  }

  const db = getDb();
  await db.delete(firms).where(eq(firms.id, firm.id));
  revalidatePath('/dashboard');
  redirect('/dashboard');
  // Unreachable — `redirect()` throws — but keeps TS happy about the
  // declared return shape for the error branch above.
}
