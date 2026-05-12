/**
 * One-shot backfill: attach sop_run_id to every legacy remediation_ticket
 * that was inserted before the four legacy scanners (run-audit,
 * suppression/scan, entity/scan, entity/cross-source-scan, reddit/scan)
 * were patched to call ensureSopRun().
 *
 * Maps source_type → SopKey deterministically:
 *   'audit'   → 'brand_visibility_audit'
 *   'legacy'  → 'legacy_content_suppression'
 *   'entity'  → 'entity_optimization'
 *   'reddit'  → 'reddit_brand_sentiment_monitoring'
 *   'sop'     → leaves alone (already attached, skipped at query level)
 *
 * For each firm with at least one null-sop_run_id ticket, find-or-create
 * the matching sop_run via ensureSopRun, then UPDATE all tickets in that
 * (firm, source_type) bucket in a single statement.
 *
 * Idempotent. After running once with zero new failures, the follow-up
 * migration 0016 can apply the NOT NULL constraint safely.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-untagged-tickets.ts
 *   pnpm exec tsx scripts/backfill-untagged-tickets.ts --dry-run
 *   pnpm exec tsx scripts/backfill-untagged-tickets.ts --slug andrew-pickett-law
 */

import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
const _d = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolvePath(_d, '../../../.env.local'), override: true });

import { getDb, firms, remediationTickets } from '@ai-edge/db';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { ensureSopRun } from '../app/lib/sop/ensure-run';
import type { SopKey } from '../app/lib/sop/types';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SLUG_FILTER = (() => {
  const i = args.indexOf('--slug');
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
})();

// source_type → SopKey mapping. 'sop' is the happy path (already attached
// via createTicketFromStep) and isn't in the loop.
const SOURCE_TO_SOP_KEY: Record<string, SopKey> = {
  audit: 'brand_visibility_audit',
  legacy: 'legacy_content_suppression',
  entity: 'entity_optimization',
  reddit: 'reddit_brand_sentiment_monitoring',
};

async function main() {
  const db = getDb();

  // Find every (firm_id, source_type) bucket with null sop_run_id.
  const bucketsSql = SLUG_FILTER
    ? sql`
        SELECT t.firm_id, t.source_type, COUNT(*)::int AS n
        FROM remediation_ticket t
        INNER JOIN firm f ON f.id = t.firm_id
        WHERE t.sop_run_id IS NULL AND f.slug = ${SLUG_FILTER}
        GROUP BY t.firm_id, t.source_type
      `
    : sql`
        SELECT firm_id, source_type, COUNT(*)::int AS n
        FROM remediation_ticket
        WHERE sop_run_id IS NULL
        GROUP BY firm_id, source_type
      `;
  const buckets = await db.execute<{ firm_id: string; source_type: string; n: number }>(
    bucketsSql,
  );

  if ((buckets.rows ?? []).length === 0) {
    console.log('✓ No untagged tickets — nothing to backfill.');
    return;
  }

  console.log(
    `${DRY_RUN ? '[DRY RUN] ' : ''}Found ${(buckets.rows ?? []).length} (firm × source_type) buckets to backfill:`,
  );

  // Group by firm for nicer logging + ensureSopRun reuse within firm.
  const byFirm = new Map<string, Array<{ sourceType: string; count: number }>>();
  for (const row of buckets.rows ?? []) {
    if (!byFirm.has(row.firm_id)) byFirm.set(row.firm_id, []);
    byFirm.get(row.firm_id)!.push({ sourceType: row.source_type, count: Number(row.n) });
  }

  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const [firmId, bucketsForFirm] of byFirm) {
    const [firm] = await db
      .select({ id: firms.id, slug: firms.slug, name: firms.name })
      .from(firms)
      .where(eq(firms.id, firmId))
      .limit(1);
    if (!firm) {
      console.log(`  ! ${firmId.slice(0, 8)}: firm not found, skipping`);
      continue;
    }
    console.log(`\n  ${firm.name} (${firm.slug})`);
    for (const { sourceType, count } of bucketsForFirm) {
      const sopKey = SOURCE_TO_SOP_KEY[sourceType];
      if (!sopKey) {
        console.log(`    - source_type='${sourceType}': no mapping, skipping ${count} ticket(s)`);
        totalSkipped += count;
        continue;
      }
      if (DRY_RUN) {
        console.log(
          `    [DRY] source_type='${sourceType}' → ${sopKey}: would update ${count} ticket(s)`,
        );
        continue;
      }
      const sopRunId = await ensureSopRun(firm.id, sopKey, 'backfill:0016');
      const result = await db
        .update(remediationTickets)
        .set({ sop_run_id: sopRunId })
        .where(
          and(
            eq(remediationTickets.firm_id, firm.id),
            eq(remediationTickets.source_type, sourceType),
            isNull(remediationTickets.sop_run_id),
          ),
        );
      console.log(
        `    ✓ source_type='${sourceType}' → ${sopKey} (run ${sopRunId.slice(0, 8)}): updated ${count} ticket(s)`,
      );
      totalUpdated += count;
    }
  }

  // Verify zero nulls remain (unless we filtered by slug).
  if (!DRY_RUN && !SLUG_FILTER) {
    const [check] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(remediationTickets)
      .where(isNull(remediationTickets.sop_run_id));
    const remaining = check?.n ?? 0;
    if (remaining === 0) {
      console.log('\n✓ Zero null sop_run_id remaining — migration 0016 can apply safely.');
    } else {
      console.log(
        `\n⚠ ${remaining} null sop_run_id ticket(s) remaining — investigate before migration 0016.`,
      );
      console.log(
        '  Likely cause: unmapped source_type. Run check-untagged-tickets.ts to see breakdown.',
      );
      process.exit(1);
    }
  }

  console.log(
    `\nSummary: ${DRY_RUN ? '(dry run) ' : ''}updated=${totalUpdated} skipped=${totalSkipped}`,
  );
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
