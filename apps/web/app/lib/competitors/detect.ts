/**
 * Competitor detection — scan an LLM response for firm + competitor mentions
 * and produce one `competitor_mention` row per detected competitor.
 *
 * Design notes:
 *  - Fully deterministic (no LLM judge call) so cost stays at zero per
 *    response. We already pay for the alignment judge; adding another round
 *    per-provider-per-query would roughly triple judge spend without a clear
 *    quality win for this signal.
 *  - Share-of-mention is computed response-scoped: "of all firm/competitor
 *    mentions in this one response, what fraction belongs to this
 *    competitor?". This is the intuitive number — a response that name-drops
 *    us once and competitor X four times gives X a share of 0.8.
 *  - Praise detection is a simple proximity heuristic: if a POSITIVE_ADJECTIVE
 *    appears within ~60 characters of a competitor mention, flag it. Cheap,
 *    recall-first; can be swapped for a per-response judge later if useful.
 */

import type { BrandTruth } from '@ai-edge/shared';

export type CompetitorInput = {
  id: string;
  name: string;
  website: string | null;
};

export type DetectedMention = {
  competitorId: string;
  /** 0..1 — response-scoped share vs firm + all competitors mentioned. */
  share: number;
  /** True if a positive adjective appears near any mention. */
  praiseFlag: boolean;
};

/**
 * Positive adjectives the LLM might use when praising a firm. Kept narrow
 * on purpose — we want precision over recall, because a false "praise" flag
 * on a competitor is misleading ("their service is `aggressive`" shouldn't
 * trigger). Expand as we see real misses in the corpus.
 */
const POSITIVE_MARKERS = [
  'best', 'top', 'leading', 'top-rated', 'highly rated', 'highly-rated',
  'excellent', 'outstanding', 'exceptional', 'reputable',
  'well-known', 'well known', 'renowned', 'respected', 'recommended',
  'trusted', 'award-winning', 'award winning', 'premier',
];

/** Normalize text for case-insensitive substring search. */
function normalize(s: string): string {
  return s.toLowerCase();
}

/**
 * Extract the bare domain from a URL (or a URL-ish string). Returns empty
 * string for unparseable input so the caller can skip it.
 */
function hostOf(website: string | null): string {
  if (!website) return '';
  try {
    const u = new URL(website);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // Not a full URL — strip protocol + leading `www.` manually.
    return website
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0] ?? '';
  }
}

/**
 * Count all (non-overlapping) occurrences of `needle` inside `haystack`.
 * Empty needles return 0 so a competitor with an empty name doesn't poison
 * the share calculation.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * Find the character positions of every occurrence of `needle` in `haystack`.
 * Used by the praise-proximity check to know where to look around.
 */
function findPositions(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const positions: number[] = [];
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    positions.push(idx);
    idx += needle.length;
  }
  return positions;
}

function hasPraiseNear(
  normalizedText: string,
  needlePositions: number[],
  windowChars: number = 60,
): boolean {
  if (needlePositions.length === 0) return false;
  for (const pos of needlePositions) {
    const start = Math.max(0, pos - windowChars);
    const end = Math.min(normalizedText.length, pos + windowChars);
    const window = normalizedText.slice(start, end);
    for (const marker of POSITIVE_MARKERS) {
      if (window.includes(marker)) return true;
    }
  }
  return false;
}

/**
 * Count how many times the firm itself is mentioned — name + variants +
 * common misspellings. The denominator for share-of-mention.
 */
function countFirmMentions(
  normalizedText: string,
  brandTruth: BrandTruth,
): number {
  const bt = brandTruth as any;
  const candidates = new Set<string>();
  if (typeof bt.firm_name === 'string') candidates.add(normalize(bt.firm_name));
  for (const v of bt.name_variants ?? []) {
    if (typeof v === 'string' && v.trim()) candidates.add(normalize(v));
  }
  for (const m of bt.common_misspellings ?? []) {
    if (typeof m === 'string' && m.trim()) candidates.add(normalize(m));
  }

  let total = 0;
  for (const c of candidates) {
    total += countOccurrences(normalizedText, c);
  }
  return total;
}

/**
 * Scan `responseText` and return one row per competitor detected in it.
 *
 * Competitors with zero mentions are omitted — persisting a row per roster
 * member per query per provider would bloat the table for no reader-side
 * benefit (the UI already joins-through-roster for zero rows).
 */
export function detectCompetitorMentions(args: {
  brandTruth: BrandTruth;
  competitors: CompetitorInput[];
  responseText: string;
}): DetectedMention[] {
  const { brandTruth, competitors, responseText } = args;
  if (!responseText || competitors.length === 0) return [];

  const normalized = normalize(responseText);

  // Build per-competitor mention counts + positions. We count both by name
  // and by domain — name catches "Smith & Associates", domain catches
  // "smithandassociates.com" bare citations.
  type Detection = {
    id: string;
    count: number;
    positions: number[];
  };

  const detections: Detection[] = competitors.map((c) => {
    const nameNeedle = normalize(c.name);
    const domainNeedle = hostOf(c.website);

    const nameCount = countOccurrences(normalized, nameNeedle);
    const domainCount = domainNeedle
      ? countOccurrences(normalized, domainNeedle)
      : 0;

    const positions = [
      ...findPositions(normalized, nameNeedle),
      ...(domainNeedle ? findPositions(normalized, domainNeedle) : []),
    ];

    return {
      id: c.id,
      count: nameCount + domainCount,
      positions,
    };
  });

  const firmMentions = countFirmMentions(normalized, brandTruth);
  const competitorMentionsTotal = detections.reduce((s, d) => s + d.count, 0);
  const denominator = firmMentions + competitorMentionsTotal;

  // If nothing is mentioned at all, there's nothing to record.
  if (denominator === 0) return [];

  const out: DetectedMention[] = [];
  for (const d of detections) {
    if (d.count === 0) continue;
    out.push({
      competitorId: d.id,
      share: d.count / denominator,
      praiseFlag: hasPraiseNear(normalized, d.positions),
    });
  }
  return out;
}
