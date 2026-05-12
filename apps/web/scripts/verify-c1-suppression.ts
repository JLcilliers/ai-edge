/**
 * C1 verification: run Suppression scan on APL and report bucket
 * distribution + routing correctness.
 *
 * What we verify:
 *  - scan emits at least one finding per bucket present in the data
 *  - keep_update / rewrite findings produce tickets attached to the
 *    content_repositioning sop_run (NOT legacy_content_suppression)
 *  - delete / redirect / noindex findings produce tickets attached to
 *    legacy_content_suppression sop_run
 *  - decided_with_gsc flag is set correctly per finding
 *  - if firm has no GSC connection, the gsc_setup config-gate ticket
 *    appears exactly once
 */
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
const _d = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolvePath(_d, '../../../.env.local'), override: true });

import { getDb, firms, legacyFindings, pages, remediationTickets, sopRuns } from '@ai-edge/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { runSuppressionScan } from '../app/lib/suppression/scan';
import { firmHasGscConnection } from '../app/lib/gsc/per-url-metrics';

const SLUG = process.argv[2] ?? 'andrew-pickett-law';

async function main() {
  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id, slug: firms.slug, name: firms.name })
    .from(firms)
    .where(eq(firms.slug, SLUG))
    .limit(1);
  if (!firm) {
    console.error(`Firm not found: ${SLUG}`);
    process.exit(1);
  }
  console.log(`Firm: ${firm.name} (${firm.slug})  ${firm.id}`);
  const gscConnected = await firmHasGscConnection(firm.id);
  console.log(`GSC connected: ${gscConnected}`);

  console.log('Running Suppression scan…');
  const runId = await runSuppressionScan(firm.id, { maxUrls: 75 });
  console.log(`Suppression run_id: ${runId}`);

  // Bucket distribution
  const buckets = await db.execute<{ action: string; decided_with_gsc: boolean; n: bigint }>(sql`
    SELECT lf.action, lf.decided_with_gsc, COUNT(*)::bigint AS n
      FROM legacy_finding lf
      JOIN page p ON p.id = lf.page_id
     WHERE p.firm_id = ${firm.id}
  GROUP BY 1, 2
  ORDER BY 1, 2`);
  console.log('\nLegacy finding buckets:');
  for (const r of buckets.rows ?? []) {
    console.log(`  ${r.action.padEnd(14)} decided_with_gsc=${r.decided_with_gsc}  n=${r.n}`);
  }

  // Tickets routed per sop_run
  const routing = await db.execute<{ sop_key: string; action: string; n: bigint }>(sql`
    SELECT sr.sop_key, lf.action, COUNT(*)::bigint AS n
      FROM remediation_ticket t
      JOIN sop_run sr ON sr.id = t.sop_run_id
      JOIN legacy_finding lf ON lf.id = t.source_id
     WHERE t.firm_id = ${firm.id}
       AND t.source_type = 'legacy'
  GROUP BY 1, 2
  ORDER BY 1, 2`);
  console.log('\nLegacy tickets by sop_run × action:');
  for (const r of routing.rows ?? []) {
    console.log(`  ${r.sop_key.padEnd(32)} ${r.action.padEnd(14)} n=${r.n}`);
  }

  // Config-gate ticket
  const gateRows = await db.execute<{ id: string; title: string; status: string }>(sql`
    SELECT t.id, t.title, t.status
      FROM remediation_ticket t
      JOIN sop_run sr ON sr.id = t.sop_run_id
     WHERE t.firm_id = ${firm.id}
       AND sr.sop_key = 'gsc_setup'
       AND t.source_type = 'sop'`);
  console.log(`\nGSC setup config-gate tickets: ${gateRows.rowCount ?? gateRows.rows?.length ?? 0}`);
  for (const r of gateRows.rows ?? []) {
    console.log(`  ${r.id}  ${r.status}  ${r.title}`);
  }

  // Sample ticket descriptions to spot-check the prescription content
  const sample = await db.execute<{
    sop_key: string; action: string; title: string; description: string; remediation_copy: string;
  }>(sql`
    SELECT sr.sop_key, lf.action, t.title, t.description, t.remediation_copy
      FROM remediation_ticket t
      JOIN sop_run sr ON sr.id = t.sop_run_id
      JOIN legacy_finding lf ON lf.id = t.source_id
     WHERE t.firm_id = ${firm.id}
       AND t.source_type = 'legacy'
  ORDER BY lf.action
     LIMIT 5`);
  console.log('\nSample tickets:');
  for (const r of sample.rows ?? []) {
    console.log(`\n  [${r.sop_key} | ${r.action}] ${r.title}`);
    console.log(`    description: ${(r.description ?? '').slice(0, 200)}…`);
    console.log(`    remediation: ${(r.remediation_copy ?? '').slice(0, 200)}…`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
