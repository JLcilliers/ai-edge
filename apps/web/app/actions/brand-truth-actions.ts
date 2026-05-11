'use server';

import { getDb, firms, brandTruthVersions } from '@ai-edge/db';
import { brandTruthSchema, type BrandTruth, type FirmType, validateClaims } from '@ai-edge/shared';
import { eq, desc, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { bootstrapBrandTruthFromUrl } from '../lib/brand-truth/bootstrap';

/** Resolve firm id from URL slug. Throws if the slug doesn't match a firm. */
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

// Get the latest Brand Truth version for a specific client.
export async function getLatestBrandTruth(firmSlug: string): Promise<{
  firmId: string;
  version: number;
  versionId: string;
  payload: BrandTruth;
  createdAt: Date;
} | null> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  const rows = await db
    .select()
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0]!;
  return {
    firmId,
    version: row.version,
    versionId: row.id,
    payload: row.payload as BrandTruth,
    createdAt: row.created_at,
  };
}

// Get all versions (for history sidebar).
export async function getBrandTruthVersions(
  firmSlug: string,
): Promise<Array<{ id: string; version: number; createdAt: Date }>> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  return db
    .select({
      id: brandTruthVersions.id,
      version: brandTruthVersions.version,
      createdAt: brandTruthVersions.created_at,
    })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version));
}

// Get a specific version by id. Version id is globally unique, no firm scope needed.
export async function getBrandTruthVersion(versionId: string): Promise<{
  version: number;
  payload: BrandTruth;
  createdAt: Date;
} | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.id, versionId))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    version: row.version,
    payload: row.payload as BrandTruth,
    createdAt: row.created_at,
  };
}

// Save a new Brand Truth version for a specific client.
export async function saveBrandTruth(
  firmSlug: string,
  rawPayload: unknown,
): Promise<
  | { success: true; version: number }
  | { success: false; error: string }
  | {
      success: false;
      error: string;
      complianceViolations: Array<{
        jurisdiction: string;
        match: string;
        reason: string;
      }>;
    }
> {
  // Validate against Zod schema
  const parsed = brandTruthSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return { success: false, error: parsed.error.message };
  }

  // Run compliance checks against the banned-claims rulebook
  const jurisdictions = parsed.data.compliance_jurisdictions ?? [];
  if (jurisdictions.length > 0) {
    // Check all text fields that could contain banned claims
    const textToCheck = [
      parsed.data.firm_name,
      ...(parsed.data.unique_differentiators ?? []),
      ...(parsed.data.required_positioning_phrases ?? []),
    ].join(' ');

    const hits = validateClaims(textToCheck, jurisdictions);
    if (hits.length > 0) {
      return {
        success: false,
        error: `Compliance violations found: ${hits.map((h) => h.match).join(', ')}`,
        complianceViolations: hits.map((h) => ({
          jurisdiction: h.jurisdiction,
          match: h.match,
          reason: h.pattern.reason,
        })),
      };
    }
  }

  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  // Get the next version number for this firm
  const maxVersionResult = await db
    .select({
      maxVersion: sql<number>`coalesce(max(${brandTruthVersions.version}), 0)`,
    })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId));

  const nextVersion = (maxVersionResult[0]?.maxVersion ?? 0) + 1;

  await db.insert(brandTruthVersions).values({
    firm_id: firmId,
    version: nextVersion,
    payload: parsed.data as any,
    created_by: 'dashboard',
  });

  return { success: true, version: nextVersion };
}

/**
 * Bootstrap a Brand Truth v1 for a freshly-created firm by scanning its
 * public website. Only writes a brand_truth_version row when:
 *   1. The firm has zero existing versions (we never overwrite operator
 *      edits — a re-bootstrap UX with diff/merge is v2).
 *   2. The bootstrap call returns a Zod-validated payload.
 *
 * Returns either the persisted version + provenance, or a structured
 * failure the UI can render to the operator.
 *
 * Cost: ~$0.20-0.40 per call (one Claude Sonnet 4.5 invocation with
 * scraped page content). Charged out-of-band — not against the firm's
 * monthly audit budget.
 *
 * Auth (future hardening): operator-only action. For now we trust the
 * caller because the broader dashboard has no auth wrapper yet.
 */
export async function bootstrapBrandTruthForFirm(
  firmSlug: string,
  primaryUrl: string,
): Promise<
  | { ok: true; version: number; costUsd: number; latencyMs: number; pagesUsed: string[] }
  | { ok: false; error: string; reason?: string }
> {
  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id, name: firms.name, firm_type: firms.firm_type })
    .from(firms)
    .where(eq(firms.slug, firmSlug))
    .limit(1);
  if (!firm) return { ok: false, error: `Firm not found: ${firmSlug}` };

  // Guard: refuse to bootstrap if the firm already has any brand_truth_version.
  // We don't want a stray bootstrap call to land a v2 that overwrites the
  // operator's deliberate edits. Re-bootstrap with diff/merge is v2.
  const existing = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firm.id));
  if ((existing[0]?.count ?? 0) > 0) {
    return {
      ok: false,
      error: 'Firm already has a Brand Truth version. Edit it manually in the editor.',
      reason: 'has_existing_version',
    };
  }

  // Surface URL validation here before paying for a Claude call. The
  // bootstrap module accepts any string and will crawl-fail loudly, but
  // we can fail faster client-side.
  let normalizedUrl: string;
  try {
    normalizedUrl = new URL(primaryUrl).toString();
  } catch {
    return { ok: false, error: 'primaryUrl is not a valid URL', reason: 'invalid_url' };
  }

  const result = await bootstrapBrandTruthFromUrl({
    firmName: firm.name,
    firmType: firm.firm_type as FirmType,
    primaryUrl: normalizedUrl,
  });

  if (!result.ok) {
    return { ok: false, error: result.reason, reason: result.reason };
  }

  // Persist as v1 with the bootstrap provenance attached. `created_by`
  // is tagged so the editor knows the version came from the bootstrap
  // path (and the operator's first Save creates v2 with `created_by:
  // 'dashboard'`).
  await db.insert(brandTruthVersions).values({
    firm_id: firm.id,
    version: 1,
    payload: result.payload as any,
    created_by: 'bootstrap',
    bootstrap_meta: {
      pagesScanned: result.provenance.pagesScanned,
      pagesUsed: result.provenance.pagesUsed,
      jsonLdTypesDetected: result.provenance.jsonLdTypesDetected,
      modelUsed: result.provenance.modelUsed,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
    },
  });

  // revalidatePath only works inside the Next.js request context — guard
  // so this action can also be invoked from Node scripts (integration
  // tests, manual cron triggers) without crashing the otherwise-successful
  // write.
  try {
    revalidatePath(`/dashboard/${firmSlug}/brand-truth`);
    revalidatePath(`/dashboard/${firmSlug}`);
  } catch {
    // Outside Next.js runtime — no-op, the page will re-fetch on next render.
  }

  return {
    ok: true,
    version: 1,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    pagesUsed: result.provenance.pagesUsed,
  };
}
