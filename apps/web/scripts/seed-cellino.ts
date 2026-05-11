/**
 * Seed the Cellino Law demo firm.
 *
 *   corepack pnpm --filter @ai-edge/web dotenv -e .env.local -- node --experimental-strip-types scripts/seed-cellino.ts
 *
 * Idempotent: re-running upserts the firm + competitor roster and writes a
 * fresh brand_truth_version row only if the payload changed.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

// tsx's CJS bridge leaves `import.meta.dirname` undefined; derive it from
// `import.meta.url` so the script works in both ESM and CJS execution paths.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Load .env.local with override so file values win over preexisting shell env.
dotenvConfig({
  path: resolve(SCRIPT_DIR, '../../../.env.local'),
  override: true,
});

import { getDb, firms, brandTruthVersions, competitors } from '@ai-edge/db';
import { brandTruthSchema } from '@ai-edge/shared';
import { eq, desc, and } from 'drizzle-orm';

type SeedFile = {
  firm_slug: string;
  firm_name_legal: string;
  payload: unknown;
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[seed] DATABASE_URL is not set — load .env.local first');
    process.exit(1);
  }

  // Anchor the path at this script's directory so it works from any CWD.
  const seedPath = resolve(SCRIPT_DIR, '../../../docs/seed-brand-truth-cellino.json');
  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedFile;

  // Validate the BT payload up front — this is the same check `saveBrandTruth`
  // runs, so the seed never inserts a payload the editor would reject.
  const parsed = brandTruthSchema.safeParse(seed.payload);
  if (!parsed.success) {
    console.error('[seed] brand_truth payload failed Zod validation:');
    console.error(parsed.error.format());
    process.exit(1);
  }
  const payload = parsed.data;

  const db = getDb();

  // 1. UPSERT firm by slug.
  const existing = await db
    .select({ id: firms.id, name: firms.name })
    .from(firms)
    .where(eq(firms.slug, seed.firm_slug))
    .limit(1);

  let firmId: string;
  if (existing.length > 0) {
    firmId = existing[0]!.id;
    console.log(`[seed] firm "${seed.firm_slug}" already exists (${firmId})`);
  } else {
    const [inserted] = await db
      .insert(firms)
      .values({
        slug: seed.firm_slug,
        name: payload.firm_name,
        firm_type: payload.firm_type,
      })
      .returning({ id: firms.id });
    firmId = inserted!.id;
    console.log(`[seed] created firm "${seed.firm_slug}" → ${firmId}`);
  }

  // 2. Insert a new brand_truth_version unless the current latest matches.
  const [latest] = await db
    .select({ payload: brandTruthVersions.payload, version: brandTruthVersions.version })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);

  const newPayloadStr = JSON.stringify(payload);
  if (latest && JSON.stringify(latest.payload) === newPayloadStr) {
    console.log(`[seed] brand_truth_version v${latest.version} matches seed — no new row`);
  } else {
    const nextVersion = (latest?.version ?? 0) + 1;
    await db.insert(brandTruthVersions).values({
      firm_id: firmId,
      version: nextVersion,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: payload as any,
      created_by: 'demo-seed',
    });
    console.log(`[seed] wrote brand_truth_version v${nextVersion}`);
  }

  // 3. UPSERT competitors from `competitors_for_llm_monitoring`. Detection
  //    looks at the `competitor` table, so this is the row that has to exist
  //    for share-of-voice + praise asymmetry to populate.
  const roster = (payload as { competitors_for_llm_monitoring?: string[] })
    .competitors_for_llm_monitoring ?? [];
  for (const name of roster) {
    const [present] = await db
      .select({ id: competitors.id })
      .from(competitors)
      .where(and(eq(competitors.firm_id, firmId), eq(competitors.name, name)))
      .limit(1);
    if (!present) {
      await db.insert(competitors).values({ firm_id: firmId, name });
      console.log(`[seed]   + competitor "${name}"`);
    }
  }

  console.log('[seed] done.');
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
