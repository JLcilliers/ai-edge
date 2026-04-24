'use server';

import {
  getDb,
  firms,
  auditRuns,
  queries as queriesTable,
  consensusResponses,
  alignmentScores,
  citations as citationsTable,
  modelResponses,
  brandTruthVersions,
} from '@ai-edge/db';
import { eq, desc, inArray } from 'drizzle-orm';
import { runAudit } from '../lib/audit/run-audit';
import { getFirmBudgetStatus } from '../lib/audit/budget';

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

// Start a new audit for a specific client.
//
// Pre-flight checks (match the cron pattern in api/cron/audit-{daily,weekly}):
//   1. firm has a Brand Truth — otherwise there's nothing to audit against.
//   2. firm is under monthly budget cap — otherwise the in-flight gate would
//      fire after the first query's cost was recorded, burning money + leaving
//      a `completed_budget_truncated` row. Skipping up front keeps the audit
//      log clean and gives the operator a readable error pointing at Settings.
export async function startAudit(
  firmSlug: string,
): Promise<{ auditRunId: string } | { error: string }> {
  try {
    const db = getDb();
    const firmId = await resolveFirmId(firmSlug);

    // Get latest brand truth version
    const [btv] = await db
      .select({ id: brandTruthVersions.id })
      .from(brandTruthVersions)
      .where(eq(brandTruthVersions.firm_id, firmId))
      .orderBy(desc(brandTruthVersions.version))
      .limit(1);

    if (!btv) return { error: 'No Brand Truth saved — create one first' };

    // Pre-flight budget gate. The dashboard "Run audit" button was the one
    // path into runAudit that skipped this check — both audit crons have
    // had it for a while. Returning a readable error so the UI banner tells
    // the operator exactly why the run was refused and where to adjust it.
    const budget = await getFirmBudgetStatus(firmId);
    if (budget.overBudget) {
      return {
        error:
          `Over monthly budget ($${budget.spentThisMonthUsd.toFixed(2)} / ` +
          `$${budget.monthlyCapUsd.toFixed(2)} spent). ` +
          `Adjust the cap in Settings to run another audit.`,
      };
    }

    const auditRunId = await runAudit(firmId, btv.id);
    return { auditRunId };
  } catch (err) {
    return { error: String(err) };
  }
}

// Get all audit runs for the firm
export async function getAuditRuns(firmSlug: string): Promise<
  Array<{
    id: string;
    status: string;
    kind: string;
    startedAt: Date | null;
    finishedAt: Date | null;
    error: string | null;
  }>
> {
  const db = getDb();
  const firmId = await resolveFirmId(firmSlug);

  return db
    .select({
      id: auditRuns.id,
      status: auditRuns.status,
      kind: auditRuns.kind,
      startedAt: auditRuns.started_at,
      finishedAt: auditRuns.finished_at,
      error: auditRuns.error,
    })
    .from(auditRuns)
    .where(eq(auditRuns.firm_id, firmId))
    .orderBy(desc(auditRuns.started_at));
}

// Get audit run status (for polling). Audit-run id is globally unique, no firm scope needed.
export async function getAuditRunStatus(auditRunId: string): Promise<{
  status: string;
  error: string | null;
}> {
  const db = getDb();
  const [run] = await db
    .select({ status: auditRuns.status, error: auditRuns.error })
    .from(auditRuns)
    .where(eq(auditRuns.id, auditRunId))
    .limit(1);
  return run ?? { status: 'unknown', error: null };
}

/**
 * Get audit detail with all results. Audit-run id is globally unique.
 *
 * Query plan:
 *   1. run (1 query)
 *   2. queries for run (1 query)
 *   3. In parallel, batched by query_id / consensus_id:
 *      - model_responses (1 query)
 *      - consensus_responses (1 query)
 *   4. In parallel, batched by consensus_id:
 *      - alignment_scores (1 query)
 *      - citations (1 query)
 *
 * Total: 6 queries, constant w.r.t. run size. Previous implementation was
 * 1 + 4·N (run + queries + per-query model_responses + per-query
 * consensus_responses + per-consensus alignment_score + per-consensus
 * citations) which for a 20-query × 4-provider audit hit ~200 serial
 * round-trips. For a large audit this is the difference between a
 * sub-second and a multi-second detail-page load.
 *
 * Provider/model mapping note: `consensus_response` doesn't store a
 * provider column — the run-audit writer inserts one consensus row per
 * (query, provider) in iteration order. The old implementation matched
 * consensus rows to `model_responses[idx]` by raw row index, which only
 * worked at k=1 — at k=3 self-consistency (3 model_responses per
 * (query, provider)), the indexes desync and every consensus after the
 * first attributes to the wrong provider. We now build a per-query list
 * of distinct providers (preserving first-seen insertion order) and
 * match consensus[i] → distinctProviders[i]. That's correct at any k
 * and still preserves the existing behaviour at k=1.
 */
export async function getAuditDetail(auditRunId: string): Promise<{
  run: {
    id: string;
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
  };
  results: Array<{
    queryText: string;
    provider: string;
    model: string;
    mentioned: boolean;
    toneScore: number | null;
    ragLabel: string;
    gapReasons: string[];
    factualErrors: string[];
    citationUrls: string[];
    responsePreview: string;
    fullResponse: string;
    /**
     * Number of samples the consensus row was built from. At k=1 (standard
     * queries) this is just 1 and the UI can elide the detail. At k=3
     * (top-priority queries, self-consistency tier) the operator wants to
     * see both k and `variance` so they can tell "all 3 providers agreed"
     * apart from "2 said yes, 1 said no."
     */
    k: number;
    /**
     * Fraction of samples whose `mentioned` vote disagreed with the
     * majority. 0 = unanimous, 0.33 = one dissent at k=3, etc. At k=1 this
     * is always 0. Surfaced to the UI as a percentage and as a warning
     * chip when > 0.
     */
    variance: number;
  }>;
  summary: { red: number; yellow: number; green: number };
}> {
  const db = getDb();

  // 1. Run — needed before we can bail out on missing run.
  const [run] = await db
    .select({
      id: auditRuns.id,
      status: auditRuns.status,
      startedAt: auditRuns.started_at,
      finishedAt: auditRuns.finished_at,
    })
    .from(auditRuns)
    .where(eq(auditRuns.id, auditRunId))
    .limit(1);

  if (!run) throw new Error('Audit run not found');

  // 2. Queries for this run.
  const queryRows = await db
    .select()
    .from(queriesTable)
    .where(eq(queriesTable.audit_run_id, auditRunId));

  if (queryRows.length === 0) {
    return { run, results: [], summary: { red: 0, yellow: 0, green: 0 } };
  }

  const queryIds = queryRows.map((q) => q.id);

  // 3. model_responses + consensus_responses, batched by query_id.
  const [mrRows, consensusRows] = await Promise.all([
    db
      .select({
        query_id: modelResponses.query_id,
        provider: modelResponses.provider,
        model: modelResponses.model,
      })
      .from(modelResponses)
      .where(inArray(modelResponses.query_id, queryIds)),
    db
      .select()
      .from(consensusResponses)
      .where(inArray(consensusResponses.query_id, queryIds)),
  ]);

  const consensusIds = consensusRows.map((c) => c.id);

  // 4. alignment_scores + citations, batched by consensus_id.
  // Guard on empty consensusIds — inArray with [] rejects on some drivers.
  const [scoreRows, citeRows] = consensusIds.length > 0
    ? await Promise.all([
        db
          .select()
          .from(alignmentScores)
          .where(inArray(alignmentScores.consensus_response_id, consensusIds)),
        db
          .select({
            consensus_response_id: citationsTable.consensus_response_id,
            url: citationsTable.url,
          })
          .from(citationsTable)
          .where(inArray(citationsTable.consensus_response_id, consensusIds)),
      ])
    : [[], []];

  // Indexes for O(1) lookups during the stitch pass.
  const consensusByQuery = new Map<string, typeof consensusRows>();
  for (const cr of consensusRows) {
    const list = consensusByQuery.get(cr.query_id);
    if (list) list.push(cr);
    else consensusByQuery.set(cr.query_id, [cr]);
  }

  // Per-query list of distinct providers in insertion order. Used to map
  // consensus[i] → the i'th distinct provider for that query. Correct at
  // any k (including k=1 legacy and k=3 self-consistency).
  const providersByQuery = new Map<
    string,
    Array<{ provider: string; model: string }>
  >();
  for (const mr of mrRows) {
    let list = providersByQuery.get(mr.query_id);
    if (!list) {
      list = [];
      providersByQuery.set(mr.query_id, list);
    }
    if (!list.some((p) => p.provider === mr.provider)) {
      list.push({ provider: mr.provider, model: mr.model });
    }
  }

  const scoreByConsensus = new Map(
    scoreRows.map((s) => [s.consensus_response_id, s]),
  );

  const citesByConsensus = new Map<string, string[]>();
  for (const c of citeRows) {
    const list = citesByConsensus.get(c.consensus_response_id);
    if (list) list.push(c.url);
    else citesByConsensus.set(c.consensus_response_id, [c.url]);
  }

  const results: Array<{
    queryText: string;
    provider: string;
    model: string;
    mentioned: boolean;
    toneScore: number | null;
    ragLabel: string;
    gapReasons: string[];
    factualErrors: string[];
    citationUrls: string[];
    responsePreview: string;
    fullResponse: string;
    k: number;
    variance: number;
  }> = [];

  for (const q of queryRows) {
    const consensusForQuery = consensusByQuery.get(q.id) ?? [];
    const distinctProviders = providersByQuery.get(q.id) ?? [];

    for (let i = 0; i < consensusForQuery.length; i++) {
      const cr = consensusForQuery[i]!;
      const provMeta = distinctProviders[i] ?? {
        provider: 'unknown',
        model: 'unknown',
      };
      const score = scoreByConsensus.get(cr.id);
      const cites = citesByConsensus.get(cr.id) ?? [];
      const fullResponse = cr.majority_answer ?? '';

      results.push({
        queryText: q.text,
        provider: provMeta.provider,
        model: provMeta.model,
        mentioned: score?.mentioned ?? false,
        toneScore: score?.tone_1_10 ?? null,
        ragLabel: score?.rag_label ?? 'red',
        gapReasons: (score?.gap_reasons as string[]) ?? [],
        factualErrors: (score?.factual_errors as string[]) ?? [],
        citationUrls: cites,
        responsePreview: fullResponse.slice(0, 200),
        fullResponse,
        // `variance` is stored as 0..1 in the DB — clamp + default to 0 in
        // case a legacy row left it null or NaN before we enforced NOT NULL.
        k: cr.self_consistency_k ?? 1,
        variance: Number.isFinite(cr.variance)
          ? Math.max(0, Math.min(1, Number(cr.variance)))
          : 0,
      });
    }
  }

  const summary = {
    red: results.filter((r) => r.ragLabel === 'red').length,
    yellow: results.filter((r) => r.ragLabel === 'yellow').length,
    green: results.filter((r) => r.ragLabel === 'green').length,
  };

  return { run, results, summary };
}

// NOTE: the previous `exportAuditCsv` server action lived here. It's been
// replaced by the shareable HTTP endpoint at
// `/api/audits/[auditRunId]/export.csv/route.ts`, which emits the same
// columns with RFC-4180-compliant CRLF line endings + a
// `Content-Disposition: attachment` header so the browser's native save
// dialog fires. The dashboard's "Export CSV" button is a plain `<a href>`
// pointing at that route — no callers of the server action remain, so it's
// been removed to keep the action surface minimal.
