/**
 * Data-input resolvers — server-side functions that take a firm + a
 * SopDataInput and return a renderable summary.
 *
 * The workflow client calls these per step to populate the "Auto-
 * populated data" cards on each step. Returns a typed payload the UI
 * renders inline.
 *
 * Each resolver is best-effort: when the underlying data isn't
 * available (no audit yet, GSC not connected, etc.), it returns a
 * neutral "not available" summary rather than throwing.
 */

import {
  getDb,
  auditRuns,
  queries,
  consensusResponses,
  alignmentScores,
  citations,
  legacyFindings,
  pages,
  brandTruthVersions,
  entitySignals,
  aioCaptures,
  competitors,
  gscConnections,
  sopStepStates,
} from '@ai-edge/db';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { BrandTruth } from '@ai-edge/shared';
import type { SopDataInputKind, SopKey } from './types';

export interface ResolvedDataInput {
  kind: SopDataInputKind;
  label: string;
  available: boolean;
  summary: string;
  /**
   * Optional structured rows for the UI to render as a table. Each
   * resolver picks a sensible shape; the workflow client renders the
   * top N rows.
   */
  rows?: Array<Record<string, string | number | null>>;
  /**
   * Optional accent (matches the dashboard's RAG colors).
   */
  tone?: 'ok' | 'warn' | 'neutral';
}

interface ResolveContext {
  firmId: string;
  sopRunMeta: Record<string, unknown>;
  sopKey: SopKey;
  stepNumber: number;
  sopRunId: string;
}

export async function resolveDataInput(
  ctx: ResolveContext,
  kind: SopDataInputKind,
  label: string,
  anchor?: { sopKey?: SopKey; stepNumber?: number; urlField?: string },
): Promise<ResolvedDataInput> {
  switch (kind) {
    case 'audit_run':
      return resolveAuditRun(ctx, label);
    case 'audit_citations':
      return resolveAuditCitations(ctx, label);
    case 'brand_truth':
      return resolveBrandTruth(ctx, label);
    case 'legacy_findings':
      return resolveLegacyFindings(ctx, label);
    case 'pages':
      return resolvePages(ctx, label);
    case 'gsc_metrics':
    case 'gsc_top_pages':
      return resolveGsc(ctx, label);
    case 'aio_captures':
      return resolveAioCaptures(ctx, label);
    case 'entity_signals':
      return resolveEntitySignals(ctx, label);
    case 'third_party_listings':
      return resolveThirdPartyListings(ctx, label);
    case 'competitors':
      return resolveCompetitors(ctx, label);
    case 'previous_sop_output':
      return resolvePreviousStepOutput(ctx, label, anchor);
    case 'manual_paste':
    case 'external_url_fetch':
    case 'reddit_mentions':
    default:
      return {
        kind,
        label,
        available: false,
        summary: 'Manual / external — operator-provided',
        tone: 'neutral',
      };
  }
}

async function resolveAuditRun(ctx: ResolveContext, label: string): Promise<ResolvedDataInput> {
  const db = getDb();
  const anchoredAuditRunId =
    ctx.sopRunMeta.anchors &&
    typeof (ctx.sopRunMeta.anchors as Record<string, unknown>).auditRunId === 'string'
      ? ((ctx.sopRunMeta.anchors as Record<string, unknown>).auditRunId as string)
      : undefined;

  // The anchor is what auto-start chose at firm-creation time — often a
  // bootstrap-driven entity or suppression audit, which has no alignment
  // scores. The Brand Visibility Audit workflow specifically wants the
  // latest **full** audit run with scored consensus responses, so we
  // prefer that signal even when an anchor exists. If no full audit has
  // run yet for this firm we keep the anchored row so the operator at
  // least sees something meaningful (start_at, kind) rather than empty
  // state.
  const fullAuditQuery = await db
    .select({
      id: auditRuns.id,
      finishedAt: auditRuns.finished_at,
      status: auditRuns.status,
      kind: auditRuns.kind,
    })
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.firm_id, ctx.firmId),
        eq(auditRuns.kind, 'full'),
        sql`${auditRuns.status} IN ('completed', 'completed_partial', 'completed_budget_truncated')`,
      ),
    )
    .orderBy(desc(auditRuns.finished_at))
    .limit(1);
  const fullRun = fullAuditQuery[0];

  // Fall back to the anchored row only if no full audit exists.
  const run = fullRun
    ? fullRun
    : anchoredAuditRunId
      ? (await db
          .select({
            id: auditRuns.id,
            finishedAt: auditRuns.finished_at,
            status: auditRuns.status,
            kind: auditRuns.kind,
          })
          .from(auditRuns)
          .where(eq(auditRuns.id, anchoredAuditRunId))
          .limit(1))[0]
      : (await db
          .select({
            id: auditRuns.id,
            finishedAt: auditRuns.finished_at,
            status: auditRuns.status,
            kind: auditRuns.kind,
          })
          .from(auditRuns)
          .where(
            and(
              eq(auditRuns.firm_id, ctx.firmId),
              sql`${auditRuns.status} IN ('completed', 'completed_partial', 'completed_budget_truncated')`,
            ),
          )
          .orderBy(desc(auditRuns.finished_at))
          .limit(1))[0];

  if (!run) {
    return {
      kind: 'audit_run',
      label,
      available: false,
      summary: 'No completed audit yet — start one from the Audits page',
      tone: 'warn',
    };
  }

  // RYG counts.
  const scores = await db
    .select({ rag: alignmentScores.rag_label })
    .from(alignmentScores)
    .innerJoin(consensusResponses, eq(alignmentScores.consensus_response_id, consensusResponses.id))
    .innerJoin(queries, eq(consensusResponses.query_id, queries.id))
    .where(eq(queries.audit_run_id, run.id));

  const counts = { red: 0, yellow: 0, green: 0 };
  for (const s of scores) {
    if (s.rag === 'red') counts.red += 1;
    else if (s.rag === 'yellow') counts.yellow += 1;
    else if (s.rag === 'green') counts.green += 1;
  }
  const total = scores.length;
  const pctRed = total === 0 ? 0 : Math.round((counts.red / total) * 100);

  return {
    kind: 'audit_run',
    label,
    available: true,
    summary: `${total} scored · ${pctRed}% red · ${counts.green} green · finished ${run.finishedAt?.toISOString().slice(0, 10) ?? 'never'}`,
    rows: [
      { Metric: 'Total scored', Value: total },
      { Metric: 'Red', Value: counts.red },
      { Metric: 'Yellow', Value: counts.yellow },
      { Metric: 'Green', Value: counts.green },
    ],
    tone: pctRed > 50 ? 'warn' : 'ok',
  };
}

async function resolveAuditCitations(ctx: ResolveContext, label: string): Promise<ResolvedDataInput> {
  const db = getDb();
  // Prefer the latest full audit run for this firm — the anchor on a
  // sop_run can point at an entity/suppression audit (no citations at
  // all) when auto-start fires before the first full audit completes.
  const fullRunRows = await db
    .select({ id: auditRuns.id })
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.firm_id, ctx.firmId),
        eq(auditRuns.kind, 'full'),
        sql`${auditRuns.status} IN ('completed', 'completed_partial', 'completed_budget_truncated')`,
      ),
    )
    .orderBy(desc(auditRuns.finished_at))
    .limit(1);
  const auditRunId =
    fullRunRows[0]?.id ??
    (ctx.sopRunMeta.anchors &&
    typeof (ctx.sopRunMeta.anchors as Record<string, unknown>).auditRunId === 'string'
      ? ((ctx.sopRunMeta.anchors as Record<string, unknown>).auditRunId as string)
      : undefined);
  if (!auditRunId) {
    return {
      kind: 'audit_citations',
      label,
      available: false,
      summary: 'No completed full audit yet — citations will populate after the first audit run',
      tone: 'warn',
    };
  }
  const rows = await db
    .select({ domain: citations.domain, count: sql<number>`count(*)::int` })
    .from(citations)
    .innerJoin(consensusResponses, eq(citations.consensus_response_id, consensusResponses.id))
    .innerJoin(queries, eq(consensusResponses.query_id, queries.id))
    .where(eq(queries.audit_run_id, auditRunId))
    .groupBy(citations.domain)
    .orderBy(desc(sql`count(*)`))
    .limit(10);
  const total = rows.reduce((a, b) => a + b.count, 0);
  return {
    kind: 'audit_citations',
    label,
    available: true,
    summary: `${rows.length} unique domains · ${total} total citations`,
    rows: rows.map((r) => ({ Domain: r.domain, Count: r.count })),
    tone: 'ok',
  };
}

async function resolveBrandTruth(ctx: ResolveContext, label: string): Promise<ResolvedDataInput> {
  const db = getDb();
  const [row] = await db
    .select({ payload: brandTruthVersions.payload, version: brandTruthVersions.version })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, ctx.firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  if (!row) {
    return { kind: 'brand_truth', label, available: false, summary: 'No Brand Truth — bootstrap or author one first', tone: 'warn' };
  }
  const bt = row.payload as BrandTruth;
  const positioning = (bt as { positioning_statement?: string }).positioning_statement ?? '';
  return {
    kind: 'brand_truth',
    label,
    available: true,
    summary: `v${row.version} · ${positioning.slice(0, 120)}${positioning.length > 120 ? '…' : ''}`,
    tone: 'ok',
  };
}

async function resolveLegacyFindings(ctx: ResolveContext, label: string): Promise<ResolvedDataInput> {
  const db = getDb();
  const counts = await db
    .select({ action: legacyFindings.action, count: sql<number>`count(*)::int` })
    .from(legacyFindings)
    .innerJoin(pages, eq(legacyFindings.page_id, pages.id))
    .where(eq(pages.firm_id, ctx.firmId))
    .groupBy(legacyFindings.action);
  const total = counts.reduce((a, b) => a + b.count, 0);
  if (total === 0) {
    return { kind: 'legacy_findings', label, available: false, summary: 'No suppression-scan findings yet', tone: 'warn' };
  }
  return {
    kind: 'legacy_findings',
    label,
    available: true,
    summary: `${total} flagged pages: ${counts.map((c) => `${c.count} ${c.action}`).join(', ')}`,
    rows: counts.map((c) => ({ Action: c.action, Count: c.count })),
    tone: 'ok',
  };
}

async function resolvePages(ctx: ResolveContext, label: string): Promise<ResolvedDataInput> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pages)
    .where(eq(pages.firm_id, ctx.firmId));
  const count = row?.count ?? 0;
  return {
    kind: 'pages',
    label,
    available: count > 0,
    summary: `${count} pages crawled`,
    tone: count > 0 ? 'ok' : 'warn',
  };
}

async function resolveGsc(ctx: ResolveContext, label: string): Promise<ResolvedDataInput> {
  const db = getDb();
  const [row] = await db
    .select({ lastSyncedAt: gscConnections.last_synced_at, siteUrl: gscConnections.site_url })
    .from(gscConnections)
    .where(eq(gscConnections.firm_id, ctx.firmId))
    .limit(1);
  if (!row) {
    return {
      kind: 'gsc_metrics',
      label,
      available: false,
      summary: 'Search Console not connected for this firm — connect in Settings',
      tone: 'warn',
    };
  }
  return {
    kind: 'gsc_metrics',
    label,
    available: true,
    summary: `Connected to ${row.siteUrl} · last sync ${row.lastSyncedAt?.toISOString().slice(0, 10) ?? 'never'}`,
    tone: 'ok',
  };
}

async function resolveAioCaptures(ctx: ResolveContext, label: string): Promise<ResolvedDataInput> {
  const db = getDb();
  const rows = await db
    .select({ query: aioCaptures.query, hasAio: aioCaptures.has_aio, firmCited: aioCaptures.firm_cited, provider: aioCaptures.provider })
    .from(aioCaptures)
    .where(eq(aioCaptures.firm_id, ctx.firmId))
    .orderBy(desc(aioCaptures.fetched_at))
    .limit(10);
  if (rows.length === 0) {
    return { kind: 'aio_captures', label, available: false, summary: 'No AIO captures yet', tone: 'warn' };
  }
  const yes = rows.filter((r) => r.hasAio).length;
  const cited = rows.filter((r) => r.firmCited).length;
  return {
    kind: 'aio_captures',
    label,
    available: true,
    summary: `${rows.length} recent captures · ${yes} had AIO · ${cited} cited the firm`,
    rows: rows.slice(0, 5).map((r) => ({
      Query: r.query,
      'AIO?': r.hasAio ? 'yes' : 'no',
      Cited: r.firmCited ? 'yes' : '—',
      Provider: r.provider,
    })),
    tone: 'ok',
  };
}

async function resolveEntitySignals(ctx: ResolveContext, label: string): Promise<ResolvedDataInput> {
  const db = getDb();
  // entity_signal stores one row per (firm, source) — e.g. one for
  // schema.org home, one for Wikidata, one for KG. We surface a count
  // plus the most recent verification timestamp. The dedicated /entity
  // page has the rich detail; this card just confirms scans have run.
  const rows = await db
    .select({
      source: entitySignals.source,
      verifiedAt: entitySignals.verified_at,
      flags: entitySignals.divergence_flags,
    })
    .from(entitySignals)
    .where(eq(entitySignals.firm_id, ctx.firmId))
    .orderBy(desc(entitySignals.verified_at));
  if (rows.length === 0) {
    return { kind: 'entity_signals', label, available: false, summary: 'No entity scan yet', tone: 'warn' };
  }
  const divergent = rows.filter((r) => (r.flags?.length ?? 0) > 0).length;
  const mostRecent = rows[0]?.verifiedAt;
  return {
    kind: 'entity_signals',
    label,
    available: true,
    summary: `${rows.length} entity sources · ${divergent} flagged divergent · last verified ${mostRecent?.toISOString().slice(0, 10) ?? 'never'}`,
    rows: rows.slice(0, 6).map((r) => ({
      Source: r.source,
      Divergences: r.flags?.length ?? 0,
    })),
    tone: divergent === 0 ? 'ok' : 'warn',
  };
}

async function resolveThirdPartyListings(ctx: ResolveContext, label: string): Promise<ResolvedDataInput> {
  const db = getDb();
  const [row] = await db
    .select({ payload: brandTruthVersions.payload })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, ctx.firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  if (!row) {
    return { kind: 'third_party_listings', label, available: false, summary: 'No Brand Truth yet', tone: 'warn' };
  }
  const listings = ((row.payload as { third_party_listings?: { url: string; name?: string }[] }).third_party_listings ?? []);
  if (listings.length === 0) {
    return {
      kind: 'third_party_listings',
      label,
      available: false,
      summary: 'No third_party_listings in Brand Truth — add G2/LinkedIn/Wikipedia URLs before advancing',
      tone: 'warn',
    };
  }
  return {
    kind: 'third_party_listings',
    label,
    available: true,
    summary: `${listings.length} platforms inventoried`,
    rows: listings.map((l) => ({ Platform: l.name ?? new URL(l.url).host, URL: l.url })),
    tone: 'ok',
  };
}

async function resolveCompetitors(ctx: ResolveContext, label: string): Promise<ResolvedDataInput> {
  const db = getDb();
  const rows = await db.select().from(competitors).where(eq(competitors.firm_id, ctx.firmId));
  if (rows.length === 0) {
    return { kind: 'competitors', label, available: false, summary: 'No competitor roster — add at /competitors', tone: 'warn' };
  }
  return {
    kind: 'competitors',
    label,
    available: true,
    summary: `${rows.length} competitors tracked`,
    rows: rows.map((r) => ({ Name: r.name, Website: r.website ?? '—' })),
    tone: 'ok',
  };
}

async function resolvePreviousStepOutput(
  ctx: ResolveContext,
  label: string,
  anchor?: { sopKey?: SopKey; stepNumber?: number },
): Promise<ResolvedDataInput> {
  if (!anchor?.sopKey || anchor.stepNumber == null) {
    return { kind: 'previous_sop_output', label, available: false, summary: 'No anchor configured', tone: 'neutral' };
  }
  const db = getDb();
  // Find the matching prior step within this firm's same-SOP runs.
  // Simplification: look in the same run we're currently in.
  const [state] = await db
    .select({ output: sopStepStates.output_summary, status: sopStepStates.status })
    .from(sopStepStates)
    .where(and(eq(sopStepStates.sop_run_id, ctx.sopRunId), eq(sopStepStates.step_number, anchor.stepNumber)))
    .limit(1);
  if (!state || state.status !== 'completed') {
    return {
      kind: 'previous_sop_output',
      label,
      available: false,
      summary: `Step ${anchor.stepNumber} of ${anchor.sopKey} not yet completed`,
      tone: 'warn',
    };
  }
  const out = (state.output as Record<string, unknown>) ?? {};
  return {
    kind: 'previous_sop_output',
    label,
    available: true,
    summary: `Step ${anchor.stepNumber} completed; output captured`,
    rows: Object.entries(out).slice(0, 8).map(([k, v]) => ({
      Key: k,
      Value: typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v),
    })),
    tone: 'ok',
  };
}
