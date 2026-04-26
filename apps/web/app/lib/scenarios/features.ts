import * as cheerio from 'cheerio';
import {
  emptyFeatureVec,
  NORMALIZERS,
  SATURATION_CAPS,
  type FeatureVec,
} from './ranker-feature-list';

/**
 * Feature extraction for the Scenario Lab ranker.
 *
 * Two entry points:
 *   - `extractFeaturesFromHtml(html, ctx)` — full pass, parses the raw HTML
 *     for JSON-LD, headings, links. This is the primary path and what the
 *     server action calls when re-running feature extraction for a page.
 *   - `extractFeaturesFromMainContent(text, ctx)` — degraded pass when only
 *     the readability-extracted text is available (e.g. legacy `pages` rows
 *     where we don't keep the original HTML). Most schema features collapse
 *     to 0 in this mode — the operator should re-crawl for accurate scoring.
 *
 * Per-feature notes live next to the assignments below. The output ALWAYS
 * has every key in `FEATURE_NAMES` filled — defaults to 0 for anything we
 * can't determine. The scorer then treats absence-as-zero, which keeps the
 * downstream math well-formed even on a partial extraction.
 */

export interface FeatureExtractionContext {
  /** Canonical URL — used for url_depth + keyword-in-url. */
  url: string;
  /** Optional query the scenario is targeting. Drives keyword features. */
  query?: string;
  /** Brand Truth centroid distance, if already computed by the suppression
   *  scanner. We pass it in rather than re-embedding. Range [0, 2]; we
   *  convert to similarity = 1 - distance, then clamp01. */
  centroidDistance?: number;
  /** Days since the page was last fetched. */
  freshnessDays?: number;
  /** The host of the firm's primary URL — used to separate internal vs
   *  external links. Without it we can't tell, and the link-density
   *  features default to "all external." */
  firmHost?: string;
}

const AUTHORITATIVE_HOST_SUFFIXES = [
  '.gov',
  '.edu',
  'wikipedia.org',
  'bbb.org',
  'superlawyers.com',
  'avvo.com',
  'martindale.com',
  'justia.com',
  'lawyers.com',
  'findlaw.com',
];

function safeHost(href: string | undefined, base?: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return u.host.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function tokenize(s: string | undefined | null): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function urlDepth(url: string): number {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length;
  } catch {
    return 0;
  }
}

/**
 * Walk every JSON-LD script block, returning the union of @type values
 * (lowercased, deduped). Handles arrays-of-types and @graph nesting which
 * are the two forms WordPress / Yoast / RankMath emit.
 */
function collectJsonLdTypes($: cheerio.CheerioAPI): Set<string> {
  const types = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    if (!txt.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(txt);
    } catch {
      return; // malformed JSON-LD is common; skip silently
    }
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      const t = obj['@type'];
      if (typeof t === 'string') types.add(t.toLowerCase());
      else if (Array.isArray(t)) for (const x of t) {
        if (typeof x === 'string') types.add(x.toLowerCase());
      }
      const graph = obj['@graph'];
      if (Array.isArray(graph)) for (const g of graph) visit(g);
      // Some schemas nest entities under arbitrary keys — recurse one level
      // to catch `mainEntity`, `subjectOf`, etc.
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) for (const x of v) visit(x);
        else if (v && typeof v === 'object') visit(v);
      }
    };
    if (Array.isArray(parsed)) for (const p of parsed) visit(p);
    else visit(parsed);
  });
  return types;
}

/**
 * Heuristic FAQ count: an `<h2>`/`<h3>`/`<h4>` ending in `?` followed by a
 * sibling paragraph or the JSON-LD FAQPage's `mainEntity[]` length, whichever
 * is bigger. Captures both authored FAQs and structured-data ones.
 */
function countFaqs($: cheerio.CheerioAPI): number {
  let qHeadings = 0;
  $('h2, h3, h4').each((_, el) => {
    const t = $(el).text().trim();
    if (t.endsWith('?')) qHeadings += 1;
  });

  // Look for FAQPage in JSON-LD — many sites mark up FAQs invisibly.
  let jsonLdQs = 0;
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    if (!txt.trim()) return;
    try {
      const parsed = JSON.parse(txt);
      const visit = (node: unknown) => {
        if (!node || typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        const type = obj['@type'];
        const isFaq =
          (typeof type === 'string' && type.toLowerCase() === 'faqpage') ||
          (Array.isArray(type) &&
            type.some(
              (x) => typeof x === 'string' && x.toLowerCase() === 'faqpage',
            ));
        if (isFaq) {
          const me = obj['mainEntity'];
          if (Array.isArray(me)) jsonLdQs = Math.max(jsonLdQs, me.length);
        }
        const graph = obj['@graph'];
        if (Array.isArray(graph)) for (const g of graph) visit(g);
      };
      if (Array.isArray(parsed)) for (const p of parsed) visit(p);
      else visit(parsed);
    } catch {
      /* ignore */
    }
  });

  return Math.max(qHeadings, jsonLdQs);
}

export function extractFeaturesFromHtml(
  html: string,
  ctx: FeatureExtractionContext,
): FeatureVec {
  const $ = cheerio.load(html);
  const v = emptyFeatureVec();

  // ── Word count (from visible body text, post-strip) ────────────────
  // Exclude noise so a page heavy on `<nav>`/`<footer>` doesn't inflate.
  $('script, style, noscript, nav, header, footer, aside').remove();
  const bodyText = $('body').text() || $.root().text() || '';
  const wordCount = bodyText
    .split(/\s+/)
    .filter((w) => w.length > 1).length;
  v.word_count_log = NORMALIZERS.log1pNorm(wordCount);

  // ── Topical relevance ──────────────────────────────────────────────
  if (typeof ctx.centroidDistance === 'number') {
    // Distance ∈ [0, 2]; similarity = max(0, 1 - distance). Real on-brand
    // pages tend to land in distance [0.30, 0.55], so similarity ∈ [0.45,
    // 0.70]. We don't re-normalize here — let the linear weight sort it out.
    v.centroid_similarity = NORMALIZERS.clamp01(1 - ctx.centroidDistance);
  }

  // Query term density: fraction of query tokens present in the body text.
  // Extremely cheap proxy for BM25; saturates quickly on pages that mention
  // every term once. Good enough as a directional signal.
  const queryTokens = tokenize(ctx.query);
  if (queryTokens.length > 0) {
    const haystack = new Set(tokenize(bodyText));
    const hits = queryTokens.filter((t) => haystack.has(t)).length;
    v.query_term_density = hits / queryTokens.length;
  }

  // ── JSON-LD presence ───────────────────────────────────────────────
  const types = collectJsonLdTypes($);
  v.has_jsonld_organization = types.has('organization') ? 1 : 0;
  v.has_jsonld_legalservice = types.has('legalservice') ? 1 : 0;
  v.has_jsonld_dentist = types.has('dentist') ? 1 : 0;
  v.has_jsonld_person = types.has('person') ? 1 : 0;
  v.has_jsonld_faqpage = types.has('faqpage') ? 1 : 0;
  v.has_jsonld_localbusiness = types.has('localbusiness') ? 1 : 0;
  v.jsonld_type_count_norm = NORMALIZERS.saturate(
    types.size,
    SATURATION_CAPS.jsonld_types,
  );

  // ── Headings ───────────────────────────────────────────────────────
  v.has_h1 = $('h1').length > 0 ? 1 : 0;
  v.h2_count_norm = NORMALIZERS.saturate(
    $('h2').length,
    SATURATION_CAPS.h2_count,
  );
  let depth = 0;
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    if ($(tag).length > 0) depth += 1;
  }
  v.heading_depth_norm = NORMALIZERS.saturate(
    depth,
    SATURATION_CAPS.heading_depth,
  );

  // ── Links ──────────────────────────────────────────────────────────
  let internalCount = 0;
  let externalCount = 0;
  let authorityCount = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const host = safeHost(href, ctx.url);
    if (!host) return;
    if (ctx.firmHost && host === ctx.firmHost.toLowerCase().replace(/^www\./, '')) {
      internalCount += 1;
    } else {
      externalCount += 1;
      if (AUTHORITATIVE_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
        authorityCount += 1;
      }
    }
  });
  // Density = links / words, then saturate. Avoids "more is always better"
  // for sites that pad themselves with link farms.
  const denom = Math.max(1, wordCount);
  v.internal_link_density = NORMALIZERS.saturate(
    internalCount / denom,
    SATURATION_CAPS.internal_link_density_per_word,
  );
  v.external_link_density = NORMALIZERS.saturate(
    externalCount / denom,
    SATURATION_CAPS.external_link_density_per_word,
  );
  v.authoritative_external_links_norm = NORMALIZERS.saturate(
    authorityCount,
    SATURATION_CAPS.authoritative_links,
  );

  // ── FAQ ────────────────────────────────────────────────────────────
  v.faq_count_norm = NORMALIZERS.saturate(
    countFaqs($),
    SATURATION_CAPS.faq_count,
  );

  // ── Freshness ──────────────────────────────────────────────────────
  if (typeof ctx.freshnessDays === 'number') {
    v.freshness_score = NORMALIZERS.freshness(ctx.freshnessDays);
  } else {
    v.freshness_score = 0.5; // unknown — neutral
  }

  // ── URL signals ────────────────────────────────────────────────────
  v.url_depth_inv = NORMALIZERS.inverseDepth(urlDepth(ctx.url));

  if (queryTokens.length > 0) {
    const urlPath = ctx.url.toLowerCase();
    const titleText = ($('title').first().text() || '').toLowerCase();
    const h1Text = ($('h1').first().text() || '').toLowerCase();
    v.has_keyword_in_url = queryTokens.some((t) => urlPath.includes(t)) ? 1 : 0;
    v.has_keyword_in_title = queryTokens.some((t) => titleText.includes(t))
      ? 1
      : 0;
    v.has_keyword_in_h1 = queryTokens.some((t) => h1Text.includes(t)) ? 1 : 0;
  }

  return v;
}

/**
 * Degraded extractor for the case where we have the readability-extracted
 * `main_content` text but not the original HTML. Most schema/structure
 * features collapse to 0 — surface this as a UI hint ("re-crawl for
 * accurate features"). Word count, query-term density, centroid similarity,
 * URL depth, freshness, and keyword-in-URL still work.
 */
export function extractFeaturesFromMainContent(
  mainContent: string,
  ctx: FeatureExtractionContext,
): FeatureVec {
  const v = emptyFeatureVec();
  const wordCount = mainContent
    .split(/\s+/)
    .filter((w) => w.length > 1).length;
  v.word_count_log = NORMALIZERS.log1pNorm(wordCount);
  if (typeof ctx.centroidDistance === 'number') {
    v.centroid_similarity = NORMALIZERS.clamp01(1 - ctx.centroidDistance);
  }
  const queryTokens = tokenize(ctx.query);
  if (queryTokens.length > 0) {
    const haystack = new Set(tokenize(mainContent));
    const hits = queryTokens.filter((t) => haystack.has(t)).length;
    v.query_term_density = hits / queryTokens.length;
  }
  if (typeof ctx.freshnessDays === 'number') {
    v.freshness_score = NORMALIZERS.freshness(ctx.freshnessDays);
  } else {
    v.freshness_score = 0.5;
  }
  v.url_depth_inv = NORMALIZERS.inverseDepth(urlDepth(ctx.url));
  if (queryTokens.length > 0) {
    const urlPath = ctx.url.toLowerCase();
    v.has_keyword_in_url = queryTokens.some((t) => urlPath.includes(t)) ? 1 : 0;
  }
  return v;
}

/**
 * Apply a proposed change to a baseline feature vector and return the
 * modified vector. Shared between the "preview" UI and the simulator's
 * Δrank computation.
 *
 * Operations:
 *   numeric:  '+200' add, '-50' subtract, '*1.5' multiply, '=1500' assign
 *   boolean:  true / false set the flag
 *   shorthand: a bare number is treated as `=`, a bare string passed to
 *              parseChangeOp.
 *
 * IMPORTANT: changes are applied to NORMALIZED values, since the rest of
 * the pipeline operates on those. A scenario like "add 200 words" is
 * approximated as "bump word_count_log to reflect 10^(current * 4) + 200,
 * then re-normalize." The simulator caller passes raw deltas through
 * `applyRawCountChange` for that case.
 */
export function applyProposedChange(
  baseline: FeatureVec,
  change: Record<string, string | number | boolean>,
): FeatureVec {
  const out: FeatureVec = { ...baseline };
  for (const [key, raw] of Object.entries(change)) {
    if (!(key in baseline)) continue; // ignore unknown features
    const k = key as keyof FeatureVec;
    if (typeof raw === 'boolean') {
      out[k] = raw ? 1 : 0;
      continue;
    }
    if (typeof raw === 'number') {
      out[k] = raw;
      continue;
    }
    const m = /^([+\-*=])\s*(-?\d+(?:\.\d+)?)$/.exec(raw.trim());
    if (!m) continue;
    const op = m[1]!;
    const val = Number(m[2]!);
    const current = out[k] ?? 0;
    if (op === '+') out[k] = current + val;
    else if (op === '-') out[k] = current - val;
    else if (op === '*') out[k] = current * val;
    else if (op === '=') out[k] = val;
  }
  return out;
}

/**
 * Convenience: bump `word_count_log` by adding N raw words to the implied
 * underlying count. Reverses the log normalization, applies the delta,
 * re-normalizes. The UI uses this for the "+200 words" change template.
 */
export function bumpWordCount(baseline: FeatureVec, addedWords: number): FeatureVec {
  const currentLog10 = baseline.word_count_log * 4;
  const currentWords = Math.pow(10, currentLog10) - 1;
  const newWords = Math.max(0, currentWords + addedWords);
  return {
    ...baseline,
    word_count_log: NORMALIZERS.log1pNorm(newWords),
  };
}
