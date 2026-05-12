import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
const _d = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolvePath(_d, '../../../.env.local'), override: true });

import { getDb, cronRuns } from '@ai-edge/db';
import { eq, desc, and, sql } from 'drizzle-orm';

async function main() {
  const db = getDb();
  const rows = await db.select().from(cronRuns)
    .where(eq(cronRuns.cron_name, 'aio-capture'))
    .orderBy(desc(cronRuns.started_at)).limit(5);
  console.log(`recent aio-capture cron runs (most recent first):`);
  for (const r of rows) {
    const ageMs = Date.now() - r.started_at.getTime();
    console.log(`  ${r.id.slice(0,8)}  status=${r.status.padEnd(8)}  started=${r.started_at.toISOString()} (${Math.round(ageMs/1000)}s ago)  finished=${r.finished_at?.toISOString() ?? '—'}  dur=${r.duration_ms ?? '—'}ms`);
    if (r.error) console.log(`    error: ${r.error.slice(0,200)}`);
    if (r.summary) console.log(`    summary: ${JSON.stringify(r.summary).slice(0,400)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
