import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
const _d = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolvePath(_d, '../../../.env.local'), override: true });

import { getDb, firms, aioCaptures } from '@ai-edge/db';
import { eq, desc } from 'drizzle-orm';

async function main() {
  const db = getDb();
  const [firm] = await db.select({ id: firms.id }).from(firms).where(eq(firms.slug, 'andrew-pickett-law')).limit(1);
  if (!firm) { console.log('not found'); return; }

  const rows = await db.select().from(aioCaptures)
    .where(eq(aioCaptures.firm_id, firm.id))
    .orderBy(desc(aioCaptures.fetched_at));

  console.log(`Andrew Pickett Law has ${rows.length} aio_capture rows:`);
  for (const r of rows) {
    console.log(`  provider=${r.provider}  has_aio=${r.has_aio}  firm_cited=${r.firm_cited}  query="${r.query}"`);
    if (r.raw && typeof r.raw === 'object' && 'error' in r.raw) {
      console.log(`    reason: ${(r.raw as { error: string }).error}`);
    }
  }
  console.log(`\nLocal env has DATAFORSEO_LOGIN? ${!!process.env.DATAFORSEO_LOGIN}`);
  console.log(`Local env has DATAFORSEO_PASSWORD? ${!!process.env.DATAFORSEO_PASSWORD}`);
}
main().catch(e => { console.error(e); process.exit(1); });
