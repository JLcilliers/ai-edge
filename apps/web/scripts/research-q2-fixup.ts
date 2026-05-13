import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
const _d = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolvePath(_d, '../../../.env.local'), override: true });

import { getDb } from '@ai-edge/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = getDb();
  const r = await db.execute<{ kind: string; n: bigint }>(sql`
    WITH apl AS (
      SELECT t.id, t.title, t.description, t.source_type, t.playbook_step
        FROM remediation_ticket t
        JOIN firm f ON f.id = t.firm_id
       WHERE f.slug = 'andrew-pickett-law'
         AND t.status IN ('open','in_progress')
    )
    SELECT 'title_factual_or_incorrect' AS kind, COUNT(*) FILTER (WHERE title ~* 'incorrect|factual|wrong')::bigint AS n FROM apl
    UNION ALL SELECT 'title_didnt_mention',           COUNT(*) FILTER (WHERE title ~* 'didn''t mention|did not mention')::bigint FROM apl
    UNION ALL SELECT 'title_positioning_off',         COUNT(*) FILTER (WHERE title ~* 'positioning off')::bigint FROM apl
    UNION ALL SELECT 'title_reposition',              COUNT(*) FILTER (WHERE title ~* '^reposition')::bigint FROM apl
    UNION ALL SELECT 'title_no_index',                COUNT(*) FILTER (WHERE title ~* '^no-index')::bigint FROM apl
    UNION ALL SELECT 'title_redirect_or_delete',      COUNT(*) FILTER (WHERE title ~* '^redirect|^delete')::bigint FROM apl
    UNION ALL SELECT 'source_type:audit',             COUNT(*) FILTER (WHERE source_type='audit')::bigint FROM apl
    UNION ALL SELECT 'source_type:legacy',            COUNT(*) FILTER (WHERE source_type='legacy')::bigint FROM apl
    UNION ALL SELECT 'source_type:entity',            COUNT(*) FILTER (WHERE source_type='entity')::bigint FROM apl
    UNION ALL SELECT 'source_type:reddit',            COUNT(*) FILTER (WHERE source_type='reddit')::bigint FROM apl
    UNION ALL SELECT 'source_type:sop',               COUNT(*) FILTER (WHERE source_type='sop')::bigint FROM apl
    UNION ALL SELECT 'total',                         COUNT(*)::bigint FROM apl`);
  for (const row of r.rows ?? []) console.log(`  ${String(row.kind).padEnd(34)} ${row.n}`);

  // Also: priority_rank distribution by source_type — to confirm whether
  // the ranks reset per-source.
  console.log('\nQ2.1b — priority_rank by source_type');
  const rankBySource = await db.execute<{ source_type: string; rank_set: bigint; rank_null: bigint; rank_max: number | null }>(sql`
    SELECT t.source_type,
           COUNT(*) FILTER (WHERE t.priority_rank IS NOT NULL)::bigint AS rank_set,
           COUNT(*) FILTER (WHERE t.priority_rank IS NULL)::bigint     AS rank_null,
           MAX(t.priority_rank) AS rank_max
      FROM remediation_ticket t
      JOIN firm f ON f.id = t.firm_id
     WHERE f.slug = 'andrew-pickett-law'
       AND t.status IN ('open','in_progress')
  GROUP BY t.source_type
  ORDER BY t.source_type`);
  for (const row of rankBySource.rows ?? []) {
    console.log(`  ${String(row.source_type).padEnd(10)} rank_set=${row.rank_set}  rank_null=${row.rank_null}  rank_max=${row.rank_max ?? '∅'}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
