/**
 * Unified priority scoring — single source of truth for the
 * cross-scanner ticket rank.
 *
 * Why this exists. Three scanners currently hand out `priority_rank` on
 * incompatible scales: audit uses 1-3 (factual / non-mention / generic),
 * legacy uses 1-N (traffic-ordinal per firm), sop step factories use
 * 1-N (per-scanner rubric ordinal). On APL today 21+ tickets all claim
 * "rank 1." The /tickets page can't sort meaningfully end-to-end and
 * per-phase pages only sort within one scanner's ordinal.
 *
 * `computePriority()` produces a globally-comparable
 * `priority_class` + `priority_score` from the raw signals each scanner
 * already has. Scanners call it after the `prescribeXTicket()` call and
 * before the `db.insert(remediationTickets)` call. The UI reads
 * `priority_score DESC` for default ordering.
 *
 * Spec: `tmp/priority-score-spec.md`. Migration: 0018.
 *
 * Class taxonomy (descending priority). Each class has a 100-point
 * window for the within-class offset:
 *
 *   factual_error      [700, 799]  LLMs demonstrably wrong about the firm
 *   non_mention        [600, 699]  Firm absent from category-relevant queries
 *   time_sensitive     [500, 599]  Drifted pages leaking to LLMs; dormant
 *                                  pages bleeding authority; open complaints
 *   content_drift      [400, 499]  Drifted pages where the action is rework,
 *                                  not removal
 *   per_page_quality   [300, 399]  LLM-Friendly / Semantic HTML / Schema gaps
 *   entity_gap         [200, 299]  Wikidata / KG / third-party platform
 *                                  misses
 *   unknown            [100, 199]  Scanner emitted a ticket whose shape
 *                                  isn't yet classified
 *   config_gate              [0]   Connect-X tickets — surfaced separately
 *                                  by the UI; score 0 keeps them out of the
 *                                  main sort path
 *
 * Within-class offset formulas (all clamp to [0, 99]):
 *
 *   factual_error      (provider_count − 1) × 10
 *   non_mention        (provider_count − 1) × 10
 *   time_sensitive
 *     suppression      (distance − 0.40) / 0.30 × 100
 *     freshness        months_dormant / 24 × 100      ← horizon cap 24, not 36
 *     reddit complaint fixed offset 50
 *   content_drift
 *     clicks present   clicks_per_month / 10
 *     no clicks        (distance − 0.40) / 0.15 × 100
 *   per_page_quality   100 − rubric_score_normalized_to_100
 *   entity_gap         PLATFORM_PRIORITY[divergence_kind]   ← see below
 *
 * PLATFORM_PRIORITY ordering (60 / 50 / 40 / 30 / 20):
 *   wikidata_create / wikidata_update         60
 *   google_kg_claim                           50
 *   schema_add                                40
 *   third_party_listing_diverges              30
 *   badge_unverified                          20
 *
 * NOTE on PLATFORM_PRIORITY ordering: this is the AEO-impact ordering,
 * not Toth STEP4's workflow ordering. Toth STEP4 (entity optimization
 * SOP, p. 8 of the Brand Optimization Playbook) lists the platforms
 * in their workflow order — Wikidata → schema → KG claim → third-party
 * → badges — which is the order an operator should execute them
 * because Wikidata edits propagate fastest into the Google Knowledge
 * Graph. Here we score by *impact on LLM signal quality* instead. KG
 * claim is rare and direct-to-Google but cheaper than Wikidata. Schema
 * is technical hygiene with broad coverage. Third-party listings are
 * platform-by-platform and have weaker LLM signal weight. Badges are
 * the weakest entity signal. The divergence is intentional — operator
 * workflow and AEO-impact ordering aren't the same thing.
 *
 * Approved adjustments from the priority-score-spec review:
 *   1. Freshness horizon cap 36 → 24 months (more aggressive — dormant
 *      pages past 2 years are already at max urgency).
 *   2. Entity priorities stand 60/50/40/30/20 (see Toth-divergence
 *      comment above).
 *   3. Reddit complaints classify as time_sensitive (not their own
 *      class) — open complaint mentions leak to LLMs the same way
 *      drifted noindex-candidate pages do.
 *   4. Class + score computation happens at the scanner level (caller
 *      passes raw signals here). Prescribers stay narrowly focused on
 *      title / description / remediation copy / validation steps.
 */

export type PriorityClass =
  | 'factual_error'
  | 'non_mention'
  | 'time_sensitive'
  | 'content_drift'
  | 'per_page_quality'
  | 'entity_gap'
  | 'config_gate'
  | 'unknown';

const CLASS_BASE: Record<PriorityClass, number> = {
  factual_error: 700,
  non_mention: 600,
  time_sensitive: 500,
  content_drift: 400,
  per_page_quality: 300,
  entity_gap: 200,
  unknown: 100,
  config_gate: 0,
};

/** Per-platform impact priorities — see PLATFORM_PRIORITY note above. */
const PLATFORM_PRIORITY: Record<string, number> = {
  wikidata_create: 60,
  wikidata_update: 60,
  google_kg_claim: 50,
  schema_add: 40,
  third_party_listing_diverges: 30,
  badge_unverified: 20,
};

/**
 * SopKeys that emit configure-this-prerequisite tickets — connect GSC,
 * configure GA4, set up bot log analysis. They're real tickets, but
 * they're prerequisites for other scanners to produce useful data, not
 * site-improvement tasks. score=0 + class=config_gate keeps them out of
 * the main score-sorted queue and lets the UI surface them in a
 * separate strip when it wants.
 *
 * `gsc_setup` is C1-only — included here for forward-compat so when C1
 * merges its ticket emit path picks up the right class automatically.
 */
const CONFIG_GATE_SOPS = new Set<string>([
  'gsc_setup',
  'ga4_llm_traffic_setup',
  'ai_bot_log_file_analysis',
]);

/**
 * SopKeys whose tickets are per-page rubric findings — LLM-Friendly
 * Content Checklist, Semantic HTML Optimization, Schema Markup
 * Deployment, AI Info Page Creation. They emit a rubric score per page;
 * the within-class offset inverts that score (low rubric = high
 * urgency).
 */
const PER_PAGE_QUALITY_SOPS = new Set<string>([
  'semantic_html_optimization',
  'llm_friendly_content_checklist',
  'schema_markup_deployment',
  'ai_info_page_creation',
  'trust_alignment_audit',
  'deep_research_content_audit',
]);

/**
 * SopKeys whose tickets are entity-gap findings — golden links
 * opportunity, entity optimization step-emitted tickets.
 */
const ENTITY_GAP_SOPS = new Set<string>([
  'entity_optimization',
  'golden_links_opportunity_analysis',
]);

export interface PriorityInput {
  /** source_type on remediation_ticket — 'audit' | 'legacy' | 'entity' | 'reddit' | 'sop'. */
  sourceType: string;
  /** sop_key of the sop_run the ticket attaches to. Required for sourceType='sop' routing; advisory otherwise. */
  sopKey?: string | null;

  // ── Audit (factual_error / non_mention / content_drift fallback) ──
  /** True when the audit ticket carries factual-error findings. */
  auditHasFactualErrors?: boolean;
  /** False when the firm wasn't mentioned in the LLM response at all. */
  auditMentioned?: boolean;
  /** How many providers (openai / claude / gemini / etc.) hit this issue. */
  providerCount?: number;

  // ── Legacy (time_sensitive / content_drift) ──
  /**
   * legacy_finding.action — 'noindex' | 'redirect' | 'delete' (wipe-from-
   * index = time_sensitive) | 'rewrite' | 'keep_update' (rework-in-place
   * = content_drift) | 'aligned' (defensive — shouldn't reach here).
   */
  legacyAction?: string | null;
  /** legacy_finding.semantic_distance (0..1, cosine). */
  semanticDistance?: number | null;
  /** Per-URL clicks/month from gsc_url_metric (C1). Null = no GSC. */
  clicksPerMonth?: number | null;

  // ── Content Freshness (time_sensitive) ──
  /** Months since the page was last meaningfully updated. */
  monthsDormant?: number | null;

  // ── Per-page rubric scanners (per_page_quality) ──
  /** Numeric score the rubric produced (e.g. 50 out of 100, 4 out of 7). */
  rubricScore?: number | null;
  /** Rubric ceiling (100 for semantic_html, 7 for llm_friendly, etc.). */
  rubricMax?: number | null;

  // ── Entity (entity_gap) ──
  /**
   * Maps to one of the keys in PLATFORM_PRIORITY:
   *   wikidata_create | wikidata_update | google_kg_claim | schema_add |
   *   third_party_listing_diverges | badge_unverified
   */
  entityDivergenceKind?: string | null;

  // ── Reddit (time_sensitive when complaint) ──
  /** True when the Reddit mention was classified as a complaint. */
  redditIsComplaint?: boolean;
}

export interface PriorityOutput {
  priorityClass: PriorityClass;
  priorityScore: number;
}

const clampOffset = (n: number): number => Math.max(0, Math.min(99, Math.round(n)));
// Audit classes (factual_error / non_mention) cap their offset at 90
// rather than 99. The spec calls this out explicitly — within-class
// differentiation matters less when the class itself is already top-of-
// queue; what makes the operator act is the class, not the offset.
const clampAuditOffset = (n: number): number => Math.max(0, Math.min(90, Math.round(n)));

export function computePriority(input: PriorityInput): PriorityOutput {
  const { priorityClass, withinOffset } = classify(input);
  const priorityScore = CLASS_BASE[priorityClass] + withinOffset;
  return { priorityClass, priorityScore };
}

function classify(input: PriorityInput): {
  priorityClass: PriorityClass;
  withinOffset: number;
} {
  // (0) Config-gate SOPs trump everything else — these are
  // prerequisites, not site-improvement work.
  if (input.sopKey && CONFIG_GATE_SOPS.has(input.sopKey)) {
    return { priorityClass: 'config_gate', withinOffset: 0 };
  }

  // (1) Audit tickets — factual_error / non_mention / generic positioning.
  if (input.sourceType === 'audit') {
    const providerCount = Math.max(1, input.providerCount ?? 1);
    const auditOffset = clampAuditOffset((providerCount - 1) * 10);
    if (input.auditHasFactualErrors) {
      return { priorityClass: 'factual_error', withinOffset: auditOffset };
    }
    if (input.auditMentioned === false) {
      return { priorityClass: 'non_mention', withinOffset: auditOffset };
    }
    // Mentioned + no factual errors = generic positioning drift. Closest
    // class is content_drift (the LLM described the firm off-brand —
    // analogous to a drifted on-site page).
    return { priorityClass: 'content_drift', withinOffset: auditOffset };
  }

  // (2) Legacy tickets — Suppression / Repositioning action buckets.
  if (input.sourceType === 'legacy') {
    const action = (input.legacyAction ?? '').toLowerCase();
    const distance = input.semanticDistance ?? 0;
    // Wipe-from-index actions → time_sensitive. Higher distance = more
    // urgent (page is more visibly drifted).
    if (action === 'noindex' || action === 'redirect' || action === 'delete') {
      const offset = clampOffset(((distance - 0.40) / 0.30) * 100);
      return { priorityClass: 'time_sensitive', withinOffset: offset };
    }
    // Rework-in-place actions → content_drift. Prefer click-based offset
    // when GSC connected (high-traffic pages outrank low-traffic ones);
    // fall back to distance when not.
    if (action === 'rewrite' || action === 'keep_update') {
      if (input.clicksPerMonth != null && input.clicksPerMonth > 0) {
        const offset = clampOffset(input.clicksPerMonth / 10);
        return { priorityClass: 'content_drift', withinOffset: offset };
      }
      const offset = clampOffset(((distance - 0.40) / 0.15) * 100);
      return { priorityClass: 'content_drift', withinOffset: offset };
    }
    // 'aligned' shouldn't produce a ticket; defensive fallback.
    return { priorityClass: 'unknown', withinOffset: 0 };
  }

  // (3) Entity tickets emitted directly (not via SOP step).
  if (input.sourceType === 'entity') {
    const k = input.entityDivergenceKind ?? '';
    return {
      priorityClass: 'entity_gap',
      withinOffset: PLATFORM_PRIORITY[k] ?? 0,
    };
  }

  // (4) Reddit tickets — complaint classification = time_sensitive.
  if (input.sourceType === 'reddit') {
    if (input.redditIsComplaint) {
      // Fixed mid-offset for v1. Open complaint mentions leak to LLMs;
      // urgency is uniform until we add karma/recency weighting.
      return { priorityClass: 'time_sensitive', withinOffset: 50 };
    }
    return { priorityClass: 'unknown', withinOffset: 0 };
  }

  // (5) SOP-emitted tickets — route by sop_key into the right class.
  if (input.sourceType === 'sop') {
    if (input.sopKey && PER_PAGE_QUALITY_SOPS.has(input.sopKey)) {
      const max = input.rubricMax ?? 100;
      const score = input.rubricScore ?? max; // null score = treat as perfect (no urgency)
      const normalized = max > 0 ? (score / max) * 100 : 0;
      return {
        priorityClass: 'per_page_quality',
        withinOffset: clampOffset(100 - normalized),
      };
    }
    if (input.sopKey === 'content_freshness_audit') {
      // Approved adjustment: cap at 24 months (not 36). Dormant pages
      // past 2 years are already at max urgency.
      const months = input.monthsDormant ?? 0;
      return {
        priorityClass: 'time_sensitive',
        withinOffset: clampOffset((months / 24) * 100),
      };
    }
    if (input.sopKey && ENTITY_GAP_SOPS.has(input.sopKey)) {
      const k = input.entityDivergenceKind ?? '';
      return {
        priorityClass: 'entity_gap',
        withinOffset: PLATFORM_PRIORITY[k] ?? 0,
      };
    }
    // Unknown SOP source — fall through to unknown class.
    return { priorityClass: 'unknown', withinOffset: 0 };
  }

  // Unknown source_type — defensive default.
  return { priorityClass: 'unknown', withinOffset: 0 };
}
