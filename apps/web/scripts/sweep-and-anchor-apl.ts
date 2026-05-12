/**
 * One-shot recovery for Andrew Pickett Law (or any firm passed via
 * --slug). Performs two operations against production data:
 *
 * 1. Any audit_run still in status='running' past STALE_AGE_MIN gets
 *    promoted to completed_partial (or failed if zero consensus rows)
 *    — same logic the audit-sweep cron applies, just run on demand so
 *    we don't have to wait for the next 5-min cron tick.
 *
 * 2. The firm's Brand Visibility Audit sop_run gets its meta.anchors
 *    re-anchored to the latest full audit_run with non-zero alignment
 *    scores. This fixes the auto-start anchor mismatch that left the
 *    workflow's audit_run data card showing "0 scored" even when the
 *    audit completed.
 *
 * Idempotent: re-running with no stuck audits + already-correct anchor
 * is a no-op.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/sweep-and-anchor-apl.ts
 *   pnpm exec tsx scripts/sweep-and-anchor-apl.ts --slug andrew-pickett-law
 */
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
const _d = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolvePath(_d, '../../../.env.local'), override: true });

import {
  getDb,
  firms,
  auditRuns,
  queries as queriesTable,
  consensusResponses,
  sopRuns,
} from '@ai-edge/db';
import { and, eq, lt, desc, sql, inArray } from 'drizzle-orm';

const STALE_AGE_MIN = 5;
const STALE_ERROR_PARTIAL =
  'Stale: function timed out before final UPDATE could commit. Promoted to completed_partial because at least one consensus_response landed; operators can read the rows that completed.';
const STALE_ERROR_FAILED =
  'Stale: function timed out before any consensus row landed. No usable signal in this run.';

async function main() {
  const slugArgIdx = process.argv.indexOf('--slug');
  const targetSlug = slugArgIdx >= 0 ? process.argv[slugArgIdx + 1] : 'andrew-pickett-law';
  if (!targetSlug) {
    console.error('Missing --slug value');
    process.exit(1);
  }
  console.log(`▶ Recovering firm: ${targetSlug}`);

  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id, name: firms.name })
    .from(firms)
    .where(eq(firms.slug, targetSlug))
    .limit(1);
  if (!firm) {
    console.error(`✗ Firm not found: ${targetSlug}`);
    process.exit(1);
  }
  console.log(`  ✓ firm = ${firm.name} (${firm.id})`);

  // Step 1: sweep stuck audits.
  const cutoff = new Date(Date.now() - STALE_AGE_MIN * 60_000);
  const stuck = await db
    .select({ id: auditRuns.id, kind: auditRuns.kind, startedAt: auditRuns.started_at })
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.firm_id, firm.id),
        eq(auditRuns.status, 'running'),
        lt(auditRuns.started_at, cutoff),
      ),
    );
  console.log(`\n▶ Stuck audit_runs older than ${STALE_AGE_MIN}min: ${stuck.length}`);
  for (const s of stuck) {
    console.log(`  - ${s.id} kind=${s.kind} started=${s.startedAt?.toISOString()}`);
  }

  if (stuck.length > 0) {
    const stuckIds = stuck.map((s) => s.id);
    const withResults = await db
      .select({
        auditRunId: queriesTable.audit_run_id,
        scored: sql<number>`COUNT(${consensusResponses.id})::int`,
      })
      .from(queriesTable)
      .innerJoin(consensusResponses, eq(consensusResponses.query_id, queriesTable.id))
      .where(inArray(queriesTable.audit_run_id, stuckIds))
      .groupBy(queriesTable.audit_run_id);

    const scoredByRun = new Map<string, number>();
    for (const r of withResults) scoredByRun.set(r.auditRunId, r.scored);

    const partial = stuckIds.filter((id) => (scoredByRun.get(id) ?? 0) > 0);
    const failed = stuckIds.filter((id) => (scoredByRun.get(id) ?? 0) === 0);
    const now = new Date();

    if (partial.length > 0) {
      await db
        .update(auditRuns)
        .set({ status: 'completed_partial', finished_at: now, error: STALE_ERROR_PARTIAL })
        .where(and(eq(auditRuns.status, 'running'), inArray(auditRuns.id, partial)));
      console.log(`  ✓ promoted ${partial.length} → completed_partial`);
    }
    if (failed.length > 0) {
      await db
        .update(auditRuns)
        .set({ status: 'failed', finished_at: now, error: STALE_ERROR_FAILED })
        .where(and(eq(auditRuns.status, 'running'), inArray(auditRuns.id, failed)));
      console.log(`  ✓ marked ${failed.length} → failed`);
    }
  } else {
    console.log('  (nothing to sweep)');
  }

  // Step 2: re-anchor the Brand Visibility Audit sop_run.
  console.log('\n▶ Re-anchoring Brand Visibility Audit sop_run...');
  const [bvaRun] = await db
    .select({ id: sopRuns.id, meta: sopRuns.meta, currentStep: sopRuns.current_step })
    .from(sopRuns)
    .where(and(eq(sopRuns.firm_id, firm.id), eq(sopRuns.sop_key, 'brand_visibility_audit')))
    .orderBy(desc(sopRuns.created_at))
    .limit(1);
  if (!bvaRun) {
    console.log('  ✗ no Brand Visibility Audit sop_run for this firm (auto-start may not have fired)');
    return;
  }
  console.log(`  ✓ sop_run = ${bvaRun.id} current_step=${bvaRun.currentStep}`);

  const [latestFull] = await db
    .select({
      id: auditRuns.id,
      status: auditRuns.status,
      finishedAt: auditRuns.finished_at,
    })
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.firm_id, firm.id),
        eq(auditRuns.kind, 'full'),
        sql`${auditRuns.status} IN ('completed', 'completed_partial', 'completed_budget_truncated')`,
      ),
    )
    .orderBy(desc(auditRuns.finished_at))
    .limit(1);

  if (!latestFull) {
    console.log('  (no full audit yet — anchor not changed)');
    return;
  }
  console.log(`  latest full audit = ${latestFull.id} status=${latestFull.status} finished=${latestFull.finishedAt?.toISOString()}`);

  const currentAnchors = ((bvaRun.meta as Record<string, unknown>)?.anchors ?? {}) as Record<string, unknown>;
  if (currentAnchors.auditRunId === latestFull.id) {
    console.log('  (anchor already correct)');
    return;
  }

  const newMeta = {
    ...(bvaRun.meta as Record<string, unknown>),
    anchors: { ...currentAnchors, auditRunId: latestFull.id },
  };
  await db.update(sopRuns).set({ meta: newMeta }).where(eq(sopRuns.id, bvaRun.id));
  console.log(`  ✓ anchor rewired: ${currentAnchors.auditRunId} → ${latestFull.id}`);

  console.log('\n✓ done');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
