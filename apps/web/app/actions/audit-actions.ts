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
import { eq, desc } from 'drizzle-orm';
import { runAudit } from '../lib/audit/run-audit';

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

// Get audit detail with all results. Audit-run id is globally unique.
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
  }>;
  summary: { red: number; yellow: number; green: number };
}> {
  const db = getDb();

  // Get the run
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

  // Get all queries for this run
  const queryRows = await db
    .select()
    .from(queriesTable)
    .where(eq(queriesTable.audit_run_id, auditRunId));

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
  }> = [];

  for (const q of queryRows) {
    // Get all model responses for this query (ordered by creation = insertion order)
    const mrRows = await db
      .select()
      .from(modelResponses)
      .where(eq(modelResponses.query_id, q.id));

    // Get all consensus responses for this query (same insertion order as providers)
    const consensusRows = await db
      .select()
      .from(consensusResponses)
      .where(eq(consensusResponses.query_id, q.id));

    // Match consensus to model_response by index (both inserted per-provider in same order)
    for (let idx = 0; idx < consensusRows.length; idx++) {
      const cr = consensusRows[idx]!;
      const matchedMr = mrRows[idx]; // direct index match — both created in provider loop order

      // Get alignment score
      const [score] = await db
        .select()
        .from(alignmentScores)
        .where(eq(alignmentScores.consensus_response_id, cr.id))
        .limit(1);

      // Get citations
      const cites = await db
        .select({ url: citationsTable.url })
        .from(citationsTable)
        .where(eq(citationsTable.consensus_response_id, cr.id));

      const fullResponse = cr.majority_answer ?? '';

      results.push({
        queryText: q.text,
        provider: matchedMr?.provider ?? 'unknown',
        model: matchedMr?.model ?? 'unknown',
        mentioned: score?.mentioned ?? false,
        toneScore: score?.tone_1_10 ?? null,
        ragLabel: score?.rag_label ?? 'red',
        gapReasons: (score?.gap_reasons as string[]) ?? [],
        factualErrors: (score?.factual_errors as string[]) ?? [],
        citationUrls: cites.map((c) => c.url),
        responsePreview: fullResponse.slice(0, 200),
        fullResponse,
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

// CSV export
export async function exportAuditCsv(auditRunId: string): Promise<string> {
  const { results } = await getAuditDetail(auditRunId);

  const header = 'query,provider,model,mentioned,tone_score,rag_label,gap_reasons,citations,factual_errors,response_preview';
  const rows = results.map((r) => {
    const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
    return [
      escape(r.queryText),
      escape(r.provider),
      escape(r.model),
      r.mentioned ? 'Y' : 'N',
      r.toneScore?.toString() ?? '',
      r.ragLabel,
      escape(r.gapReasons.join('|')),
      escape(r.citationUrls.join('|')),
      escape(r.factualErrors.join('|')),
      escape(r.responsePreview),
    ].join(',');
  });

  return [header, ...rows].join('\n');
}
