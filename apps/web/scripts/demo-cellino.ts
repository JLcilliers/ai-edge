/**
 * End-to-end demo runner for Cellino Law.
 *
 * Sequence:
 *   1. Load latest Brand Truth version for cellino-law
 *   2. Trust Alignment Audit  (caps to 3 queries by default — set DEMO_QUERY_LIMIT to change)
 *   3. Legacy Suppression scan against cellinolaw.com (caps to 15 URLs)
 *   4. Entity / schema / KG probe
 *   5. Reddit sentiment scan (only if RAPIDAPI_REDDIT_KEY is set)
 *   6. AIO capture for the top query (only if DATAFORSEO_LOGIN is set)
 *   7. Print a manager-facing summary
 *
 * Run:
 *   corepack pnpm --filter @ai-edge/web dotenv -e .env.local -- \
 *     node --experimental-strip-types scripts/demo-cellino.ts
 *
 * Cost control:
 *   - DEMO_QUERY_LIMIT (default 3) caps the audit fan-out — at 4 providers × k=3
 *     this is 36 LLM calls for the audit + ~3 alignment-scorer calls = ~$1-3.
 *   - DEMO_MAX_URLS (default 15) caps the suppression crawl. Each page costs
 *     one embedding call (~$0.0002) so 15 URLs ≈ negligible.
 *
 * Failure handling:
 *   - Each stage runs independently and reports pass/fail to stdout
 *   - A module that throws (e.g. no Reddit key) is logged and skipped — the
 *     demo continues with the remaining stages
 */

// Load .env.local with `override: true` so the keys in the file win over any
// preexisting shell env vars (we hit a case where ANTHROPIC_API_KEY was set
// to '' upstream, so dotenv-cli's default no-override behavior was leaving
// the audit gated as "anthropic disabled" even though the file had the key).
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
const _scriptDir = dirname(fileURLToPath(import.meta.url));
dotenvConfig({
  path: resolvePath(_scriptDir, '../../../.env.local'),
  override: true,
});

import { getDb, firms, brandTruthVersions, auditRuns, alignmentScores,
  consensusResponses, citations as citationsTable, queries as queriesTable,
  modelResponses, legacyFindings, pages, entitySignals, remediationTickets,
  competitorMentions, aioCaptures, redditMentions } from '@ai-edge/db';
import { eq, desc, and, sql } from 'drizzle-orm';
import { runAudit } from '../app/lib/audit/run-audit';
import { runSuppressionScan } from '../app/lib/suppression/scan';
import { runEntityScan } from '../app/lib/entity/scan';
import { runRedditScan } from '../app/lib/reddit/scan';

const FIRM_SLUG = 'cellino-law';
const QUERY_LIMIT = Number(process.env.DEMO_QUERY_LIMIT ?? '3');
const MAX_URLS = Number(process.env.DEMO_MAX_URLS ?? '15');

function banner(stage: string, label: string) {
  const line = '─'.repeat(72);
  console.log(`\n${line}`);
  console.log(`  STAGE ${stage}: ${label}`);
  console.log(`${line}`);
}

async function resolveFirmAndBt() {
  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id, name: firms.name, firm_type: firms.firm_type })
    .from(firms)
    .where(eq(firms.slug, FIRM_SLUG))
    .limit(1);
  if (!firm) throw new Error(`Firm "${FIRM_SLUG}" not found. Run seed-cellino.ts first.`);

  const [btv] = await db
    .select({ id: brandTruthVersions.id, version: brandTruthVersions.version })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firm.id))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  if (!btv) throw new Error('No Brand Truth version found. Run seed-cellino.ts first.');

  return { firmId: firm.id, firmName: firm.name, btvId: btv.id, btvVersion: btv.version };
}

// ────────────────────────────────────────────────────────────────────
async function stageAudit(firmId: string, btvId: string) {
  banner('1/5', `Trust Alignment Audit (limit=${QUERY_LIMIT})`);
  // We temporarily monkey-patch the seed query count via env? No — runAudit
  // reads kind='full' and slices from BT seed_query_intents itself. We use
  // kind='daily-priority' with queryLimit to keep the demo cheap.
  const startedAt = Date.now();
  const runId = await runAudit(firmId, btvId, {
    kind: 'daily-priority',
    queryLimit: QUERY_LIMIT,
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const db = getDb();
  const [run] = await db
    .select({ status: auditRuns.status, cost_usd: auditRuns.cost_usd, error: auditRuns.error })
    .from(auditRuns)
    .where(eq(auditRuns.id, runId))
    .limit(1);
  console.log(`  → run ${runId}: status=${run?.status}, cost=$${run?.cost_usd?.toFixed(4)}, ${elapsed}s`);
  if (run?.error) console.log(`  → error: ${run.error}`);

  const ragRows = await db
    .select({
      rag_label: alignmentScores.rag_label,
      count: sql<number>`count(*)::int`,
    })
    .from(alignmentScores)
    .innerJoin(consensusResponses, eq(consensusResponses.id, alignmentScores.consensus_response_id))
    .innerJoin(queriesTable, eq(queriesTable.id, consensusResponses.query_id))
    .where(eq(queriesTable.audit_run_id, runId))
    .groupBy(alignmentScores.rag_label);

  const rag = { green: 0, yellow: 0, red: 0 } as Record<string, number>;
  for (const r of ragRows) rag[r.rag_label] = r.count;
  console.log(`  → RAG mix: green=${rag.green ?? 0}  yellow=${rag.yellow ?? 0}  red=${rag.red ?? 0}`);

  const responses = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(modelResponses)
    .innerJoin(queriesTable, eq(queriesTable.id, modelResponses.query_id))
    .where(eq(queriesTable.audit_run_id, runId));
  console.log(`  → model_responses persisted: ${responses[0]?.count ?? 0}`);

  const cites = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(citationsTable)
    .innerJoin(consensusResponses, eq(consensusResponses.id, citationsTable.consensus_response_id))
    .innerJoin(queriesTable, eq(queriesTable.id, consensusResponses.query_id))
    .where(eq(queriesTable.audit_run_id, runId));
  console.log(`  → citations: ${cites[0]?.count ?? 0}`);

  const compMentions = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(competitorMentions)
    .innerJoin(queriesTable, eq(queriesTable.id, competitorMentions.query_id))
    .where(eq(queriesTable.audit_run_id, runId));
  console.log(`  → competitor mentions detected: ${compMentions[0]?.count ?? 0}`);

  return runId;
}

// ────────────────────────────────────────────────────────────────────
async function stageSuppression(firmId: string) {
  banner('2/5', `Legacy Suppression scan against cellinolaw.com (maxUrls=${MAX_URLS})`);
  const startedAt = Date.now();
  const runId = await runSuppressionScan(firmId, { maxUrls: MAX_URLS });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const db = getDb();
  const [run] = await db
    .select({ status: auditRuns.status, error: auditRuns.error })
    .from(auditRuns).where(eq(auditRuns.id, runId)).limit(1);
  console.log(`  → run ${runId}: status=${run?.status}, ${elapsed}s`);
  if (run?.error) console.log(`  → error: ${run.error}`);

  const findings = await db
    .select({ action: legacyFindings.action, count: sql<number>`count(*)::int` })
    .from(legacyFindings)
    .innerJoin(pages, eq(pages.id, legacyFindings.page_id))
    .where(eq(pages.firm_id, firmId))
    .groupBy(legacyFindings.action);
  const byAction = findings.reduce<Record<string, number>>((acc, r) => {
    acc[r.action] = r.count; return acc;
  }, {});
  console.log(`  → findings by action:`, byAction);

  const [pageCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pages).where(eq(pages.firm_id, firmId));
  console.log(`  → pages embedded: ${pageCount?.count ?? 0}`);

  return runId;
}

// ────────────────────────────────────────────────────────────────────
async function stageEntity(firmId: string) {
  banner('3/5', 'Entity / schema / Knowledge Graph probe');
  const startedAt = Date.now();
  const runId = await runEntityScan(firmId);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const db = getDb();
  const [run] = await db
    .select({ status: auditRuns.status, error: auditRuns.error })
    .from(auditRuns).where(eq(auditRuns.id, runId)).limit(1);
  console.log(`  → run ${runId}: status=${run?.status}, ${elapsed}s`);
  if (run?.error) console.log(`  → error: ${run.error}`);

  const signals = await db
    .select({
      source: entitySignals.source,
      flags: entitySignals.divergence_flags,
    })
    .from(entitySignals)
    .where(eq(entitySignals.firm_id, firmId));
  for (const s of signals) {
    const flags = (s.flags ?? []) as string[];
    console.log(`  → ${s.source.padEnd(12)} flags=${flags.length === 0 ? '(none)' : flags.join(', ')}`);
  }

  return runId;
}

// ────────────────────────────────────────────────────────────────────
async function stageReddit(firmId: string) {
  banner('4/5', 'Reddit sentiment scan');
  if (!process.env.RAPIDAPI_REDDIT_KEY) {
    console.log('  → RAPIDAPI_REDDIT_KEY not set — skipping (module will show "configured but quiet")');
    return null;
  }
  try {
    const startedAt = Date.now();
    const runId = await runRedditScan(firmId);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    const db = getDb();
    const [run] = await db
      .select({ status: auditRuns.status, error: auditRuns.error })
      .from(auditRuns).where(eq(auditRuns.id, runId)).limit(1);
    console.log(`  → run ${runId}: status=${run?.status}, ${elapsed}s`);
    if (run?.error) console.log(`  → error: ${run.error}`);

    const bySent = await db
      .select({ sentiment: redditMentions.sentiment, count: sql<number>`count(*)::int` })
      .from(redditMentions)
      .where(eq(redditMentions.firm_id, firmId))
      .groupBy(redditMentions.sentiment);
    console.log('  → mentions by sentiment:',
      bySent.reduce<Record<string,number>>((a,r) => { a[r.sentiment ?? 'unknown']=r.count; return a; }, {}));
    return runId;
  } catch (err) {
    console.log(`  → reddit scan threw: ${err}`);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
async function stageAio(firmId: string) {
  banner('5/5', 'AI Overview capture (Google AIO)');
  if (!process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) {
    console.log('  → DATAFORSEO_* not set — skipping (module will record provider:none rows)');
    return null;
  }
  // Lazy-import only when keys present so the demo doesn't try to load the
  // capture module path that would call into network even with no providers.
  const { captureAioForFirm } = await import('../app/lib/aio/capture');
  try {
    const startedAt = Date.now();
    const result = await captureAioForFirm(firmId, { maxQueries: 2 });
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`  → attempted ${result.attempted} queries: hasAio=${result.hasAio}, firmCited=${result.firmCited}, errors=${result.errors} in ${elapsed}s`);
    const db = getDb();
    const rows = await db
      .select({ query: aioCaptures.query, has_aio: aioCaptures.has_aio, firm_cited: aioCaptures.firm_cited })
      .from(aioCaptures)
      .where(eq(aioCaptures.firm_id, firmId))
      .orderBy(desc(aioCaptures.fetched_at))
      .limit(5);
    for (const r of rows) {
      console.log(`     "${r.query}" → has_aio=${r.has_aio} firm_cited=${r.firm_cited}`);
    }
  } catch (err) {
    console.log(`  → aio capture threw: ${err}`);
  }
}

// ────────────────────────────────────────────────────────────────────
async function printSummary(firmId: string, firmName: string) {
  banner('Σ', `Summary for ${firmName}`);
  const db = getDb();
  const runs = await db
    .select({
      kind: auditRuns.kind,
      status: auditRuns.status,
      cost: auditRuns.cost_usd,
      started_at: auditRuns.started_at,
    })
    .from(auditRuns)
    .where(eq(auditRuns.firm_id, firmId))
    .orderBy(desc(auditRuns.started_at));
  console.log('  runs:');
  for (const r of runs) {
    console.log(`    ${r.kind.padEnd(14)} ${r.status.padEnd(28)} $${(r.cost ?? 0).toFixed(4).padStart(8)}`);
  }

  const [tickets] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(remediationTickets)
    .where(eq(remediationTickets.firm_id, firmId));
  console.log(`\n  open remediation tickets: ${tickets?.count ?? 0}`);
  console.log(`\n  → Dashboard: http://localhost:3000/dashboard/${FIRM_SLUG}`);
}

// ────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[demo] DATABASE_URL is not set — load .env.local first');
    process.exit(1);
  }

  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║         Clixsy Intercept — Cellino Law end-to-end demo              ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const { firmId, firmName, btvId, btvVersion } = await resolveFirmAndBt();
  console.log(`firm: ${firmName} (${firmId})  brand_truth: v${btvVersion}`);

  // Stages run sequentially — they share rate-limited APIs and a sequential
  // run is easier to follow during a live demo. Any single stage failure is
  // caught and logged; the demo continues.
  try { await stageAudit(firmId, btvId); } catch (e) { console.log('  stage failed:', e); }
  try { await stageSuppression(firmId); } catch (e) { console.log('  stage failed:', e); }
  try { await stageEntity(firmId); } catch (e) { console.log('  stage failed:', e); }
  try { await stageReddit(firmId); } catch (e) { console.log('  stage failed:', e); }
  try { await stageAio(firmId); } catch (e) { console.log('  stage failed:', e); }

  await printSummary(firmId, firmName);
  console.log('\n[demo] done.\n');
}

main().catch((err) => {
  console.error('\n[demo] fatal:', err);
  process.exit(1);
});
