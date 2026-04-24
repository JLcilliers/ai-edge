'use server';

import {
  validateCopyAgainstBrandTruth,
  SEED_BANNED_PATTERNS,
  type BrandTruth,
} from '@ai-edge/shared';
import { getLatestBrandTruth } from './brand-truth-actions';

export type ComplianceHitDto = {
  jurisdiction: string;
  match: string;
  index: number;
  reason: string;
  sourceUrl?: string;
};

export type ComplianceCheckResult = {
  ok: boolean;
  hits: ComplianceHitDto[];
  usedJurisdictions: string[];
  usedFirmClaims: number;
  /** True if we found a Brand Truth; false means there's nothing to validate against yet. */
  brandTruthFound: boolean;
};

/**
 * Paste-and-check endpoint: validate arbitrary copy against the firm's
 * latest Brand Truth (firm banned_claims + jurisdiction rulebook).
 *
 * Returns structured hits that the dashboard compliance page can render
 * as a bulleted violation list. No data is persisted — this is a dry
 * run. Fire it from a textarea onChange with a debounce, or from a
 * "Check compliance" button click.
 */
export async function checkCopyCompliance(
  firmSlug: string,
  text: string,
): Promise<ComplianceCheckResult> {
  if (!text || !text.trim()) {
    return {
      ok: true,
      hits: [],
      usedJurisdictions: [],
      usedFirmClaims: 0,
      brandTruthFound: true,
    };
  }

  const bt = await getLatestBrandTruth(firmSlug);
  if (!bt) {
    return {
      ok: false,
      hits: [],
      usedJurisdictions: [],
      usedFirmClaims: 0,
      brandTruthFound: false,
    };
  }

  const hits = validateCopyAgainstBrandTruth(text, bt.payload as BrandTruth);

  return {
    ok: hits.length === 0,
    hits: hits.map((h) => ({
      jurisdiction: h.jurisdiction,
      match: h.match,
      index: h.index,
      reason: h.pattern.reason,
      sourceUrl: h.pattern.source_url,
    })),
    usedJurisdictions: bt.payload.compliance_jurisdictions ?? [],
    usedFirmClaims: (bt.payload.banned_claims ?? []).length,
    brandTruthFound: true,
  };
}

/**
 * Lightweight metadata for the compliance dashboard header — what rules
 * are currently active for the firm, so reviewers know whether they're
 * auditing against a full rulebook or an empty one.
 */
export async function getComplianceScope(
  firmSlug: string,
): Promise<{
  brandTruthFound: boolean;
  jurisdictions: Array<{ code: string; ruleCount: number; known: boolean }>;
  firmBannedClaims: Array<{ claim: string; reason: string; source_rule?: string }>;
}> {
  const bt = await getLatestBrandTruth(firmSlug);
  if (!bt) {
    return { brandTruthFound: false, jurisdictions: [], firmBannedClaims: [] };
  }
  const codes = bt.payload.compliance_jurisdictions ?? [];
  return {
    brandTruthFound: true,
    jurisdictions: codes.map((code) => ({
      code,
      ruleCount: SEED_BANNED_PATTERNS[code]?.length ?? 0,
      known: Boolean(SEED_BANNED_PATTERNS[code]),
    })),
    firmBannedClaims: bt.payload.banned_claims ?? [],
  };
}
