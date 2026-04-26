import {
  getDb,
  serpSnapshots,
  serpResults,
  pageFeatures,
  rankerWeights,
} from '@ai-edge/db';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { calibrateWeightsPSO, type SerpObservation, type PSOOptions } from './pso';
import { evaluateFitness } from './pso';
import type { FeatureVec, Weights } from './ranker-feature-list';

/**
 * Calibration orchestrator.
 *
 * Flow:
 *   1. Load every SERP snapshot (and its results) for the firm.
 *   2. For each result URL, look up its `page_features` row. URLs with no
 *      features are SKIPPED — calibration only weighs URLs we know about.
 *      (We surface the skip count in the result so the UI can prompt the
 *      operator to extract features for missing URLs.)
 *   3. Build SerpObservation[] (query → results with features).
 *   4. Run PSO. Persist as a new ranker_weights row, generation = max(prev) + 1.
 *
 * Cold-start behaviour:
 *   - Zero SERPs → throws "no calibration corpus." UI catches and renders
 *     "Add a SERP first" prompt.
 *   - <2 results per snapshot → those snapshots get filtered (Spearman
 *     undefined). If ALL snapshots filter out, we throw "insufficient data."
 *   - Zero URLs with extracted features → throws "extract features first."
 */

const DEFAULT_PSO_OPTIONS: PSOOptions = {
  particles: 30,
  iterations: 200,
  inertia: 0.7,
  cognitive: 1.4,
  social: 1.4,
  bounds: [-2, 2],
  // Default seed = stable per firm/run via current timestamp; caller can
  // override for repro.
  seed: undefined,
};

export interface CalibrationOutcome {
  generation: number;
  fitness: number;
  observationCount: number;
  resultsConsidered: number;
  resultsSkippedNoFeatures: number;
  weightsId: string;
  iterationFitnesses: number[];
}

export async function runCalibration(
  firmId: string,
  options: PSOOptions = {},
): Promise<CalibrationOutcome> {
  const db = getDb();

  // 1. Load SERPs + results for the firm.
  const snapshots = await db
    .select()
    .from(serpSnapshots)
    .where(eq(serpSnapshots.firm_id, firmId));
  if (snapshots.length === 0) {
    throw new Error(
      'No SERP corpus for this firm — paste at least one observed SERP before running calibration.',
    );
  }
  const snapshotIds = snapshots.map((s) => s.id);
  const results = await db
    .select()
    .from(serpResults)
    .where(inArray(serpResults.snapshot_id, snapshotIds));

  // 2. Pull feature vectors for every URL we'll need.
  const urls = Array.from(new Set(results.map((r) => r.url)));
  if (urls.length === 0) {
    throw new Error('SERPs exist but have no result rows — paste-in incomplete?');
  }
  const features = await db
    .select()
    .from(pageFeatures)
    .where(
      and(
        eq(pageFeatures.firm_id, firmId),
        inArray(pageFeatures.url, urls),
      ),
    );
  const featureByUrl = new Map<string, FeatureVec>(
    features.map((f) => [f.url, f.features as unknown as FeatureVec]),
  );

  // 3. Build observations, skipping rows with no features.
  let resultsSkipped = 0;
  let resultsConsidered = 0;
  const observations: SerpObservation[] = [];
  for (const snap of snapshots) {
    const rows = results
      .filter((r) => r.snapshot_id === snap.id)
      .sort((a, b) => a.position - b.position);
    const observed: SerpObservation['results'] = [];
    for (const r of rows) {
      const fv = featureByUrl.get(r.url);
      if (!fv) {
        resultsSkipped += 1;
        continue;
      }
      observed.push({ url: r.url, position: r.position, features: fv });
      resultsConsidered += 1;
    }
    if (observed.length >= 2) {
      observations.push({ query: snap.query, results: observed });
    }
  }

  if (observations.length === 0) {
    throw new Error(
      `Insufficient calibration data: skipped ${resultsSkipped} URL(s) with no features. ` +
        `Run feature extraction on at least two URLs per SERP, then retry.`,
    );
  }

  // 4. PSO. Seed defaults to a hash of (firmId, snapshot count) for repro
  // across reruns of the same corpus.
  const seed =
    options.seed ??
    Math.abs(
      hashString(firmId + ':' + snapshots.length + ':' + resultsConsidered),
    ) >>> 0;
  const psoOptions: PSOOptions = { ...DEFAULT_PSO_OPTIONS, ...options, seed };
  const psoResult = calibrateWeightsPSO(observations, psoOptions);

  // 5. Generation = max(prev) + 1.
  const [latest] = await db
    .select({ gen: rankerWeights.generation })
    .from(rankerWeights)
    .where(eq(rankerWeights.firm_id, firmId))
    .orderBy(desc(rankerWeights.generation))
    .limit(1);
  const nextGeneration = (latest?.gen ?? 0) + 1;

  const [inserted] = await db
    .insert(rankerWeights)
    .values({
      firm_id: firmId,
      generation: nextGeneration,
      weights: psoResult.weights as Record<string, number>,
      fitness: psoResult.fitness,
      observation_count: observations.length,
      pso_params: {
        particles: psoOptions.particles,
        iterations: psoOptions.iterations,
        inertia: psoOptions.inertia,
        cognitive: psoOptions.cognitive,
        social: psoOptions.social,
        bounds: psoOptions.bounds,
        seed,
      },
    })
    .returning({ id: rankerWeights.id });

  return {
    generation: nextGeneration,
    fitness: psoResult.fitness,
    observationCount: observations.length,
    resultsConsidered,
    resultsSkippedNoFeatures: resultsSkipped,
    weightsId: inserted!.id,
    iterationFitnesses: psoResult.iterationFitnesses,
  };
}

/**
 * Return the latest ranker_weights row for a firm, or null if calibration
 * has never been run. Keys off `generation desc`, not trained_at, so a
 * mid-flight calibration retry doesn't accidentally surface as "latest."
 */
export async function getLatestWeights(firmId: string): Promise<{
  id: string;
  generation: number;
  weights: Weights;
  fitness: number;
  observationCount: number;
  trainedAt: Date;
} | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(rankerWeights)
    .where(eq(rankerWeights.firm_id, firmId))
    .orderBy(desc(rankerWeights.generation))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    generation: row.generation,
    weights: row.weights as unknown as Weights,
    fitness: row.fitness,
    observationCount: row.observation_count,
    trainedAt: row.trained_at,
  };
}

function hashString(s: string): number {
  // FNV-1a 32-bit. Good enough for seeding; not cryptographic.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * Re-evaluate stored fitness against current corpus + stored weights.
 * Useful for the admin UI to detect "did the firm add SERPs since the
 * last calibration?" — a positive answer means the operator should re-run
 * calibration to incorporate the new evidence.
 */
export async function recomputeStoredFitness(
  firmId: string,
): Promise<number | null> {
  const db = getDb();
  const w = await getLatestWeights(firmId);
  if (!w) return null;

  const snapshots = await db
    .select()
    .from(serpSnapshots)
    .where(eq(serpSnapshots.firm_id, firmId));
  if (snapshots.length === 0) return null;
  const snapshotIds = snapshots.map((s) => s.id);
  const results = await db
    .select()
    .from(serpResults)
    .where(inArray(serpResults.snapshot_id, snapshotIds));

  const urls = Array.from(new Set(results.map((r) => r.url)));
  const features = await db
    .select()
    .from(pageFeatures)
    .where(
      and(
        eq(pageFeatures.firm_id, firmId),
        inArray(pageFeatures.url, urls),
      ),
    );
  const featureByUrl = new Map<string, FeatureVec>(
    features.map((f) => [f.url, f.features as unknown as FeatureVec]),
  );

  const observations: SerpObservation[] = [];
  for (const snap of snapshots) {
    const rows = results
      .filter((r) => r.snapshot_id === snap.id)
      .sort((a, b) => a.position - b.position);
    const observed: SerpObservation['results'] = [];
    for (const r of rows) {
      const fv = featureByUrl.get(r.url);
      if (!fv) continue;
      observed.push({ url: r.url, position: r.position, features: fv });
    }
    if (observed.length >= 2) {
      observations.push({ query: snap.query, results: observed });
    }
  }
  if (observations.length === 0) return null;
  return evaluateFitness(observations, w.weights);
}
