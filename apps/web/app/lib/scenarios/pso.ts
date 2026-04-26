import {
  FEATURE_NAMES,
  type FeatureName,
  type FeatureVec,
  type Weights,
} from './ranker-feature-list';
import {
  buildRankMap,
  rankByScore,
  spearmanCorrelation,
} from './scoring';

/**
 * Particle Swarm Optimization for the linear ranker's weight vector.
 *
 * The fitness function: for each observed SERP, predict ranks using the
 * candidate weight vector, then compute Spearman ρ between predicted and
 * observed. PSO maximizes the *mean ρ across all SERPs*.
 *
 * Why PSO and not gradient descent?
 *   - Spearman ρ is non-differentiable (it depends on a sort). Gradient
 *     descent doesn't directly apply.
 *   - PSO is robust to non-convex landscapes — and the rank-correlation
 *     surface here is decidedly bumpy.
 *   - 30 × 200 = 6000 fitness evaluations over a 22-D space converges in
 *     ~100ms even on a cold Fluid Compute container. Adequate for a
 *     calibration cron that runs nightly per firm.
 *
 * Determinism: caller passes a `seed`. Internally we use a 32-bit Mulberry
 * RNG so callers can re-run a calibration and get identical weights, which
 * matters for "did this scenario change because of new data, or because
 * PSO landed in a different local maximum?"
 */

export interface SerpObservation {
  query: string;
  /** Each result is a (url, observed_position, features) triple.
   *  observed_position is 1-indexed (1 = top of SERP). */
  results: Array<{
    url: string;
    position: number;
    features: Partial<FeatureVec>;
  }>;
}

export interface PSOOptions {
  /** Particle count. Default 30. */
  particles?: number;
  /** Iteration count. Default 200. */
  iterations?: number;
  /** Inertia weight (ω). Default 0.7. */
  inertia?: number;
  /** Cognitive coefficient (φ_p) — pull to personal best. Default 1.4. */
  cognitive?: number;
  /** Social coefficient (φ_g) — pull to global best. Default 1.4. */
  social?: number;
  /** Per-dimension weight bounds. Default [-2, 2]. */
  bounds?: [number, number];
  /** Per-dimension velocity clamp (|v_max|). Default = (max - min) / 4. */
  velocityClamp?: number;
  /** RNG seed for deterministic runs. Default: random. */
  seed?: number;
  /** Optional progress callback for logging / cancellation. */
  onIteration?: (iter: number, fitness: number, gBest: Weights) => void;
}

export interface PSOResult {
  weights: Weights;
  fitness: number;
  /** Per-iteration global-best fitness — useful for plotting convergence. */
  iterationFitnesses: number[];
  iterationsRun: number;
  particles: number;
  seed: number;
}

/** 32-bit Mulberry — deterministic, fast, ~no state. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function vecToWeights(vec: number[]): Weights {
  const w: Weights = {};
  FEATURE_NAMES.forEach((f, i) => {
    w[f] = vec[i] ?? 0;
  });
  return w;
}

/**
 * Compute mean Spearman ρ across all observations under the given weights.
 * Skips observations with <2 results (correlation undefined).
 */
export function evaluateFitness(
  observations: SerpObservation[],
  weights: Weights,
): number {
  if (observations.length === 0) return 0;
  const rhos: number[] = [];
  for (const obs of observations) {
    if (obs.results.length < 2) continue;
    const ranked = rankByScore(
      obs.results.map((r) => ({
        url: r.url,
        features: r.features,
        payload: r.position,
      })),
      weights,
    );
    const predRankByUrl = buildRankMap(ranked);
    const predicted: number[] = [];
    const observed: number[] = [];
    for (const r of obs.results) {
      const p = predRankByUrl.get(r.url);
      if (p == null) continue;
      predicted.push(p);
      observed.push(r.position);
    }
    rhos.push(spearmanCorrelation(predicted, observed));
  }
  if (rhos.length === 0) return 0;
  return rhos.reduce((a, b) => a + b, 0) / rhos.length;
}

/**
 * Run PSO. Returns the global-best weights + final fitness + iteration trace.
 */
export function calibrateWeightsPSO(
  observations: SerpObservation[],
  options: PSOOptions = {},
): PSOResult {
  const particles = options.particles ?? 30;
  const iterations = options.iterations ?? 200;
  const w = options.inertia ?? 0.7;
  const phiP = options.cognitive ?? 1.4;
  const phiG = options.social ?? 1.4;
  const [lo, hi] = options.bounds ?? [-2, 2];
  const vMax = options.velocityClamp ?? (hi - lo) / 4;
  const seed = options.seed ?? Math.floor(Math.random() * 0xffffffff);
  const rng = makeRng(seed);

  // Sanity invariants — failures here mean we wasted a PSO run.
  if (particles < 2) throw new Error('PSO requires ≥2 particles');
  if (iterations < 1) throw new Error('PSO requires ≥1 iteration');
  if (lo >= hi) throw new Error('PSO bounds must be lo < hi');

  const D = FEATURE_NAMES.length;

  // Init particles. Small initial weights (~zero) keep the swarm near "no
  // signal" and let PSO build up evidence; cold-starting at the bounds
  // tends to bias the global best toward extremes.
  const positions: number[][] = [];
  const velocities: number[][] = [];
  const personalBest: number[][] = [];
  const personalBestFitness: number[] = [];
  for (let p = 0; p < particles; p++) {
    const pos = Array.from({ length: D }, () => (rng() * 0.4 - 0.2));
    const vel = Array.from({ length: D }, () => (rng() * 0.2 - 0.1));
    positions.push(pos);
    velocities.push(vel);
    personalBest.push([...pos]);
    personalBestFitness.push(evaluateFitness(observations, vecToWeights(pos)));
  }

  // Global best.
  let gBestIdx = 0;
  for (let p = 1; p < particles; p++) {
    if (personalBestFitness[p]! > personalBestFitness[gBestIdx]!) gBestIdx = p;
  }
  let gBest = [...personalBest[gBestIdx]!];
  let gBestFitness = personalBestFitness[gBestIdx]!;

  const iterFitnesses: number[] = [];

  for (let iter = 0; iter < iterations; iter++) {
    for (let p = 0; p < particles; p++) {
      const pos = positions[p]!;
      const vel = velocities[p]!;
      const pBest = personalBest[p]!;
      for (let d = 0; d < D; d++) {
        const rp = rng();
        const rg = rng();
        let v =
          w * vel[d]! +
          phiP * rp * (pBest[d]! - pos[d]!) +
          phiG * rg * (gBest[d]! - pos[d]!);
        v = clamp(v, -vMax, vMax);
        vel[d] = v;
        pos[d] = clamp(pos[d]! + v, lo, hi);
      }
      const fit = evaluateFitness(observations, vecToWeights(pos));
      if (fit > personalBestFitness[p]!) {
        personalBestFitness[p] = fit;
        personalBest[p] = [...pos];
        if (fit > gBestFitness) {
          gBestFitness = fit;
          gBest = [...pos];
        }
      }
    }
    iterFitnesses.push(gBestFitness);

    if (options.onIteration) {
      options.onIteration(iter, gBestFitness, vecToWeights(gBest));
    }
  }

  // Invariant: returned fitness should equal the recomputed fitness on the
  // returned weights. Catches a class of bugs where pBest shadow-copies
  // mutate after assignment.
  const finalCheck = evaluateFitness(observations, vecToWeights(gBest));
  if (Math.abs(finalCheck - gBestFitness) > 1e-9) {
    throw new Error(
      `PSO invariant violation: stored gBest fitness ${gBestFitness} ≠ recomputed ${finalCheck}`,
    );
  }

  return {
    weights: vecToWeights(gBest),
    fitness: gBestFitness,
    iterationFitnesses: iterFitnesses,
    iterationsRun: iterations,
    particles,
    seed,
  };
}
