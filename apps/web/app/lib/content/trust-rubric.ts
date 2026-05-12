/**
 * Trust Alignment Audit — pure claim extraction + consistency checks.
 *
 * Phase 6 SOP `trust_alignment_audit`. V1 scope: catch the trust-
 * destroying inconsistencies LLMs notice and silently de-prioritize:
 *
 *   1. Year claims that contradict each other across pages
 *      ("Established 1992" on one page, "Founded in 1995" on another)
 *   2. Quantity claims that contradict each other
 *      ("500+ cases" here, "1000+ cases" there)
 *   3. Banned-claim policy violations (Brand Truth carries a
 *      `banned_claims` list per firm_type — superlative claims that
 *      bar associations / state dental boards / FTC prohibit)
 *   4. Award claims that don't appear in Brand Truth's verified
 *      `awards` list (unverifiable trust claim)
 *
 * External consensus checks (Wikipedia, Google KG, GBP attribute
 * verification) are out of scope for v1 — they need their own API
 * wiring. The v1 audit gets the highest-impact catches without any
 * new external dependencies.
 *
 * Pure module — no DB access. The scanner orchestrator handles I/O.
 */

import type { BrandTruth } from '@ai-edge/shared';

export type TrustFindingKind =
  | 'year_inconsistency'
  | 'quantity_inconsistency'
  | 'banned_claim'
  | 'unverified_award';

export type TrustFindingSeverity = 'high' | 'medium' | 'low';

export interface TrustFinding {
  kind: TrustFindingKind;
  severity: TrustFindingSeverity;
  /** Operator-facing summary of the issue. */
  label: string;
  /** Full detail with the offending substrings, page URLs, etc. */
  detail: string;
  /** URLs of every page implicated by this finding. */
  pageUrls: string[];
  /** Free-form extra payload (e.g. the conflicting year values). */
  evidence?: Record<string, unknown>;
}

export interface ExtractedClaims {
  url: string;
  /**
   * Distinct founding/establishment year claims. Only "strong" triggers
   * count here — "founded", "established", "in business since" — phrases
   * that unambiguously assert a firm's start date. The looser "since
   * 2024 we've expanded" / "operating since X" forms are intentionally
   * excluded because they routinely refer to milestones, expansions, or
   * competitor mentions rather than the firm's founding year.
   */
  yearClaims: number[];
  /** Distinct quantity claims ("500+", "1000+"). Normalised to numbers. */
  quantityClaims: Array<{ value: number; label: string }>;
  /** Award names mentioned in the body. */
  awardClaims: string[];
  /** Banned phrases (from Brand Truth) that appear verbatim. */
  bannedHits: string[];
}

// Strong founding-claim trigger. "Founded" + "established" + "in business
// since" — phrases where the year almost always refers to the firm's
// start date. Used for the year-inconsistency detector.
const YEAR_FOUNDING_RE =
  /\b(?:established(?:\s+in)?|founded(?:\s+in)?|in\s+business\s+since)\s+(?:in\s+)?(\d{4})\b/gi;

// "500+ cases", "1,000 happy clients", "50,000 satisfied customers"
const QUANTITY_RE =
  /\b(\d{1,3}(?:,\d{3})*|\d+)\s*\+?\s*(cases?|clients?|customers?|patients?|practices?|reviews?|testimonials?|projects?|hires?|engagements?)\b/gi;

const AWARD_TRIGGERS_RE =
  /\b(?:awarded|named|recognized\s+as|recipient\s+of|winner\s+of|inducted)\s+["“]?([A-Z][\w\s'\-&]+?)["”]?(?:\.|,|;|$)/g;

/**
 * Words that indicate the capture is plausibly an award name vs a person
 * being named to a role. We require at least one of these in the captured
 * string before treating it as an award claim. Eliminates the "named John
 * Smith partner" → captured "John Smith partner" false positive class.
 *
 * Kept conservative — when the corpus is genuinely ambiguous we'd rather
 * miss a real award (operator catches via Brand Truth review) than flag
 * a real person's name as an award (operator dismisses tickets and loses
 * trust in the scanner).
 */
const AWARD_NAME_WORDS = new Set<string>(
  'award awards lawyer lawyers attorney attorneys dentist doctor honor honors recognition recipient year fame excellence outstanding best top winner finalist member fellow inducted hall society academy of-the-year'
    .split(' '),
);

function looksLikeAwardName(captured: string): boolean {
  const lc = captured.toLowerCase();
  if (lc.length < 4 || lc.length > 80) return false;
  // Tokenize on whitespace + punctuation; check tokens against the
  // award-word allowlist. Single-match is enough — real awards
  // typically carry exactly one of these words.
  const tokens = lc.split(/[\s,'\-&]+/).filter(Boolean);
  for (const t of tokens) {
    if (AWARD_NAME_WORDS.has(t)) return true;
  }
  return false;
}

/** Extract every factual-claim signal from a page body. */
export function extractClaims(url: string, body: string): ExtractedClaims {
  const text = body ?? '';

  // Years (founding/establishment only — see YEAR_FOUNDING_RE rationale).
  const years = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = YEAR_FOUNDING_RE.exec(text)) !== null) {
    const y = parseInt(m[1]!, 10);
    if (y >= 1800 && y <= new Date().getFullYear()) years.add(y);
  }

  // Quantities — only retain the largest-by-noun pairs.
  const qByNoun = new Map<string, { value: number; label: string }>();
  while ((m = QUANTITY_RE.exec(text)) !== null) {
    const raw = m[1]!.replace(/,/g, '');
    const noun = m[2]!.toLowerCase().replace(/s$/, '');
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) continue;
    if (n < 5 || n > 10_000_000) continue; // skip obvious non-claims
    const prev = qByNoun.get(noun);
    if (!prev || prev.value < n) {
      qByNoun.set(noun, { value: n, label: `${m[1]!}${raw.endsWith(noun) ? '' : '+'} ${noun}` });
    }
  }

  // Awards. The trigger regex captures any capitalized phrase after
  // "named"/"awarded"/etc.; looksLikeAwardName filters out captures
  // that are likely person names, role descriptions, or place names
  // rather than actual awards.
  const awards = new Set<string>();
  while ((m = AWARD_TRIGGERS_RE.exec(text)) !== null) {
    const cleaned = m[1]!.trim();
    if (looksLikeAwardName(cleaned)) awards.add(cleaned);
  }

  return {
    url,
    yearClaims: [...years].sort((a, b) => a - b),
    quantityClaims: [...qByNoun.values()].sort((a, b) => b.value - a.value),
    awardClaims: [...awards],
    bannedHits: [], // populated by checkBannedClaims below
  };
}

/**
 * Detect Brand Truth banned-claim violations on a page. Banned-claim
 * objects can be either a plain string or an object with a `phrase`
 * field (per shared/brand-truth.ts). We accept both shapes and run a
 * case-insensitive substring check.
 */
export function checkBannedClaims(
  body: string,
  brandTruth: BrandTruth | null | undefined,
): string[] {
  if (!brandTruth || !body) return [];
  const bt = brandTruth as { banned_claims?: Array<unknown> };
  const banned = bt.banned_claims ?? [];
  const haystack = body.toLowerCase();
  const hits: string[] = [];
  for (const item of banned) {
    let phrase: string | null = null;
    if (typeof item === 'string') phrase = item;
    else if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const p = obj.phrase ?? obj.claim ?? obj.text;
      if (typeof p === 'string') phrase = p;
    }
    if (!phrase) continue;
    const needle = phrase.trim().toLowerCase();
    // Minimum 4 chars to avoid substring matches against common short
    // words ("we" → "weeks", "win" → "winterize"). Brand-Truth banned
    // claims are policy violations (FTC superlatives, bar-rule banned
    // claims, etc.) which are always full phrases anyway.
    if (needle.length < 4) continue;
    if (haystack.includes(needle)) hits.push(phrase);
  }
  return hits;
}

/**
 * Pull the verified award names from Brand Truth. Each variant
 * (law_firm / dental / agency / other) shares `awards: AwardSchema[]`
 * via baseFields.
 */
export function extractVerifiedAwards(brandTruth: BrandTruth | null | undefined): string[] {
  if (!brandTruth) return [];
  const bt = brandTruth as { awards?: Array<unknown> };
  const list = bt.awards ?? [];
  const out: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const name = obj.name ?? obj.title;
    if (typeof name === 'string' && name.trim()) out.push(name.trim());
  }
  return out;
}

/**
 * Combine per-page claim extractions across the whole corpus to find
 * cross-page contradictions, banned-claim violations, and unverified
 * award claims.
 */
export function detectFindings(
  perPage: ExtractedClaims[],
  brandTruth: BrandTruth | null | undefined,
): TrustFinding[] {
  const findings: TrustFinding[] = [];

  // 1. Year inconsistencies — distinct year-claims across the corpus
  // when the *kind* of claim is "since/established/founded". A firm
  // should have exactly one founding year; multiple distinct values
  // is an inconsistency to flag.
  const yearToPages = new Map<number, Set<string>>();
  for (const p of perPage) {
    for (const y of p.yearClaims) {
      if (!yearToPages.has(y)) yearToPages.set(y, new Set());
      yearToPages.get(y)!.add(p.url);
    }
  }
  if (yearToPages.size > 1) {
    const years = [...yearToPages.keys()].sort((a, b) => a - b);
    const allPages = new Set<string>();
    for (const pages of yearToPages.values()) {
      for (const u of pages) allPages.add(u);
    }
    findings.push({
      kind: 'year_inconsistency',
      severity: 'high',
      label: `Multiple founding/operation years claimed across the site (${years.join(', ')})`,
      detail:
        `Pages on this site claim different founding/operation years. LLMs notice this and silently de-prioritize the page. Settle on a single year, update Brand Truth, and propagate the correction to every page.\n\nDetected years per page:\n` +
        years
          .map((y) => `- ${y}: ${[...(yearToPages.get(y) ?? [])].join(', ')}`)
          .join('\n'),
      pageUrls: [...allPages],
      evidence: { years, yearToPages: Object.fromEntries([...yearToPages].map(([y, s]) => [y, [...s]])) },
    });
  }

  // 2. Quantity inconsistencies — for each quantified noun, find
  // distinct values across the corpus. We tolerate one rounded version
  // ("500+" and "500 cases" treated as same value); only flag when
  // *distinct* values appear.
  const quantByNoun = new Map<string, Map<number, Set<string>>>();
  for (const p of perPage) {
    for (const q of p.quantityClaims) {
      const noun = q.label.split(' ').pop()!.replace(/s$/, '');
      if (!quantByNoun.has(noun)) quantByNoun.set(noun, new Map());
      const inner = quantByNoun.get(noun)!;
      if (!inner.has(q.value)) inner.set(q.value, new Set());
      inner.get(q.value)!.add(p.url);
    }
  }
  for (const [noun, valuesMap] of quantByNoun) {
    if (valuesMap.size <= 1) continue;
    const values = [...valuesMap.keys()].sort((a, b) => a - b);
    const allPages = new Set<string>();
    for (const pages of valuesMap.values()) {
      for (const u of pages) allPages.add(u);
    }
    findings.push({
      kind: 'quantity_inconsistency',
      severity: 'medium',
      label: `Inconsistent "${noun}" counts across pages (${values.join(', ')})`,
      detail:
        `Different pages claim different totals for "${noun}". Pick the current accurate number, update Brand Truth, and propagate.\n\nValues found:\n` +
        values
          .map((v) => `- ${v.toLocaleString()}: ${[...(valuesMap.get(v) ?? [])].join(', ')}`)
          .join('\n'),
      pageUrls: [...allPages],
      evidence: { noun, values },
    });
  }

  // 3. Banned-claim violations — per page.
  for (const p of perPage) {
    if (p.bannedHits.length === 0) continue;
    findings.push({
      kind: 'banned_claim',
      severity: 'high',
      label: `Banned-claim violation: ${p.bannedHits.slice(0, 2).join('; ')}`,
      detail: `Page contains phrases on the Brand Truth banned_claims list. In regulated industries (law, dental, medical) these can carry actual regulatory exposure — remove or rephrase before publication.\n\nOffending phrases:\n${p.bannedHits.map((h) => `- "${h}"`).join('\n')}`,
      pageUrls: [p.url],
      evidence: { phrases: p.bannedHits },
    });
  }

  // 4. Unverified award claims — per page. An award name on a page
  // that doesn't appear in Brand Truth's verified `awards` list is a
  // trust risk: LLMs cross-check awards against authoritative
  // directories (Super Lawyers, Best Lawyers, ADA, etc.) and will
  // call out unverifiable claims.
  const verified = new Set(
    extractVerifiedAwards(brandTruth).map((a) => a.toLowerCase()),
  );
  for (const p of perPage) {
    if (p.awardClaims.length === 0) continue;
    const unverified = p.awardClaims.filter(
      (a) => !verified.has(a.toLowerCase()),
    );
    if (unverified.length === 0) continue;
    findings.push({
      kind: 'unverified_award',
      severity: 'medium',
      label: `Unverified award claim${unverified.length === 1 ? '' : 's'}: ${unverified.slice(0, 2).join('; ')}${unverified.length > 2 ? ', …' : ''}`,
      detail: `Page claims awards that don't appear in Brand Truth's verified \`awards\` list. Either add the award to Brand Truth (with the source URL + year) or remove the claim — unverifiable trust claims hurt citation chances.\n\nAward claims found:\n${unverified.map((a) => `- "${a}"`).join('\n')}`,
      pageUrls: [p.url],
      evidence: { awards: unverified },
    });
  }

  return findings;
}
