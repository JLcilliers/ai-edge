import {
  type FeatureName,
  type FeatureVec,
  type Weights,
} from './ranker-feature-list';
import { score, rankByScore } from './scoring';
import { applyProposedChange } from './features';

/**
 * Apply a scenario's proposed change to a baseline page and report
 * predicted Δscore + Δrank vs. the current SERP competitor set.
 *
 * The Δrank semantics:
 *   - We score the baseline + every competitor using the calibrated
 *     weights. The baseline gets ranked among competitors → `baselineRank`.
 *   - We re-score the *proposed* version and re-insert it (replacing the
 *     baseline's slot) → `proposedRank`.
 *   - `deltaRank = baselineRank - proposedRank`. POSITIVE means improvement
 *     (e.g. moving from rank 7 to rank 4 → Δ=+3).
 *
 * If competitor set is empty (no calibration SERP for that query yet) we
 * report Δscore only and `deltaRank=null` — caller renders this as a
 * "score-only" result with a low_confidence label.
 */

export interface CompetitorEntry {
  url: string;
  features: Partial<FeatureVec>;
  /** Optional observed position from the most recent SERP — preserved as
   *  metadata so the UI can show "this rank-3 competitor would now be
   *  rank-4 if our scenario shipped." */
  observedPosition?: number;
}

export interface SimulationInput {
  baselineUrl: string;
  baselineFeatures: FeatureVec;
  proposedChange: Record<string, string | number | boolean>;
  weights: Weights;
  weightsGeneration?: number;
  competitors: CompetitorEntry[];
}

export type ConfidenceLabel = 'directional' | 'low_confidence' | 'no_calibration';

export interface SimulationResult {
  baselineUrl: string;
  baselineScore: number;
  proposedScore: number;
  deltaScore: number;
  baselineRank: number | null;
  proposedRank: number | null;
  deltaRank: number | null;
  competitorCount: number;
  weightsGeneration: number | null;
  confidenceLabel: ConfidenceLabel;
  /** Pre/post feature snapshots — let the UI show "what changed and how
   *  much" without recomputing on the client. */
  proposedFeatures: FeatureVec;
  /** Per-feature score delta (w_i × (x_i_proposed - x_i_baseline)). Sorted
   *  by absolute magnitude desc — the UI takes the top 3 to explain "why
   *  did this scenario move the needle?" */
  topContributingFeatures: Array<{
    feature: FeatureName;
    delta: number;
    contribution: number;
  }>;
}

function rankAmong(
  url: string,
  url_to_features: Array<{ url: string; features: Partial<FeatureVec> }>,
  weights: Weights,
): number | null {
  if (url_to_features.length === 0) return null;
  const ranked = rankByScore(url_to_features, weights);
  const idx = ranked.findIndex((r) => r.url === url);
  return idx < 0 ? null : idx + 1;
}

/**
 * Pure simulator. No DB calls. The server action orchestrates the read
 * (baseline features + competitor features + weights) and persists the
 * result; this module just does the math.
 */
export function simulate(input: SimulationInput): SimulationResult {
  const proposedFeatures = applyProposedChange(
    input.baselineFeatures,
    input.proposedChange,
  );

  const baselineScore = score(input.baselineFeatures, input.weights);
  const proposedScore = score(proposedFeatures, input.weights);
  const deltaScore = proposedScore - baselineScore;

  // Rank vs. competitor set (only when we have one).
  let baselineRank: number | null = null;
  let proposedRank: number | null = null;
  let deltaRank: number | null = null;
  if (input.competitors.length > 0) {
    const baselineSet = [
      { url: input.baselineUrl, features: input.baselineFeatures },
      ...input.competitors.map((c) => ({ url: c.url, features: c.features })),
    ];
    const proposedSet = [
      { url: input.baselineUrl, features: proposedFeatures },
      ...input.competitors.map((c) => ({ url: c.url, features: c.features })),
    ];
    baselineRank = rankAmong(input.baselineUrl, baselineSet, input.weights);
    proposedRank = rankAmong(input.baselineUrl, proposedSet, input.weights);
    if (baselineRank != null && proposedRank != null) {
      deltaRank = baselineRank - proposedRank;
    }
  }

  // Per-feature contribution: w_i × Δx_i. Sort by |contribution| desc to
  // tell the operator which knob actually moved the needle.
  const contribs: Array<{
    feature: FeatureName;
    delta: number;
    contribution: number;
  }> = [];
  for (const f of Object.keys(proposedFeatures) as FeatureName[]) {
    const dx = (proposedFeatures[f] ?? 0) - (input.baselineFeatures[f] ?? 0);
    if (dx === 0) continue;
    const w = input.weights[f] ?? 0;
    contribs.push({ feature: f, delta: dx, contribution: w * dx });
  }
  contribs.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  // Confidence label rules:
  //   no_calibration: weights are missing or generation 0 (untrained)
  //   low_confidence: <10 SERP observations or fitness < 0.1, OR no
  //                   competitor set exists
  //   directional:    everything else
  // The actual fitness/observation_count come from the ranker_weights row;
  // the action layer passes the label in. Here we just downgrade if the
  // competitor set is empty — the most common silent failure mode.
  let confidenceLabel: ConfidenceLabel =
    input.weightsGeneration && input.weightsGeneration > 0
      ? 'directional'
      : 'no_calibration';
  if (input.competitors.length === 0 && confidenceLabel === 'directional') {
    confidenceLabel = 'low_confidence';
  }

  return {
    baselineUrl: input.baselineUrl,
    baselineScore,
    proposedScore,
    deltaScore,
    baselineRank,
    proposedRank,
    deltaRank,
    competitorCount: input.competitors.length,
    weightsGeneration: input.weightsGeneration ?? null,
    confidenceLabel,
    proposedFeatures,
    topContributingFeatures: contribs.slice(0, 5),
  };
}
