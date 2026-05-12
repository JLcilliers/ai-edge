/**
 * One-off: delete the 3 stale `provider:'none'` aio_capture rows for
 * Andrew Pickett Law that were created by the local-script bootstrap
 * auto-enrichment (which had no DATAFORSEO creds). The fresh 5 rows
 * from the production "Capture now" trigger have `provider:'dataforseo'`
 * and stay.
 */
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
const _d = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolvePath(_d, '../../../.env.local'), override: true });

import { getDb, firms, aioCaptures } from '@ai-edge/db';
import { eq, and } from 'drizzle-orm';

async function main() {
  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id })
    .from(firms)
    .where(eq(firms.slug, 'andrew-pickett-law'))
    .limit(1);
  if (!firm) {
    console.log('firm not found');
    return;
  }

  const deleted = await db
    .delete(aioCaptures)
    .where(and(eq(aioCaptures.firm_id, firm.id), eq(aioCaptures.provider, 'none')))
    .returning({ id: aioCaptures.id });

  console.log(`deleted ${deleted.length} stale provider=none aio_capture rows`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
