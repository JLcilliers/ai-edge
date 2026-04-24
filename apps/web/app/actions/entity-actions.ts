'use server';

import {
  getDb,
  firms,
  auditRuns,
  entitySignals,
  brandTruthVersions,
} from '@ai-edge/db';
import type { BrandTruth, FirmType } from '@ai-edge/shared';
import { eq, desc, and } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { runEntityScan } from '../lib/entity/scan';
import {
  EXPECTED_TYPES_BY_FIRM,
  RECOMMENDED_TYPES,
} from '../lib/entity/schema-scan';
import { generateJsonLdPatches, type JsonLdPatch } from '../lib/entity/jsonld-patches';

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

/** Start an entity scan; returns the auditRun id so the UI can poll. */
export async function startEntityScan(
  firmSlug: string,
): Promise<{ runId: string } | { error: string }> {
  try {
    const firmId = await resolveFirmId(firmSlug);
    const runId = await runEntityScan(firmId);
    revalidatePath(`/dashboard/${firmSlug}/entity`);
    return { runId };
  } catch (err) {
    return { error: String(err) };
  }
}

/** Poll status for an entity scan. */
export async function getEntityScanStatus(runId: string): Promise<{
  status: string;
  error: string | null;
}> {
  const db = getDb();
  const [run] = await db
    .select({ status: auditRuns.status, error: auditRuns.error })
    .from(auditRuns)
    .where(eq(auditRuns.id, runId))
    .limit(1);
  return run ?? { status: 'unknown', error: null };
}

/** Most recent entity scan audit_run (drives "last scanned" in the UI header). */
export async function getLatestEntityRun(firmSlug: string): Promise<{
  id: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
} | null> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  const [run] = await db
    .select({
      id: auditRuns.id,
      status: auditRuns.status,
      startedAt: auditRuns.started_at,
      finishedAt: auditRuns.finished_at,
      error: auditRuns.error,
    })
    .from(auditRuns)
    .where(and(eq(auditRuns.firm_id, firmId), eq(auditRuns.kind, 'entity')))
    .orderBy(desc(auditRuns.started_at))
    .limit(1);

  return run ?? null;
}

export type EntityHealth = {
  firmType: FirmType;
  siteUrl: string | null;

  // Schema.org breakdown
  schemaPresent: string[];
  schemaMissingRequired: string[];
  schemaMissingRecommended: string[];

  // Knowledge graph status
  wikidata: {
    status: 'present' | 'ambiguous' | 'missing' | 'error' | 'never_scanned';
    url: string | null;
    detail: string | null;
  };
  googleKg: {
    status: 'present' | 'missing' | 'skipped_no_key' | 'error' | 'never_scanned';
    url: string | null;
    detail: string | null;
  };

  // Fresh JSON-LD patches for gaps
  patches: JsonLdPatch[];
};

/**
 * The big read for the entity dashboard. Rather than making the UI
 * parse raw `divergence_flags` strings, we decode them here and return
 * a structured object plus ready-to-use JSON-LD patches.
 *
 * We re-derive the schema-patch recommendations from the LATEST signal
 * rows rather than re-running the scan — the scan itself is what writes
 * the rows, so this read is cheap and just translates state into UI shape.
 */
export async function getEntityHealth(firmSlug: string): Promise<EntityHealth> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  // Pull the firm's latest brand truth so we can type-class + generate patches.
  const [btv] = await db
    .select()
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);

  if (!btv) {
    // Render an empty shape — the UI shows "Set Brand Truth first" state.
    return {
      firmType: 'other',
      siteUrl: null,
      schemaPresent: [],
      schemaMissingRequired: [],
      schemaMissingRecommended: [],
      wikidata: { status: 'never_scanned', url: null, detail: null },
      googleKg: { status: 'never_scanned', url: null, detail: null },
      patches: [],
    };
  }

  const brandTruth = btv.payload as BrandTruth;
  const firmType = brandTruth.firm_type as FirmType;
  const bt = brandTruth as Record<string, unknown>;
  const siteUrl =
    [bt.primary_url, bt.website, bt.homepage_url].find(
      (v): v is string => typeof v === 'string' && /^https?:\/\//i.test(v),
    ) ?? null;

  // Pull the MOST RECENT signal row per source — a firm accumulates multiple
  // rows across runs, and we only want the latest picture.
  const allRows = await db
    .select()
    .from(entitySignals)
    .where(eq(entitySignals.firm_id, firmId))
    .orderBy(desc(entitySignals.verified_at));

  const latestBySource = new Map<string, (typeof allRows)[number]>();
  for (const r of allRows) {
    if (!latestBySource.has(r.source)) latestBySource.set(r.source, r);
  }

  const websiteRow = latestBySource.get('website');
  const wdRow = latestBySource.get('wikidata');
  const kgRow = latestBySource.get('google-kg');

  // ── Schema.org decode ──────────────────────────────────────
  const required = EXPECTED_TYPES_BY_FIRM[firmType] ?? EXPECTED_TYPES_BY_FIRM.other;
  const present: string[] = [];
  const missingReq: string[] = [];
  const missingRec: string[] = [];

  if (websiteRow) {
    const flags = (websiteRow.divergence_flags ?? []) as string[];
    for (const f of flags) {
      if (f.startsWith('schema:present_')) present.push(f.slice('schema:present_'.length));
      else if (f.startsWith('schema:missing_'))
        missingReq.push(f.slice('schema:missing_'.length));
      else if (f.startsWith('schema:recommended_'))
        missingRec.push(f.slice('schema:recommended_'.length));
    }
  } else {
    // Never scanned — everything expected is "missing"
    missingReq.push(...required);
    missingRec.push(...RECOMMENDED_TYPES);
  }

  // ── Wikidata decode ────────────────────────────────────────
  type KgStatus = 'present' | 'ambiguous' | 'missing' | 'error' | 'never_scanned';
  let wdStatus: KgStatus = 'never_scanned';
  let wdDetail: string | null = null;
  if (wdRow) {
    const flags = (wdRow.divergence_flags ?? []) as string[];
    if (flags.some((f) => f.startsWith('kg:present:'))) {
      wdStatus = 'present';
      const hit = flags.find((f) => f.startsWith('kg:present:'));
      wdDetail = hit?.slice('kg:present:'.length) ?? null;
    } else if (flags.some((f) => f.startsWith('kg:ambiguous:'))) {
      wdStatus = 'ambiguous';
      const hit = flags.find((f) => f.startsWith('kg:ambiguous:'));
      wdDetail = hit?.slice('kg:ambiguous:'.length) ?? null;
    } else if (flags.includes('kg:missing')) {
      wdStatus = 'missing';
    } else if (flags.some((f) => f.startsWith('error:'))) {
      wdStatus = 'error';
      wdDetail = flags.find((f) => f.startsWith('error:'))?.slice('error:'.length) ?? null;
    }
  }

  // ── Google KG decode ───────────────────────────────────────
  type GkStatus = 'present' | 'missing' | 'skipped_no_key' | 'error' | 'never_scanned';
  let gkStatus: GkStatus = 'never_scanned';
  let gkDetail: string | null = null;
  if (kgRow) {
    const flags = (kgRow.divergence_flags ?? []) as string[];
    if (flags.includes('kg:skipped_no_key')) {
      gkStatus = 'skipped_no_key';
    } else if (flags.some((f) => f.startsWith('kg:present:'))) {
      gkStatus = 'present';
      gkDetail =
        flags.find((f) => f.startsWith('kg:present:'))?.slice('kg:present:'.length) ?? null;
    } else if (flags.includes('kg:missing')) {
      gkStatus = 'missing';
    } else if (flags.some((f) => f.startsWith('error:'))) {
      gkStatus = 'error';
      gkDetail = flags.find((f) => f.startsWith('error:'))?.slice('error:'.length) ?? null;
    }
  }

  // ── Freshly-generated JSON-LD patches for gaps ────────────
  const patches = generateJsonLdPatches({
    brandTruth,
    firmType,
    siteUrl,
    missingTypes: missingReq,
  });

  return {
    firmType,
    siteUrl,
    schemaPresent: present,
    schemaMissingRequired: missingReq,
    schemaMissingRecommended: missingRec,
    wikidata: {
      status: wdStatus,
      url: wdRow?.url ?? null,
      detail: wdDetail,
    },
    googleKg: {
      status: gkStatus,
      url: kgRow?.url ?? null,
      detail: gkDetail,
    },
    patches,
  };
}
