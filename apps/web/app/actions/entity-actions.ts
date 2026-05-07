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
import { runCrossSourceScan, type CrossSourceOutcome } from '../lib/entity/cross-source-scan';
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

/**
 * Trigger a cross-source vector alignment + badge verification scan.
 * Synchronous (the scan itself batches embedding calls and returns
 * directly) — UI shows the outcome immediately rather than polling.
 */
export interface CrossSourceUiOutcome {
  sourcesScanned: number;
  sourcesFetched: number;
  sourcesAligned: number;
  sourcesDrifted: number;
  sourcesDivergent: number;
  awardsVerified: number;
  awardsUnverified: number;
  ticketsOpened: number;
  // Cap at 10 errors in the response — long lists bloat the action payload.
  sampleErrors: Array<{ url: string; error: string }>;
}

export async function startCrossSourceScan(
  firmSlug: string,
): Promise<CrossSourceUiOutcome | { error: string }> {
  try {
    const firmId = await resolveFirmId(firmSlug);
    const outcome = await runCrossSourceScan(firmId);
    revalidatePath(`/dashboard/${firmSlug}/entity`);
    revalidatePath(`/dashboard/${firmSlug}/tickets`);
    return {
      sourcesScanned: outcome.sourcesScanned,
      sourcesFetched: outcome.sourcesFetched,
      sourcesAligned: outcome.sourcesAligned,
      sourcesDrifted: outcome.sourcesDrifted,
      sourcesDivergent: outcome.sourcesDivergent,
      awardsVerified: outcome.awardsVerified,
      awardsUnverified: outcome.awardsUnverified,
      ticketsOpened: outcome.ticketsOpened,
      sampleErrors: outcome.errors.slice(0, 10),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Aggregated cross-source health for the UI: per-source row with the
 * latest scan's distance, alignment label, and (for awards) badge
 * verification status.
 */
export interface CrossSourceHealthRow {
  source: string;
  url: string | null;
  alignment: 'aligned' | 'drift' | 'divergent' | 'never_scanned';
  distance: number | null;
  badgeStatus: 'verified' | 'unverified' | 'not_applicable';
  awardName: string | null;
  scannedAt: Date | null;
}

export async function getCrossSourceHealth(
  firmSlug: string,
): Promise<CrossSourceHealthRow[]> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  const allRows = await db
    .select()
    .from(entitySignals)
    .where(eq(entitySignals.firm_id, firmId))
    .orderBy(desc(entitySignals.verified_at));

  // Cross-source signals are anything that's NOT one of the
  // single-source-per-firm types ('website', 'wikidata', 'google-kg').
  // Multiple rows per source over time — keep the latest per (source, url).
  const reservedSources = new Set(['website', 'wikidata', 'google-kg']);
  const seen = new Map<string, (typeof allRows)[number]>();
  for (const r of allRows) {
    if (reservedSources.has(r.source)) continue;
    const key = `${r.source}::${r.url ?? ''}`;
    if (!seen.has(key)) seen.set(key, r);
  }

  const out: CrossSourceHealthRow[] = [];
  for (const r of seen.values()) {
    const flags = (r.divergence_flags ?? []) as string[];
    let alignment: CrossSourceHealthRow['alignment'] = 'never_scanned';
    if (flags.includes('cross-source:divergent')) alignment = 'divergent';
    else if (flags.includes('cross-source:drift')) alignment = 'drift';
    else if (flags.includes('cross-source:aligned')) alignment = 'aligned';

    const distFlag = flags.find((f) => f.startsWith('distance:'));
    const distance = distFlag
      ? Number.parseFloat(distFlag.slice('distance:'.length))
      : null;

    let badgeStatus: CrossSourceHealthRow['badgeStatus'] = 'not_applicable';
    if (flags.includes('badge:verified')) badgeStatus = 'verified';
    else if (flags.includes('badge:unverified')) badgeStatus = 'unverified';

    const awardFlag = flags.find((f) => f.startsWith('award:'));
    const awardName = awardFlag ? awardFlag.slice('award:'.length) : null;

    out.push({
      source: r.source,
      url: r.url,
      alignment,
      distance: Number.isFinite(distance ?? NaN) ? distance : null,
      badgeStatus,
      awardName,
      scannedAt: r.verified_at,
    });
  }
  // Stable ordering: divergent first, then drift, then aligned.
  const order: Record<CrossSourceHealthRow['alignment'], number> = {
    divergent: 0,
    drift: 1,
    never_scanned: 2,
    aligned: 3,
  };
  out.sort((a, b) => order[a.alignment] - order[b.alignment]);
  return out;
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

  /**
   * Whether the latest scan could actually fetch the homepage. When
   * `fetch_blocked`, the schemaPresent / schemaMissingRequired arrays
   * are empty and meaningless — the UI should show "fetch blocked"
   * messaging instead of "you're missing Organization markup." Common
   * causes: WAF rejected our request (Cloudflare/Akamai/etc.),
   * geo-redirect to an unreachable region-locked site, or a network
   * failure between Vercel and the origin.
   */
  schemaFetchStatus:
    | { state: 'ok' }
    | { state: 'fetch_blocked'; httpStatus: string }
    | { state: 'never_scanned' };

  // Schema.org breakdown — present/missing arrays are populated only when
  // schemaFetchStatus.state === 'ok'.
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
      schemaFetchStatus: { state: 'never_scanned' },
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
  // Three terminal states:
  //   - never_scanned: no `entity_signals[source=website]` row exists yet.
  //   - fetch_blocked: the latest scan couldn't reach the homepage (WAF
  //     403, geo-block, network failure). present/missing arrays are
  //     empty — we never had a chance to look. The UI shows "homepage
  //     fetch blocked" rather than a fabricated list of missing types.
  //   - ok: latest scan succeeded; present/missing arrays are accurate.
  const required = EXPECTED_TYPES_BY_FIRM[firmType] ?? EXPECTED_TYPES_BY_FIRM.other;
  const present: string[] = [];
  const missingReq: string[] = [];
  const missingRec: string[] = [];
  let schemaFetchStatus: EntityHealth['schemaFetchStatus'] = { state: 'never_scanned' };

  if (websiteRow) {
    const flags = (websiteRow.divergence_flags ?? []) as string[];
    const blockedFlag = flags.find((f) => f.startsWith('schema:fetch_blocked:'));
    if (blockedFlag) {
      schemaFetchStatus = {
        state: 'fetch_blocked',
        httpStatus: blockedFlag.slice('schema:fetch_blocked:'.length),
      };
      // Keep present/missing arrays empty — anything we wrote here would
      // be a guess, and the UI specifically renders the fetch-blocked
      // state instead of the type-by-type breakdown.
    } else {
      schemaFetchStatus = { state: 'ok' };
      for (const f of flags) {
        if (f.startsWith('schema:present_')) present.push(f.slice('schema:present_'.length));
        else if (f.startsWith('schema:missing_'))
          missingReq.push(f.slice('schema:missing_'.length));
        else if (f.startsWith('schema:recommended_'))
          missingRec.push(f.slice('schema:recommended_'.length));
      }
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
    schemaFetchStatus,
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
