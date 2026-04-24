/**
 * Per-jurisdiction banned-claim rulebook. Validates that generated
 * remediation copy does not violate state bar / dental-board / GDC /
 * FTC advertising rules before it ships to any client-facing channel.
 *
 * Seed set only. Ethics counsel review is a Phase 3 gate before any
 * copy reaches production on behalf of a client.
 */

import type { BrandTruth } from './brand-truth';

export type Jurisdiction = string;

export interface BannedPattern {
  pattern: RegExp;
  reason: string;
  source_url?: string;
}

export const SEED_BANNED_PATTERNS: Record<Jurisdiction, BannedPattern[]> = {
  // ── US state bar (legal) ─────────────────────────────────
  'US-TX-BAR': [
    { pattern: /\bbest\s+(lawyer|attorney|law\s+firm)\b/i,
      reason: 'TX Bar Rule 7.02: comparative claim without objective basis' },
    { pattern: /\b#?\s*1\s+(rated|ranked|lawyer|attorney)\b/i,
      reason: 'TX Bar Rule 7.02: superiority without substantiation' },
  ],
  'US-CA-BAR': [
    { pattern: /\bexpert\s+(lawyer|attorney)\b/i,
      reason: 'CA RPC 7.4: "expert" implies specialization certification' },
  ],

  // ── US dental boards ─────────────────────────────────────
  'US-TX-DENTAL': [
    { pattern: /\bpainless\b/i,
      reason: 'TSBDE Rule 108.54: misleading absolute claim' },
    { pattern: /\bbest\s+dentist\b/i,
      reason: 'TSBDE Rule 108.54: unverifiable superiority' },
  ],

  // ── UK General Dental Council ────────────────────────────
  'UK-GDC': [
    { pattern: /\bbest\s+dentist\b/i,
      reason: 'GDC Standards 1.3.1: misleading claim' },
    { pattern: /\bguaranteed\s+(result|outcome)\b/i,
      reason: 'GDC Standards 1.3.1: outcome guarantee prohibited' },
  ],

  // ── US FTC (marketing agencies + any US ad copy) ─────────
  'US-FTC-AGENCY': [
    { pattern: /\bguaranteed\s+(rankings?|results?|positions?|leads?)\b/i,
      reason: 'FTC Section 5 / 16 CFR 255: organic outcome guarantees not substantiatable' },
    { pattern: /\b(#?\s*1|number\s*one|best|top)\s+(seo|marketing|digital)\s+(agency|firm|company)\b/i,
      reason: 'FTC Section 5: unsubstantiated superlative — needs published methodology' },
    { pattern: /\btypical\s+(client|customer|business)\s+(sees?|gets?|earns?|grows?)/i,
      reason: 'FTC 16 CFR 255: typical-results claim requires aggregated substantiation' },
    { pattern: /\bAI[\s-]?(powered|driven|enabled)\b/i,
      reason: 'FTC AI-claim guidance (2023): "AI-powered" requires disclosed methodology' },
    { pattern: /\bproprietary\s+algorithm\b/i,
      reason: 'FTC Section 5: "proprietary algorithm" with no disclosed basis invites deceptive-acts scrutiny' },
  ],
};

export interface BannedClaimHit {
  jurisdiction: Jurisdiction;
  pattern: BannedPattern;
  match: string;
  index: number;
}

/**
 * Scan text against every rule for the supplied jurisdictions.
 * Returns every hit (not first-only) so UI can show all violations at once.
 */
export function validateClaims(
  text: string,
  jurisdictions: Jurisdiction[],
): BannedClaimHit[] {
  const hits: BannedClaimHit[] = [];
  for (const j of jurisdictions) {
    const rules = SEED_BANNED_PATTERNS[j] ?? [];
    for (const rule of rules) {
      const m = text.match(rule.pattern);
      if (m && typeof m.index === 'number') {
        hits.push({ jurisdiction: j, pattern: rule, match: m[0], index: m.index });
      }
    }
  }
  return hits;
}

/**
 * Escape a user-supplied phrase for safe use inside a `RegExp`.
 * The firm-level banned_claims list is free-text, so we never trust it
 * as a regex literal — treat every character literally.
 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Full compliance validator used across every surface that emits copy
 * on behalf of a firm (remediation drafts, metadata suggestions, paste-
 * and-check UI, monthly report commentary).
 *
 * Combines two sources:
 *  1. Firm-specific `banned_claims` from Brand Truth — case-insensitive
 *     substring match on the `claim` field. Each firm gets to blacklist
 *     its own phrasing (e.g. a prior cease-and-desist, an outdated
 *     partnership, a compliance carve-out) without touching the global
 *     rulebook.
 *  2. Jurisdiction regex patterns from `SEED_BANNED_PATTERNS`, keyed by
 *     `compliance_jurisdictions` on the Brand Truth.
 *
 * Hits from the firm list are tagged `firm:<source_rule>` (falling back
 * to `firm:custom`) so the UI can distinguish firm-authored rules from
 * jurisdictional ones. A single phrase that appears in both lists will
 * produce two hits — that's intentional, we want the reviewer to see
 * *why* it's flagged from each angle.
 */
export function validateCopyAgainstBrandTruth(
  text: string,
  brandTruth: BrandTruth,
): BannedClaimHit[] {
  const hits: BannedClaimHit[] = [];

  // Firm-specific banned_claims → treat `claim` as a literal substring.
  for (const bc of brandTruth.banned_claims ?? []) {
    if (!bc.claim) continue;
    const idx = text.toLowerCase().indexOf(bc.claim.toLowerCase());
    if (idx >= 0) {
      hits.push({
        jurisdiction: `firm:${bc.source_rule ?? 'custom'}`,
        pattern: {
          pattern: new RegExp(escapeRegExp(bc.claim), 'i'),
          reason: bc.reason,
          source_url: undefined,
        },
        match: text.slice(idx, idx + bc.claim.length),
        index: idx,
      });
    }
  }

  // Jurisdiction rulebook.
  hits.push(
    ...validateClaims(text, brandTruth.compliance_jurisdictions ?? []),
  );

  // Stable sort: earliest violation first so UI can highlight the
  // offending span inline.
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

/**
 * Convenience: does the text contain *any* violations for the given
 * Brand Truth? Used as a gate before persisting AI-generated copy.
 */
export function isCopyCompliant(
  text: string,
  brandTruth: BrandTruth,
): boolean {
  return validateCopyAgainstBrandTruth(text, brandTruth).length === 0;
}
