'use server';

import { getDb, firms, brandTruthVersions } from '@ai-edge/db';
import { brandTruthSchema, type BrandTruth, validateClaims } from '@ai-edge/shared';
import { eq, desc, sql } from 'drizzle-orm';

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
