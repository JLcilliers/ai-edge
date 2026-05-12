/**
 * LLM-Friendly Content Checklist — pure scoring rubric.
 *
 * The Steve Toth SOP defines a five-step pre-publication QA pass:
 *   1. Structure Check (H1, headings, intro)
 *   2. Positioning Alignment Check (matches Brand Truth)
 *   3. Schema Markup Check (JSON-LD present)
 *   4. Citation Readiness Check (specific facts LLMs can quote)
 *   5. Final Approval (operator)
 *
 * We translate that into a 7-criterion automatable rubric over the data
 * we already capture during the suppression crawl (page.title,
 * page.main_content, page.word_count, page.embedding). Each criterion
 * is independent and pass/fail; the overall score is 0..7. Pages that
 * score < 5 emit a remediation ticket.
 *
 * We intentionally keep this module pure (no DB access, no fetch) so it's
 * cheap to unit-test, swap into Phase 3's CMS preview flow later, and
 * reason about. The scanner orchestrator (llm-friendly-scanner.ts) is
 * the one that pulls rows from Postgres and decides which page to score.
 */

import type { BrandTruth } from '@ai-edge/shared';

// Tightened from the suppression scanner's 0.40 — the LLM-friendliness
// pass should flag pages that are merely "drifting" before they cross
// the suppression threshold. We're protecting the citation surface, not
// the indexability surface.
const POSITIONING_DRIFT_THRESHOLD = 0.42;

// Sweet spot for citation-worthy depth. Below 400 words, pages typically
// don't have enough substance to be paragraph-cited. Above 6000 words,
// LLMs pull from the middle and miss the framing.
const MIN_BODY_WORDS = 400;
const MAX_BODY_WORDS = 6000;

const MIN_TITLE_CHARS = 10;
const MAX_TITLE_CHARS = 70;

export type CriterionKey =
  | 'title_present'
  | 'title_length'
  | 'body_length_floor'
  | 'body_length_ceiling'
  | 'positioning_alignment'
  | 'citable_facts'
  | 'required_phrases';

export interface CriterionResult {
  key: CriterionKey;
  label: string;
  passed: boolean;
  /** Why it failed — operator-facing one-liner. Empty when passed. */
  detail: string;
}

export interface PageScore {
  url: string;
  title: string | null;
  wordCount: number;
  semanticDistance: number | null;
  criteria: CriterionResult[];
  /** 0..7. */
  total: number;
  /** Pages below the pass bar — these emit tickets. */
  failed: boolean;
}

export interface ScorePageInput {
  url: string;
  title: string | null;
  mainContent: string | null;
  wordCount: number | null;
  /** Cosine distance from Brand Truth centroid, if computed. Null when missing. */
  semanticDistance: number | null;
  /** Brand Truth's required positioning phrases — checked verbatim, case-insensitive. */
  requiredPhrases: readonly string[];
}

/** Threshold at which a page is considered to be failing the rubric. */
export const PASS_THRESHOLD = 5;

/** Total possible score per page. */
export const MAX_SCORE = 7;

/**
 * Heuristic to detect citable, fact-dense prose. LLMs preferentially
 * quote sentences that contain specific anchors: a year (1990–2099), a
 * percentage, a dollar amount, an ordinal milestone, or a named entity
 * pattern (Capitalized Phrases of 2-4 words). We count distinct
 * occurrences and require at least 3 — fewer than that, the page is
 * mostly soft prose that doesn't survive LLM extractive sampling.
 *
 * Lives in this module (not embeddings.ts) so the rubric is fully
 * self-contained and testable without spinning up the OpenAI client.
 */
export function countCitableFacts(text: string): number {
  if (!text) return 0;
  const patterns = [
    /\b(?:19|20)\d{2}\b/g,                    // years
    /\b\d{1,3}(?:\.\d+)?\s*%/g,                // percentages
    /\$\s*\d[\d,]*(?:\.\d+)?(?:\s*(?:million|billion|m|b|k))?/gi, // money
    /\b\d{1,2}(?:st|nd|rd|th)\b/g,             // ordinals
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/g, // dates
  ];
  let count = 0;
  for (const p of patterns) {
    const matches = text.match(p);
    if (matches) count += matches.length;
    if (count >= 3) return count; // early exit once we know it passes
  }
  return count;
}

/**
 * Case-insensitive substring count for required positioning phrases.
 * Brand Truth captures these as `required_positioning_phrases` — for a
 * law firm this might be {"injury claims", "no fee unless we win"};
 * for a dental practice {"family dentistry", "pediatric exams"}. A page
 * passes when ≥1 phrase appears verbatim in the body.
 */
export function matchedRequiredPhrases(
  body: string,
  phrases: readonly string[],
): string[] {
  if (!body || phrases.length === 0) return [];
  const haystack = body.toLowerCase();
  const matched: string[] = [];
  for (const p of phrases) {
    if (!p.trim()) continue;
    if (haystack.includes(p.toLowerCase())) matched.push(p);
  }
  return matched;
}

/**
 * Score one page against the 7-criterion rubric. Pure function. The
 * caller resolves Brand Truth + semantic distance and passes them in.
 */
export function scorePage(input: ScorePageInput): PageScore {
  const body = input.mainContent ?? '';
  const wc = input.wordCount ?? 0;
  const criteria: CriterionResult[] = [];

  // 1. Title present
  const titlePresent = !!input.title && input.title.trim().length > 0;
  criteria.push({
    key: 'title_present',
    label: 'Title present',
    passed: titlePresent,
    detail: titlePresent ? '' : 'Page has no <title> tag — LLMs can\'t resolve a topical anchor for citations.',
  });

  // 2. Title length in the citable range
  const titleLen = input.title?.trim().length ?? 0;
  const titleLengthOk = titleLen >= MIN_TITLE_CHARS && titleLen <= MAX_TITLE_CHARS;
  criteria.push({
    key: 'title_length',
    label: `Title length ${MIN_TITLE_CHARS}–${MAX_TITLE_CHARS} chars`,
    passed: titleLengthOk,
    detail: titleLengthOk
      ? ''
      : titleLen === 0
        ? 'Empty title.'
        : titleLen < MIN_TITLE_CHARS
          ? `Title is only ${titleLen} chars — too thin to be a citation anchor.`
          : `Title is ${titleLen} chars — over ${MAX_TITLE_CHARS} truncates in SERP + AIO previews.`,
  });

  // 3. Body word count meets the floor
  const wordsFloorOk = wc >= MIN_BODY_WORDS;
  criteria.push({
    key: 'body_length_floor',
    label: `≥ ${MIN_BODY_WORDS} words`,
    passed: wordsFloorOk,
    detail: wordsFloorOk
      ? ''
      : `Only ${wc} words. Below ${MIN_BODY_WORDS} LLMs rarely have enough context to paragraph-cite.`,
  });

  // 4. Body word count under the ceiling
  const wordsCeilingOk = wc <= MAX_BODY_WORDS;
  criteria.push({
    key: 'body_length_ceiling',
    label: `≤ ${MAX_BODY_WORDS} words`,
    passed: wordsCeilingOk,
    detail: wordsCeilingOk
      ? ''
      : `${wc} words. Over ${MAX_BODY_WORDS} dilutes core facts — LLMs sample the middle and miss your framing.`,
  });

  // 5. Positioning alignment with Brand Truth
  let alignmentOk: boolean;
  let alignmentDetail = '';
  if (input.semanticDistance == null) {
    // No embedding means we can't score this dimension — count as failed
    // so the operator knows to re-run the suppression crawl that
    // populates page.embedding.
    alignmentOk = false;
    alignmentDetail = 'Page has no embedding yet — run the Suppression scan to populate it before re-scoring.';
  } else {
    alignmentOk = input.semanticDistance <= POSITIONING_DRIFT_THRESHOLD;
    if (!alignmentOk) {
      alignmentDetail = `Semantic distance ${input.semanticDistance.toFixed(3)} > ${POSITIONING_DRIFT_THRESHOLD} — page wording drifts from Brand Truth positioning.`;
    }
  }
  criteria.push({
    key: 'positioning_alignment',
    label: 'Positioning aligned with Brand Truth',
    passed: alignmentOk,
    detail: alignmentDetail,
  });

  // 6. Citation readiness — ≥3 fact anchors in the body
  const factCount = countCitableFacts(body);
  const factsOk = factCount >= 3;
  criteria.push({
    key: 'citable_facts',
    label: 'Citable facts (years, %, $, dates, ordinals)',
    passed: factsOk,
    detail: factsOk
      ? ''
      : `Only ${factCount} fact-style anchors. Add specific numbers, dates, or percentages LLMs can quote.`,
  });

  // 7. Required positioning phrases — ≥1 of Brand Truth's phrases appears
  let phrasesOk: boolean;
  let phrasesDetail = '';
  if (input.requiredPhrases.length === 0) {
    // Vacuously pass when Brand Truth doesn't define any required
    // phrases — we don't want to penalize firms that haven't filled
    // out that field, just nudge them via a separate notification.
    phrasesOk = true;
  } else {
    const matched = matchedRequiredPhrases(body, input.requiredPhrases);
    phrasesOk = matched.length >= 1;
    if (!phrasesOk) {
      const sample = input.requiredPhrases.slice(0, 3).map((p) => `"${p}"`).join(', ');
      phrasesDetail = `None of the required positioning phrases (${sample}${input.requiredPhrases.length > 3 ? ', …' : ''}) appear in the body.`;
    }
  }
  criteria.push({
    key: 'required_phrases',
    label: 'Required positioning phrases present',
    passed: phrasesOk,
    detail: phrasesDetail,
  });

  const total = criteria.filter((c) => c.passed).length;
  return {
    url: input.url,
    title: input.title,
    wordCount: wc,
    semanticDistance: input.semanticDistance,
    criteria,
    total,
    failed: total < PASS_THRESHOLD,
  };
}

/**
 * Extract Brand Truth's required positioning phrases, regardless of the
 * firm_type variant. Defensive — the field is in the shared base but
 * defaults to []. Returns trimmed non-empty strings only.
 */
export function extractRequiredPhrases(brandTruth: BrandTruth | null | undefined): string[] {
  if (!brandTruth) return [];
  // All four firm-type variants share `required_positioning_phrases`
  // via baseFields in packages/shared/src/brand-truth.ts.
  const raw = (brandTruth as { required_positioning_phrases?: unknown }).required_positioning_phrases;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
