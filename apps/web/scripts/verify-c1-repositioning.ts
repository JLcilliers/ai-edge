import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
const _d = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolvePath(_d, '../../../.env.local'), override: true });

import { getDb, remediationTickets, sopRuns } from '@ai-edge/db';
import { and, eq, sql } from 'drizzle-orm';
import { runRepositioningScanBySlug } from '../app/lib/content/repositioning-scanner';

async function main() {
  const r = await runRepositioningScanBySlug('andrew-pickett-law');
  console.log('Repositioning scan result:', r);
  const db = getDb();
  const status = await db.execute<{ status: string; n: bigint; titles: string }>(sql`
    SELECT t.status::text AS status, COUNT(*)::bigint AS n,
           STRING_AGG(t.title, ' || ' ORDER BY t.priority_rank NULLS LAST) AS titles
      FROM remediation_ticket t
      JOIN sop_run sr ON sr.id = t.sop_run_id
     WHERE sr.sop_key = 'content_repositioning'
       AND t.source_type = 'legacy'
  GROUP BY 1`);
  for (const row of status.rows ?? []) {
    console.log(`\nstatus=${row.status}  count=${row.n}`);
    const titles = String(row.titles).split(' || ').slice(0, 5);
    for (const t of titles) console.log(`  · ${t}`);
  }

  const step = await db.execute<{ sop_step_number: number | null; n: bigint }>(sql`
    SELECT t.sop_step_number, COUNT(*)::bigint AS n
      FROM remediation_ticket t
      JOIN sop_run sr ON sr.id = t.sop_run_id
     WHERE sr.sop_key = 'content_repositioning'
       AND t.source_type = 'legacy'
  GROUP BY 1`);
  console.log('\nstep distribution on content_repositioning legacy tickets:');
  for (const row of step.rows ?? []) {
    console.log(`  step=${row.sop_step_number}  n=${row.n}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
