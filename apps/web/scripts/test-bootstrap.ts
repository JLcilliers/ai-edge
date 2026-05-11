/**
 * Integration test for Brand Truth bootstrap.
 *
 * 1. Creates a throwaway firm "bootstrap-test" pointing at the URL passed
 *    via TEST_URL env (default: https://reimerhvac.com).
 * 2. Runs bootstrapBrandTruthForFirm.
 * 3. Prints provenance + a summary of which BT fields got populated.
 * 4. Deletes the firm + its bootstrap row at the end so we don't pollute
 *    the workspace list.
 *
 * Run:
 *   TEST_URL=https://reimerhvac.com TEST_TYPE=other corepack pnpm --filter @ai-edge/web exec tsx scripts/test-bootstrap.ts
 */
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
const _d = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolvePath(_d, '../../../.env.local'), override: true });

import { getDb, firms, brandTruthVersions } from '@ai-edge/db';
import { eq } from 'drizzle-orm';
import type { FirmType } from '@ai-edge/shared';
import { bootstrapBrandTruthForFirm } from '../app/actions/brand-truth-actions';

async function main() {
  const TEST_SLUG = 'bootstrap-test';
  const TEST_URL = process.env.TEST_URL ?? 'https://reimerhvac.com';
  const TEST_TYPE = (process.env.TEST_TYPE ?? 'other') as FirmType;
  const TEST_NAME = process.env.TEST_NAME ?? 'Bootstrap Test Firm';

  const db = getDb();

  // Cleanup any prior run
  const existing = await db
    .select({ id: firms.id })
    .from(firms)
    .where(eq(firms.slug, TEST_SLUG))
    .limit(1);
  if (existing.length > 0) {
    await db.delete(firms).where(eq(firms.slug, TEST_SLUG));
    console.log(`[test-bootstrap] cleaned up prior test firm`);
  }

  // Seed firm
  const [created] = await db
    .insert(firms)
    .values({ slug: TEST_SLUG, name: TEST_NAME, firm_type: TEST_TYPE })
    .returning({ id: firms.id });
  console.log(`[test-bootstrap] created firm slug=${TEST_SLUG} id=${created!.id}`);

  // Bootstrap
  console.log(`[test-bootstrap] bootstrapping from ${TEST_URL} ...`);
  const t0 = Date.now();
  const result = await bootstrapBrandTruthForFirm(TEST_SLUG, TEST_URL);
  const wallSec = ((Date.now() - t0) / 1000).toFixed(1);

  if (!result.ok) {
    console.error(`[test-bootstrap] FAILED in ${wallSec}s: ${result.error}`);
    await db.delete(firms).where(eq(firms.slug, TEST_SLUG));
    process.exit(1);
  }

  console.log(`[test-bootstrap] OK in ${wallSec}s — version=${result.version} cost=$${result.costUsd.toFixed(4)} latency=${(result.latencyMs / 1000).toFixed(1)}s`);
  console.log(`  pages used (${result.pagesUsed.length}):`);
  for (const u of result.pagesUsed) console.log(`    - ${u}`);

  // Fetch the persisted payload and show what fields landed
  const [row] = await db
    .select({ payload: brandTruthVersions.payload, meta: brandTruthVersions.bootstrap_meta })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, created!.id))
    .limit(1);

  if (!row) throw new Error('persisted row missing');

  const p = row.payload as Record<string, unknown>;
  console.log('\n[test-bootstrap] populated fields:');
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const summary: Record<string, unknown> = {
    firm_name: p.firm_name,
    primary_url: p.primary_url,
    name_variants: len(p.name_variants),
    common_misspellings: len(p.common_misspellings),
    headquarters: !!p.headquarters,
    unique_differentiators: len(p.unique_differentiators),
    required_positioning_phrases: len(p.required_positioning_phrases),
    seed_query_intents: len(p.seed_query_intents),
    competitors_for_llm_monitoring: len(p.competitors_for_llm_monitoring),
    tone_guidelines: !!p.tone_guidelines,
    target_audience: !!p.target_audience,
    awards: len(p.awards),
    third_party_listings: len(p.third_party_listings),
    banned_claims: len(p.banned_claims),
  };
  // Firm-type-specific fields
  if ('practice_areas' in p) summary.practice_areas = len(p.practice_areas);
  if ('geographies_served' in p) summary.geographies_served = len(p.geographies_served);
  if ('service_offerings' in p) summary.service_offerings = len(p.service_offerings);
  if ('service_areas' in p) summary.service_areas = len(p.service_areas);
  if ('attorney_bios' in p) summary.attorney_bios = len(p.attorney_bios);
  if ('provider_bios' in p) summary.provider_bios = len(p.provider_bios);
  if ('team_members' in p) summary.team_members = len(p.team_members);
  console.log(JSON.stringify(summary, null, 2));

  console.log('\n[test-bootstrap] sample query intents:');
  for (const q of (p.seed_query_intents as string[] | undefined ?? []).slice(0, 5)) {
    console.log(`    "${q}"`);
  }

  console.log('\n[test-bootstrap] bootstrap_meta:');
  console.log(JSON.stringify(row.meta, null, 2));

  // Cleanup
  await db.delete(firms).where(eq(firms.slug, TEST_SLUG));
  console.log('\n[test-bootstrap] cleaned up. done.');
}

main().catch((e) => {
  console.error('[test-bootstrap] FATAL', e);
  process.exit(1);
});
