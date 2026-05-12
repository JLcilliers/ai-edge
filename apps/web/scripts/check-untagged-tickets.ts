/**
 * One-shot diagnostic: what source_types produce tickets without
 * sop_run_id? The answer determines fix strategy:
 *   - 1-2 source_types: targeted backfill + targeted guard
 *   - 3+ source_types: cheap guard at insert time + general backfill
 */
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
const _d = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolvePath(_d, '../../../.env.local'), override: true });

import { getDb, firms, remediationTickets, sopRuns } from '@ai-edge/db';
import { eq, sql, isNull, and } from 'drizzle-orm';

async function main() {
  const db = getDb();

  // Global breakdown — every firm, every source_type with null sop_run_id.
  const global = await db.execute<{ source_type: string; n: bigint }>(
    sql`
      SELECT source_type, COUNT(*)::bigint AS n
      FROM remediation_ticket
      WHERE sop_run_id IS NULL
      GROUP BY source_type
      ORDER BY n DESC
    `,
  );
  console.log('\n── Global: null sop_run_id by source_type ──');
  for (const row of global.rows ?? []) {
    console.log(`  ${row.source_type.padEnd(12)} ${String(row.n)}`);
  }

  // Same for Andrew Pickett Law specifically.
  const [apl] = await db
    .select({ id: firms.id })
    .from(firms)
    .where(eq(firms.slug, 'andrew-pickett-law'))
    .limit(1);
  if (apl) {
    const aplBreakdown = await db.execute<{ source_type: string; n: bigint; status: string }>(
      sql`
        SELECT source_type, status, COUNT(*)::bigint AS n
        FROM remediation_ticket
        WHERE sop_run_id IS NULL AND firm_id = ${apl.id}
        GROUP BY source_type, status
        ORDER BY source_type, status
      `,
    );
    console.log('\n── APL: null sop_run_id by source_type × status ──');
    for (const row of aplBreakdown.rows ?? []) {
      console.log(`  ${row.source_type.padEnd(12)} ${row.status.padEnd(14)} ${String(row.n)}`);
    }

    // Sample 5 tickets per source_type to confirm pattern.
    const sources = [...new Set((aplBreakdown.rows ?? []).map((r) => r.source_type))];
    for (const src of sources) {
      const samples = await db.execute<{
        id: string;
        title: string | null;
        playbook_step: string | null;
        created_at: Date;
      }>(
        sql`
          SELECT id, title, playbook_step, created_at
          FROM remediation_ticket
          WHERE firm_id = ${apl.id}
            AND sop_run_id IS NULL
            AND source_type = ${src}
          ORDER BY created_at DESC
          LIMIT 5
        `,
      );
      console.log(`\n── APL sample: source_type='${src}' ──`);
      for (const row of samples.rows ?? []) {
        const title = row.title ?? '(no title)';
        const truncated = title.length > 60 ? `${title.slice(0, 57)}...` : title;
        console.log(`  ${row.id.slice(0, 8)} · ${String(row.playbook_step ?? '—').padEnd(12)} · ${truncated}`);
      }
    }

    // Check if APL has the right sop_runs to anchor backfill against.
    const aplRuns = await db
      .select({ sopKey: sopRuns.sop_key, id: sopRuns.id })
      .from(sopRuns)
      .where(eq(sopRuns.firm_id, apl.id));
    console.log(`\n── APL sop_runs (backfill targets) ──`);
    for (const r of aplRuns) {
      console.log(`  ${r.sopKey.padEnd(40)} ${r.id.slice(0, 8)}`);
    }
  }

  // Tickets WITH sop_run_id by source_type (sanity check — what the
  // happy path looks like).
  const tagged = await db.execute<{ source_type: string; n: bigint }>(
    sql`
      SELECT source_type, COUNT(*)::bigint AS n
      FROM remediation_ticket
      WHERE sop_run_id IS NOT NULL
      GROUP BY source_type
      ORDER BY n DESC
    `,
  );
  console.log('\n── Global: WITH sop_run_id by source_type (happy path) ──');
  for (const row of tagged.rows ?? []) {
    console.log(`  ${row.source_type.padEnd(12)} ${String(row.n)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
