import {
  FEATURE_NAMES,
  type FeatureName,
  type FeatureVec,
  type Weights,
} from './ranker-feature-list';

/**
 * Linear ranker score = Σ wᵢ · xᵢ.
 *
 * We chose a linear function (not GBM, not a neural net) for three reasons:
 *   1. **Interpretability.** When a scenario raises Δrank by 3, an operator
 *      can see exactly which feature changed and what its weight was. A
 *      tree ensemble would be a black box at that point.
 *   2. **PSO calibration cost.** The weight space is `|FEATURE_NAMES|`-D
 *      (currently 22). PSO converges in ~200 iterations on swarms of 30
 *      particles — milliseconds, not minutes.
 *   3. **Honest ceiling.** A linear ranker won't capture every Google
 *      interaction effect — and that's fine. The product claim is
 *      "directional, not absolute."
 *
 * Missing features default to 0 (open-world). The scorer never throws on a
 * partial vector — calibrate.ts may call it on a freshly-pasted SERP URL
 * before extraction has caught up, and the right behaviour is "score what
 * you have, contribute the rest as zeros."
 */
export function score(features: Partial<FeatureVec>, weights: Weights): number {
  let s = 0;
  for (const f of FEATURE_NAMES) {
    const x = features[f] ?? 0;
    const w = weights[f] ?? 0;
    s += w * x;
  }
  return s;
}

/**
 * Score a list of (url, features) pairs and return them sorted by score
 * descending — i.e. predicted ranking. Used during PSO fitness eval and
 * during scenario simulation to compute Δrank.
 *
 * Stable sort: equal-score entries keep input order. Matters when the
 * proposed scenario produces an identical score to a competitor — we
 * place the proposal at the *worse* (higher index) position to be
 * conservative on the "your change helped" claim.
 */
export interface ScoredItem<T = unknown> {
  url: string;
  score: number;
  features: Partial<FeatureVec>;
  payload?: T;
}

export function rankByScore<T>(
  items: Array<{ url: string; features: Partial<FeatureVec>; payload?: T }>,
  weights: Weights,
): ScoredItem<T>[] {
  const scored = items.map((it) => ({
    url: it.url,
    score: score(it.features, weights),
    features: it.features,
    payload: it.payload,
  }));
  // Stable sort by descending score.
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Spearman rank correlation between predicted and observed ranks.
 * Returns ρ ∈ [-1, 1]. Used as the PSO fitness function (we maximize it).
 *
 * `predicted[i]` and `observed[i]` are 1-indexed positions for the same
 * URL across the two orderings. Length must match; the caller is
 * responsible for aligning by URL before calling.
 *
 * For ties we use mid-rank — the standard choice. Pure ranks guard against
 * a degenerate "all 0" prediction (which would otherwise produce ρ=NaN
 * via division by zero); we return 0 for that case.
 */
export function spearmanCorrelation(
  predicted: number[],
  observed: number[],
): number {
  if (predicted.length !== observed.length) {
    throw new Error(
      `spearman: length mismatch (${predicted.length} vs ${observed.length})`,
    );
  }
  const n = predicted.length;
  if (n < 2) return 0;

  const meanP = predicted.reduce((a, b) => a + b, 0) / n;
  const meanO = observed.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denomP = 0;
  let denomO = 0;
  for (let i = 0; i < n; i++) {
    const dp = predicted[i]! - meanP;
    const doi = observed[i]! - meanO;
    num += dp * doi;
    denomP += dp * dp;
    denomO += doi * doi;
  }
  const denom = Math.sqrt(denomP * denomO);
  if (denom === 0) return 0;
  return num / denom;
}

/**
 * Convert a list of items sorted by score (rank 1 = best) into a rank
 * lookup keyed by URL. Helper for fitness eval.
 */
export function buildRankMap<T>(scored: ScoredItem<T>[]): Map<string, number> {
  const m = new Map<string, number>();
  // 1-indexed ranks per convention.
  scored.forEach((s, i) => m.set(s.url, i + 1));
  return m;
}
