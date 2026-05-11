'use server';

import { getDb, firms, brandTruthVersions } from '@ai-edge/db';
import { brandTruthSchema, type BrandTruth, type FirmType, validateClaims } from '@ai-edge/shared';
import { eq, desc, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { bootstrapBrandTruthFromUrl } from '../lib/brand-truth/bootstrap';
import { runSuppressionScan } from '../lib/suppression/scan';
import { runEntityScan } from '../lib/entity/scan';
import { captureAioForFirm } from '../lib/aio/capture';

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
/**
 * Summary of post-bootstrap enrichment scan outcomes. Each scan can succeed,
 * fail, or skip — we report all three so the caller can render a banner
 * showing what's already populated when the operator lands in the editor.
 *
 * None of these blocking the redirect — partial enrichment is fine. If
 * suppression times out on a WAF or the AIO provider isn't configured,
 * the bootstrap still succeeds and the operator gets a populated Brand Truth.
 */
export interface PostBootstrapEnrichment {
  suppression:
    | { status: 'completed'; findingsCount: number; pagesEmbedded: number; runId: string }
    | { status: 'failed'; reason: string }
    | { status: 'skipped'; reason: string };
  entity:
    | { status: 'completed'; sourcesCount: number; runId: string }
    | { status: 'failed'; reason: string };
  aio:
    | { status: 'completed'; attempted: number; hasAio: number; firmCited: number }
    | { status: 'skipped'; reason: string };
}

export async function bootstrapBrandTruthForFirm(
  firmSlug: string,
  primaryUrl: string,
): Promise<
  | {
      ok: true;
      version: number;
      costUsd: number;
      latencyMs: number;
      pagesUsed: string[];
      enrichment: PostBootstrapEnrichment;
    }
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

  // ── Post-bootstrap enrichment scans ──────────────────────────────────
  // Now that the Brand Truth is persisted, kick off the three scans that
  // depend on it. Running them here (vs leaving them as on-demand buttons)
  // means a freshly-bootstrapped firm lands in the editor with real data
  // on EVERY module — Suppression, Entity, AIO captures, monthly report —
  // instead of empty "no scans yet" placeholders.
  //
  // What's chained:
  //   • Suppression scan — crawls site, embeds pages, flags drift findings.
  //     Cost: <$0.01 (embeddings only). Wall-clock: 30-90s depending on
  //     sitemap size. Capped at 15 URLs.
  //   • Entity scan — JSON-LD fetch + Wikidata + Google KG probes.
  //     Cost: $0. Wall-clock: ~5s.
  //   • AIO capture — 3 queries through DataForSEO (or NullAioProvider if
  //     unconfigured). Cost: ~$0.015 with provider, $0 without.
  //
  // What's NOT chained: the Trust Alignment Audit. It's $0.05-0.10 per run
  // and benefits from operator review of the Brand Truth first — so we
  // leave it as a manual "Run audit" click on the audits page.
  //
  // All three run in parallel via Promise.allSettled — independent modules,
  // each writes to its own tables, no shared in-memory state. Failures are
  // captured per-module so the operator sees what populated vs what didn't.
  //
  // Total wall-clock for the chain: max(suppression, entity, AIO) ~= 90s.
  // Together with the bootstrap call (~20-30s), the full new-client flow
  // takes ~2 minutes and fits comfortably under the page's maxDuration=300s.
  const enrichment = await runPostBootstrapEnrichment(firm.id);

  // revalidatePath only works inside the Next.js request context — guard
  // so this action can also be invoked from Node scripts (integration
  // tests, manual cron triggers) without crashing the otherwise-successful
  // write.
  try {
    revalidatePath(`/dashboard/${firmSlug}/brand-truth`);
    revalidatePath(`/dashboard/${firmSlug}`);
    revalidatePath(`/dashboard/${firmSlug}/suppression`);
    revalidatePath(`/dashboard/${firmSlug}/entity`);
    revalidatePath(`/dashboard/${firmSlug}/visibility`);
  } catch {
    // Outside Next.js runtime — no-op, the page will re-fetch on next render.
  }

  return {
    ok: true,
    version: 1,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    pagesUsed: result.provenance.pagesUsed,
    enrichment,
  };
}

/**
 * Fire the three enrichment scans in parallel and structure their outcomes
 * so the caller can render a "what's already populated" banner.
 *
 * Why Promise.allSettled (not Promise.all): if one scan throws — say the
 * site is WAF-blocked and suppression can't crawl it — we still want the
 * other two scans to write their rows. Promise.all would abort the whole
 * batch on first throw; allSettled lets each module fail independently.
 */
async function runPostBootstrapEnrichment(
  firmId: string,
): Promise<PostBootstrapEnrichment> {
  const [supResult, entResult, aioResult] = await Promise.allSettled([
    runSuppressionScan(firmId, { maxUrls: 15 }),
    runEntityScan(firmId),
    captureAioForFirm(firmId, { maxQueries: 3 }),
  ]);

  // Suppression — translate raw runId into rich status by reading back the
  // audit_runs row + counting findings. Same pattern the demo script uses.
  const db = getDb();
  let suppression: PostBootstrapEnrichment['suppression'];
  if (supResult.status === 'fulfilled') {
    const { auditRuns, legacyFindings, pages: pagesTable } = await import('@ai-edge/db');
    const [run] = await db
      .select({ status: auditRuns.status, error: auditRuns.error })
      .from(auditRuns)
      .where(eq(auditRuns.id, supResult.value))
      .limit(1);
    if (run?.status === 'completed') {
      const [pageCount] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(pagesTable)
        .where(eq(pagesTable.firm_id, firmId));
      const [findingCount] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(legacyFindings)
        .innerJoin(pagesTable, eq(pagesTable.id, legacyFindings.page_id))
        .where(eq(pagesTable.firm_id, firmId));
      suppression = {
        status: 'completed',
        findingsCount: findingCount?.c ?? 0,
        pagesEmbedded: pageCount?.c ?? 0,
        runId: supResult.value,
      };
    } else {
      suppression = { status: 'failed', reason: run?.error?.slice(0, 200) ?? 'unknown' };
    }
  } else {
    suppression = {
      status: 'failed',
      reason: supResult.reason instanceof Error
        ? supResult.reason.message
        : String(supResult.reason),
    };
  }

  // Entity — count entity_signals rows from this scan.
  let entity: PostBootstrapEnrichment['entity'];
  if (entResult.status === 'fulfilled') {
    const { entitySignals } = await import('@ai-edge/db');
    const [sigCount] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(entitySignals)
      .where(eq(entitySignals.firm_id, firmId));
    entity = { status: 'completed', sourcesCount: sigCount?.c ?? 0, runId: entResult.value };
  } else {
    entity = {
      status: 'failed',
      reason: entResult.reason instanceof Error
        ? entResult.reason.message
        : String(entResult.reason),
    };
  }

  // AIO — translate the bulk outcome into a single completed/skipped row.
  // When no provider is configured, captureAioForFirm writes provider:'none'
  // rows that show "tried, no provider" in the dashboard — meaningful, but
  // we report it as `skipped` in the enrichment summary so the banner says
  // "AIO skipped — DataForSEO not configured" rather than "AIO 5/5 captured".
  let aio: PostBootstrapEnrichment['aio'];
  if (aioResult.status === 'fulfilled') {
    const v = aioResult.value;
    if (v.hasAio === 0 && v.errors === v.attempted && v.attempted > 0) {
      aio = { status: 'skipped', reason: 'AIO provider not configured (DATAFORSEO_LOGIN missing)' };
    } else {
      aio = { status: 'completed', attempted: v.attempted, hasAio: v.hasAio, firmCited: v.firmCited };
    }
  } else {
    aio = {
      status: 'skipped',
      reason: aioResult.reason instanceof Error
        ? aioResult.reason.message
        : String(aioResult.reason),
    };
  }

  return { suppression, entity, aio };
}
