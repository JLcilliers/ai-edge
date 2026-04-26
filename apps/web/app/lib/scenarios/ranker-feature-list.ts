/**
 * Canonical feature list for the Scenario Lab linear ranker.
 *
 * Adding a new feature: append it here, extend `extractFeatures`, and the
 * scorer + PSO calibrator pick it up automatically. Removing a feature is
 * non-breaking — old `ranker_weights` rows still carry the deprecated key
 * but the scorer ignores any feature not in this list.
 *
 * Each feature is **always normalized to roughly [0, 1] or {0, 1}** before
 * scoring. Raw integers (e.g. word_count = 1500) would dominate the score
 * vector and force PSO into very small weights for everything else. We
 * pre-normalize at extraction time so weights stay interpretable.
 *
 * Booleans are encoded as 0/1; numerics use the per-feature `normalize()`
 * documented next to each entry. Anything missing from a vector is treated
 * as 0 by the scorer (open-world default).
 */

export type FeatureName =
  // Content depth
  | 'word_count_log'
  // Topical relevance
  | 'centroid_similarity'
  | 'query_term_density'
  // Schema presence
  | 'has_jsonld_organization'
  | 'has_jsonld_legalservice'
  | 'has_jsonld_dentist'
  | 'has_jsonld_person'
  | 'has_jsonld_faqpage'
  | 'has_jsonld_localbusiness'
  | 'jsonld_type_count_norm'
  // Headings
  | 'has_h1'
  | 'h2_count_norm'
  | 'heading_depth_norm'
  // Links
  | 'internal_link_density'
  | 'external_link_density'
  | 'authoritative_external_links_norm'
  // Q&A structure
  | 'faq_count_norm'
  // Freshness
  | 'freshness_score'
  // URL signals
  | 'url_depth_inv'
  | 'has_keyword_in_url'
  | 'has_keyword_in_title'
  | 'has_keyword_in_h1';

export const FEATURE_NAMES: readonly FeatureName[] = [
  'word_count_log',
  'centroid_similarity',
  'query_term_density',
  'has_jsonld_organization',
  'has_jsonld_legalservice',
  'has_jsonld_dentist',
  'has_jsonld_person',
  'has_jsonld_faqpage',
  'has_jsonld_localbusiness',
  'jsonld_type_count_norm',
  'has_h1',
  'h2_count_norm',
  'heading_depth_norm',
  'internal_link_density',
  'external_link_density',
  'authoritative_external_links_norm',
  'faq_count_norm',
  'freshness_score',
  'url_depth_inv',
  'has_keyword_in_url',
  'has_keyword_in_title',
  'has_keyword_in_h1',
] as const;

export type FeatureVec = Record<FeatureName, number>;
export type Weights = Partial<Record<FeatureName, number>>;

/**
 * Returns a zero-filled feature vector. Useful as a baseline before the
 * extractor populates known fields and as the "unknown competitor" stand-in
 * during simulation when we have a SERP URL but haven't crawled it.
 */
export function emptyFeatureVec(): FeatureVec {
  const v = {} as FeatureVec;
  for (const f of FEATURE_NAMES) v[f] = 0;
  return v;
}

/**
 * Per-feature normalizers. Applied at extraction time, NOT in the scorer —
 * keeps the score function a pure dot product.
 *
 * `clamp01` / `log1pNorm` produce values in roughly [0, 1]; this matters
 * because PSO bounds weights to [-2, 2] and we want each feature to
 * contribute on a comparable scale.
 */
export const NORMALIZERS = {
  /** log10(x + 1) / 4  → roughly [0, 1] for word counts up to ~10k. */
  log1pNorm(x: number): number {
    return Math.min(1, Math.log10(Math.max(0, x) + 1) / 4);
  },
  /** Clamp to [0, 1]. */
  clamp01(x: number): number {
    return Math.max(0, Math.min(1, x));
  },
  /** count / cap  with hard cap at 1 — for "more is better but saturating" features. */
  saturate(x: number, cap: number): number {
    if (cap <= 0) return 0;
    return Math.max(0, Math.min(1, x / cap));
  },
  /** 1 / (depth + 1)  — shorter URLs score higher; depth=0 → 1; depth=5 → ~0.17. */
  inverseDepth(depth: number): number {
    return 1 / (Math.max(0, depth) + 1);
  },
  /** Freshness decay over 365d. Today=1, a year ago≈0.37. */
  freshness(daysOld: number): number {
    return Math.exp(-Math.max(0, daysOld) / 365);
  },
} as const;

/** Default soft caps used by the extractor when calling `saturate()`. */
export const SATURATION_CAPS = {
  jsonld_types: 6,        // 6 distinct schema.org types ≈ "fully marked up"
  h2_count: 12,           // 12 H2s ≈ very thorough article
  heading_depth: 4,       // h1..h4 ≈ deep structural hierarchy
  internal_link_density_per_word: 0.04,
  external_link_density_per_word: 0.02,
  authoritative_links: 5,
  faq_count: 10,
} as const;
