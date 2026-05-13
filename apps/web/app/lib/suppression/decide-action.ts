/**
 * Suppression decision framework — Toth STEP3 verbatim, with a no-GSC
 * fallback path that preserves the pre-C1 distance-only behaviour.
 *
 * Pure function. No DB access, no fetch. Single source of truth for the
 * scanner emit path AND the legacy buildSuppressionArtifacts deliverable.
 *
 * ── Toth's framework (Brand_Optimization_Playbook.pdf STEP3, p. 6) ──
 *
 *   Distance gate (semantic distance from Brand Truth centroid):
 *     d ≤ 0.40  → aligned (no ticket, page reads on-brand to LLMs)
 *     d >  0.40 → drifted, fire one of the 4 action buckets:
 *
 *   Click-based buckets:
 *     clicks ≥ 50            → keep_update   (high-traffic, refresh in place)
 *     10 ≤ clicks ≤ 49       → redirect      (medium-traffic, 301 to closest aligned)
 *     5  ≤ clicks ≤ 9        → noindex       (low-but-present-traffic, hide from search)
 *     clicks <  5 AND ≥5 ref-domains → redirect (preserve link equity)
 *     clicks <  5 AND <5 ref-domains → delete (low-everything, remove)
 *
 * ── No-GSC fallback (clicksPerMonth = null) ──
 *
 *   When the firm has no GSC connection, we can't apply Toth's click-
 *   based bucketing. Fall back to the pre-C1 distance + backlinks logic:
 *     d > 0.55 AND ≥5 ref-domains → redirect
 *     d > 0.55 AND <5 ref-domains → noindex
 *     0.40 < d ≤ 0.55            → rewrite (will rebucket to keep_update
 *                                          or noindex once GSC connects)
 *
 *   Tickets emitted in fallback mode are flagged decided_with_gsc=false
 *   so a re-bucketing query can find them when GSC eventually connects.
 *
 * ── Bucket meanings for downstream code ──
 *
 *   aligned     — informational; no ticket emitted, no legacy_finding row
 *   delete      — emits ticket attached to legacy_content_suppression sop_run
 *   redirect    — emits ticket attached to legacy_content_suppression sop_run
 *   noindex     — emits ticket attached to legacy_content_suppression sop_run
 *   keep_update — emits ticket attached to CONTENT_REPOSITIONING sop_run
 *                (Phase 3 work, not Phase 1 — high-traffic page refresh
 *                is the Content Repositioning SOP's job)
 *   rewrite     — LEGACY transitional bucket emitted only in no-GSC mode
 *                when distance is in the 0.40-0.55 band. Same target
 *                sop_run as keep_update (Repositioning) but the
 *                description carries the GSC-not-connected provenance
 *                note. Disappears once GSC ingestion is live for the firm.
 */

export type SuppressionAction =
  | 'aligned'
  | 'delete'
  | 'redirect'
  | 'noindex'
  | 'keep_update'
  | 'rewrite';

export interface DecideActionInput {
  /** Semantic distance from Brand Truth centroid (0..1 typical, cosine). */
  distance: number;
  /** Per-URL clicks/month over the last 30 days. Null means no GSC data. */
  clicksPerMonth: number | null;
  /**
   * Backlinks count (referring domains). Null when the backlinks
   * provider isn't configured — same semantics as today's
   * `lib/suppression/backlinks.ts` NullProvider.
   */
  backlinks: { refDomains: number } | null;
}

export interface DecideActionOutput {
  action: SuppressionAction;
  rationale: string;
  /** True if Toth's click-aware framework decided this bucket. False = no-GSC fallback. */
  decidedWithGsc: boolean;
}

export const DISTANCE_THRESHOLD_DRIFT = 0.40;
export const DISTANCE_THRESHOLD_DIVERGENT = 0.55;

// Toth Step 3 click thresholds (Brand_Optimization_Playbook.pdf, p. 6).
export const CLICKS_KEEP_UPDATE = 50;
export const CLICKS_REDIRECT = 10;
export const CLICKS_NOINDEX = 5;
export const BACKLINKS_PRESERVE = 5;

export function decideAction(input: DecideActionInput): DecideActionOutput {
  const { distance, clicksPerMonth, backlinks } = input;
  const refDomains = backlinks?.refDomains ?? 0;

  // Distance gate — below 0.40 means aligned, no action.
  if (distance <= DISTANCE_THRESHOLD_DRIFT) {
    return {
      action: 'aligned',
      rationale: `Semantic distance ${distance.toFixed(3)} ≤ ${DISTANCE_THRESHOLD_DRIFT} — on-brand, no action needed.`,
      // Decision didn't need clicks data — counts as a clean decision
      // regardless of GSC state. The "aligned" path is degenerate.
      decidedWithGsc: clicksPerMonth != null,
    };
  }

  // ── GSC-connected mode: full Toth framework ──
  if (clicksPerMonth != null) {
    if (clicksPerMonth >= CLICKS_KEEP_UPDATE) {
      return {
        action: 'keep_update',
        rationale: `${clicksPerMonth} clicks/mo ≥ ${CLICKS_KEEP_UPDATE} — high-traffic page worth refreshing rather than suppressing (semantic distance ${distance.toFixed(2)}).`,
        decidedWithGsc: true,
      };
    }
    if (clicksPerMonth >= CLICKS_REDIRECT) {
      return {
        action: 'redirect',
        rationale: `${clicksPerMonth} clicks/mo (10-49 range) + drift (d=${distance.toFixed(2)}) — 301 to closest aligned page to preserve search authority.`,
        decidedWithGsc: true,
      };
    }
    if (clicksPerMonth >= CLICKS_NOINDEX) {
      return {
        action: 'noindex',
        rationale: `${clicksPerMonth} clicks/mo (5-9 range) + drift (d=${distance.toFixed(2)}) — page should exist but be hidden from search.`,
        decidedWithGsc: true,
      };
    }
    // Low-everything bucket — backlinks decide between redirect (preserve)
    // and delete (remove).
    if (refDomains >= BACKLINKS_PRESERVE) {
      return {
        action: 'redirect',
        rationale: `${clicksPerMonth} clicks/mo (<${CLICKS_NOINDEX}) but ${refDomains} ref-domains ≥ ${BACKLINKS_PRESERVE} — preserve link equity via 301.`,
        decidedWithGsc: true,
      };
    }
    return {
      action: 'delete',
      rationale: `${clicksPerMonth} clicks/mo (<${CLICKS_NOINDEX}) + ${refDomains} ref-domains (<${BACKLINKS_PRESERVE}) + drift (d=${distance.toFixed(2)}) — safe to remove.`,
      decidedWithGsc: true,
    };
  }

  // ── No-GSC fallback: pre-C1 distance + backlinks logic ──
  // Cannot apply Toth's full framework without per-URL click data. Stay
  // close to the pre-C1 behaviour so existing operators don't see a
  // regression — but flag every finding so a future rebucketing pass
  // (when GSC connects) picks them up.
  if (distance > DISTANCE_THRESHOLD_DIVERGENT) {
    if (refDomains >= BACKLINKS_PRESERVE) {
      return {
        action: 'redirect',
        rationale: `Drifted (d=${distance.toFixed(2)}) and ${refDomains} ref-domains — 301 to preserve. (No GSC data; bucket may shift to keep_update / delete once click data lands.)`,
        decidedWithGsc: false,
      };
    }
    return {
      action: 'noindex',
      rationale: `Drifted (d=${distance.toFixed(2)}) with <${BACKLINKS_PRESERVE} ref-domains — hide from search. (No GSC data; bucket may shift to delete if clicks <5 confirms low-value.)`,
      decidedWithGsc: false,
    };
  }
  // Drift band (0.40 < d ≤ 0.55) — pre-C1 bucket was 'rewrite'.
  return {
    action: 'rewrite',
    rationale: `Semantic distance ${distance.toFixed(2)} in (${DISTANCE_THRESHOLD_DRIFT}, ${DISTANCE_THRESHOLD_DIVERGENT}] — rewrite to align with Brand Truth positioning. (No GSC data; bucket may shift to keep_update once clicks land if traffic ≥ ${CLICKS_KEEP_UPDATE}.)`,
    decidedWithGsc: false,
  };
}

/**
 * Which sop_run does a given action attach to?
 *   keep_update / rewrite → content_repositioning (Phase 3 owns refresh work)
 *   delete / redirect / noindex → legacy_content_suppression (Phase 1 owns suppression work)
 *   aligned → no ticket emitted
 */
export function targetSopKeyForAction(
  action: SuppressionAction,
): 'legacy_content_suppression' | 'content_repositioning' | null {
  switch (action) {
    case 'aligned':
      return null;
    case 'keep_update':
    case 'rewrite':
      return 'content_repositioning';
    case 'delete':
    case 'redirect':
    case 'noindex':
      return 'legacy_content_suppression';
  }
}
