import {
  getDb,
  firms,
  scenarios,
  serpSnapshots,
  pageFeatures,
  rankerWeights,
} from '@ai-edge/db';
import { eq } from 'drizzle-orm';
import { isAuthorizedCronRequest, unauthorizedResponse } from '../../../lib/cron/auth';

/**
 * One-shot data-cleanup runner for the Scenario Lab.
 *
 * Wipes every Scenario Lab row for the named firm — used to revert the
 * smoke-test state on Andrew Pickett Law, where the SERPs and weights were
 * synthetic. Leaves the schema in place (you can re-extract / re-paste
 * once Phase B live-SERP capture is wired).
 *
 * Authorization: same CRON_SECRET as the migration route. Pass `?slug=`
 * (or POST body { slug }) to scope to one firm; omit for nothing (we
 * default to a no-op rather than wipe-everything to avoid blowing away
 * other firms' data on a stray POST).
 *
 * Cascade: serp_result is FK ON DELETE CASCADE on serp_snapshot, so
 * deleting snapshots removes the result rows automatically. Same for
 * scenario / page_features / ranker_weights — they're all firm-scoped
 * with ON DELETE CASCADE on firm_id, but we delete by firm_id here
 * directly since we don't want to touch the firm row.
 *
 * Idempotent: re-running on a clean firm returns zeros and a 200.
 */

async function runCleanup(req: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(req)) return unauthorizedResponse();

  const url = new URL(req.url);
  let slug = url.searchParams.get('slug');
  if (!slug && req.method === 'POST') {
    try {
      const body = (await req.json()) as { slug?: string };
      slug = body?.slug ?? null;
    } catch {
      /* ignore non-JSON bodies */
    }
  }
  if (!slug) {
    return Response.json(
      { error: 'firm slug required (?slug=… or POST body { slug })' },
      { status: 400 },
    );
  }

  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id, name: firms.name })
    .from(firms)
    .where(eq(firms.slug, slug))
    .limit(1);
  if (!firm) {
    return Response.json({ error: `firm not found: ${slug}` }, { status: 404 });
  }

  // Delete order: scenarios first (no children), then serp_snapshots
  // (cascades to serp_result), then page_features, then ranker_weights.
  // Drizzle's `.returning({ id })` lets us count without an extra query.
  const scenariosDeleted = await db
    .delete(scenarios)
    .where(eq(scenarios.firm_id, firm.id))
    .returning({ id: scenarios.id });
  const snapshotsDeleted = await db
    .delete(serpSnapshots)
    .where(eq(serpSnapshots.firm_id, firm.id))
    .returning({ id: serpSnapshots.id });
  const featuresDeleted = await db
    .delete(pageFeatures)
    .where(eq(pageFeatures.firm_id, firm.id))
    .returning({ id: pageFeatures.id });
  const weightsDeleted = await db
    .delete(rankerWeights)
    .where(eq(rankerWeights.firm_id, firm.id))
    .returning({ id: rankerWeights.id });

  return Response.json({
    ok: true,
    firm: { slug, name: firm.name },
    deleted: {
      scenarios: scenariosDeleted.length,
      serp_snapshots: snapshotsDeleted.length,
      page_features: featuresDeleted.length,
      ranker_weights: weightsDeleted.length,
    },
  });
}

export const POST = runCleanup;
export const GET = runCleanup;
