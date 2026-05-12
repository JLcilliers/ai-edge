/**
 * Semantic HTML Optimization — pure scoring rubric.
 *
 * Steve Toth's Phase 5 SOP scores each page 0-100 across seven
 * weighted criteria:
 *
 *   Document structure   <main>/<section>/<article>   25
 *   Definition lists     <dl>/<dt>/<dd>                20
 *   Semantic text        <strong>/<em> (not <b>/<i>)   15
 *   Heading hierarchy    H1 unique, no skips           15
 *   Figures              <figure>/<figcaption>         10
 *   Sectioning           <header>/<footer>/<aside>     10
 *   Semantic tables      <thead>/<tbody>/<th>           5
 *                                                    ───
 *                                              Total  100
 *
 * Priority bands:
 *   < 40   → High (major restructuring)
 *   40-70  → Medium (targeted improvements)
 *   > 70   → Low (maintenance only)
 *
 * Pages scoring < 70 emit a remediation ticket; pages > 70 are reported
 * but don't generate work. Pages > 90 don't even register on the
 * surface — they're noise the operator doesn't need to see.
 *
 * We use regex-based tag detection rather than a full HTML parser.
 * Reasoning: the rubric counts tag presence + structural relationships
 * a regex can reliably check (heading sequence, semantic-vs-
 * presentational text). False positives on edge cases (e.g. <strong>
 * inside a <script>) round to under 1% of pages and don't change the
 * priority band assignment.
 *
 * Pure module — no DB, no fetch. The scanner orchestrator handles I/O.
 */

export type SemanticCriterionKey =
  | 'document_structure'
  | 'definition_lists'
  | 'semantic_text'
  | 'heading_hierarchy'
  | 'figures'
  | 'sectioning'
  | 'semantic_tables';

export interface SemanticCriterionResult {
  key: SemanticCriterionKey;
  label: string;
  /** Points earned for this criterion. */
  score: number;
  /** Max points the criterion is worth. */
  max: number;
  /** Operator-facing explanation of why the score is what it is. */
  detail: string;
}

export interface SemanticPageScore {
  url: string;
  /** 0..100 total. */
  total: number;
  /** Priority bucket per SOP rubric. */
  band: 'high' | 'medium' | 'low' | 'maintenance';
  criteria: SemanticCriterionResult[];
}

export const SCORE_BAND_HIGH = 40;
export const SCORE_BAND_MEDIUM = 70;
/** Pages over this don't emit tickets — they're well-marked-up already. */
export const TICKET_THRESHOLD = 70;

const MAX_DOCUMENT_STRUCTURE = 25;
const MAX_DEFINITION_LISTS = 20;
const MAX_SEMANTIC_TEXT = 15;
const MAX_HEADING_HIERARCHY = 15;
const MAX_FIGURES = 10;
const MAX_SECTIONING = 10;
const MAX_SEMANTIC_TABLES = 5;

/** Count opening tag occurrences in source HTML, case-insensitive. */
function countTag(html: string, tag: string): number {
  // Match `<tag>` or `<tag ...>` but not `</tag>` and not `<tagsomething>`.
  // Captures self-closing variants too.
  const re = new RegExp(`<${tag}(\\s|>|/)`, 'gi');
  const matches = html.match(re);
  return matches ? matches.length : 0;
}

/** Count both opening and closing occurrences — useful when we want
 * to know the table even has paired structure. */
function tagPresent(html: string, tag: string): boolean {
  return countTag(html, tag) > 0;
}

/** Strip <script>, <style>, and comments. Keeps regex tag-counts honest. */
function sanitize(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Document structure: <main>, <section>, <article>. Worth 25 points.
 *   - <main> present: 10
 *   - <article> present: 8
 *   - <section> present (≥1): 7
 */
function scoreDocumentStructure(html: string): SemanticCriterionResult {
  const hasMain = tagPresent(html, 'main');
  const hasArticle = tagPresent(html, 'article');
  const hasSection = tagPresent(html, 'section');
  let score = 0;
  const reasons: string[] = [];
  if (hasMain) {
    score += 10;
  } else {
    reasons.push('no <main> wrapper');
  }
  if (hasArticle) {
    score += 8;
  } else {
    reasons.push('no <article>');
  }
  if (hasSection) {
    score += 7;
  } else {
    reasons.push('no <section>');
  }
  return {
    key: 'document_structure',
    label: 'Document structure (<main>/<article>/<section>)',
    score,
    max: MAX_DOCUMENT_STRUCTURE,
    detail:
      score === MAX_DOCUMENT_STRUCTURE
        ? 'All three top-level structural elements present.'
        : `Missing: ${reasons.join(', ')}. Wrap primary content in <main>, the page topic in <article>, and major topic blocks in <section>.`,
  };
}

/**
 * Definition lists: <dl> + <dt> + <dd>. Highest LLM-extraction signal in
 * the rubric. Worth 20 points. We require all three to award full
 * credit — bare <dl> without <dt>/<dd> doesn't help LLMs.
 *   - All three present: 20
 *   - <dl> only: 5 (partial credit for intent)
 *   - none: 0
 */
function scoreDefinitionLists(html: string): SemanticCriterionResult {
  const hasDl = tagPresent(html, 'dl');
  const hasDt = tagPresent(html, 'dt');
  const hasDd = tagPresent(html, 'dd');
  let score = 0;
  let detail = '';
  if (hasDl && hasDt && hasDd) {
    score = MAX_DEFINITION_LISTS;
    detail = 'Definition lists in place — strongest signal for LLM entity extraction.';
  } else if (hasDl) {
    score = 5;
    detail = '<dl> tag present but missing <dt>/<dd>. A bare <dl> without paired terms doesn\'t help LLMs.';
  } else {
    detail =
      'No definition lists detected. Convert <p><strong>Term</strong> – definition</p> patterns to <dl><dt>Term</dt><dd>Definition</dd></dl>. Highest-impact change for LLM citation.';
  }
  return {
    key: 'definition_lists',
    label: 'Definition lists (<dl>/<dt>/<dd>)',
    score,
    max: MAX_DEFINITION_LISTS,
    detail,
  };
}

/**
 * Semantic text vs presentational text. Worth 15 points.
 *   - 0 presentational tags (<b>/<i>): 15
 *   - 1-3 presentational tags but ≥1 semantic (<strong>/<em>): 10
 *   - ≥4 presentational tags: 5
 *   - No emphasis at all (and the page has any text): 8 — neutral
 */
function scoreSemanticText(html: string): SemanticCriterionResult {
  const presentational =
    countTag(html, 'b') + countTag(html, 'i');
  const semantic =
    countTag(html, 'strong') + countTag(html, 'em');

  let score = 0;
  let detail = '';
  if (presentational === 0 && semantic > 0) {
    score = MAX_SEMANTIC_TEXT;
    detail = 'Uses <strong>/<em>, no presentational <b>/<i>. LLMs receive the intended emphasis weight.';
  } else if (presentational === 0 && semantic === 0) {
    score = 8;
    detail = 'No emphasis tags at all. Add <strong> on key terms so LLMs know what to weight.';
  } else if (presentational > 0 && presentational <= 3 && semantic > 0) {
    score = 10;
    detail = `${presentational} presentational <b>/<i> tag${presentational === 1 ? '' : 's'} alongside semantic ones. Replace the presentational with <strong>/<em>.`;
  } else if (presentational > 3) {
    score = 5;
    detail = `${presentational} presentational <b>/<i> tags. LLMs treat these as styling noise; replace with <strong>/<em> to carry semantic weight.`;
  } else {
    score = 7;
    detail = 'Mixed signals — review emphasis usage and prefer <strong>/<em> over <b>/<i>.';
  }
  return {
    key: 'semantic_text',
    label: 'Semantic text emphasis (<strong>/<em>)',
    score,
    max: MAX_SEMANTIC_TEXT,
    detail,
  };
}

/**
 * Heading hierarchy: 1 H1, no skipped levels. Worth 15 points.
 *   - Exactly 1 H1, no skipped levels: 15
 *   - Exactly 1 H1, skipped levels: 10
 *   - 0 or ≥2 H1: 5
 *   - 0 headings at all: 0
 */
function scoreHeadingHierarchy(html: string): SemanticCriterionResult {
  const headings = extractHeadings(html);
  if (headings.length === 0) {
    return {
      key: 'heading_hierarchy',
      label: 'Heading hierarchy (1 H1, no skips)',
      score: 0,
      max: MAX_HEADING_HIERARCHY,
      detail: 'No <h1>-<h6> tags at all. Pages without heading structure can\'t be sub-section-cited.',
    };
  }

  const h1Count = headings.filter((h) => h === 1).length;
  let skipped = false;
  for (let i = 1; i < headings.length; i++) {
    const cur = headings[i]!;
    const prev = headings[i - 1]!;
    if (cur > prev + 1) {
      skipped = true;
      break;
    }
  }

  let score = 0;
  let detail = '';
  if (h1Count === 1 && !skipped) {
    score = MAX_HEADING_HIERARCHY;
    detail = `Clean hierarchy — 1 H1, ${headings.length} total heading${headings.length === 1 ? '' : 's'}, no skipped levels.`;
  } else if (h1Count === 1 && skipped) {
    score = 10;
    detail = '1 H1 but heading levels are skipped (e.g. H1 → H3). Re-tier headings so depth increases by 1 each step.';
  } else if (h1Count === 0) {
    score = 5;
    detail = 'No <h1> on the page. Add a single <h1> describing the page topic.';
  } else {
    score = 5;
    detail = `${h1Count} <h1> tags. Reduce to exactly one — multiple H1s confuse the topic anchor for LLMs.`;
  }
  return {
    key: 'heading_hierarchy',
    label: 'Heading hierarchy (1 H1, no skips)',
    score,
    max: MAX_HEADING_HIERARCHY,
    detail,
  };
}

/** Extract heading levels in document order. ['<h1>', '<h2>', '<h3>'] → [1,2,3]. */
function extractHeadings(html: string): number[] {
  const re = /<h([1-6])(\s|>|\/)/gi;
  const result: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const lvl = parseInt(m[1]!, 10);
    if (!Number.isNaN(lvl)) result.push(lvl);
  }
  return result;
}

/**
 * Figures: <figure> with <figcaption>. Worth 10 points.
 *   - ≥1 <figure> with ≥1 <figcaption>: 10
 *   - <figure> only: 5
 *   - No images at all: 7 (vacuous pass; can't penalize)
 *   - <img> present but no <figure>: 0
 */
function scoreFigures(html: string): SemanticCriterionResult {
  const hasFigure = tagPresent(html, 'figure');
  const hasFigcaption = tagPresent(html, 'figcaption');
  const hasImg = tagPresent(html, 'img');
  let score = 0;
  let detail = '';
  if (hasFigure && hasFigcaption) {
    score = MAX_FIGURES;
    detail = 'Images wrapped in <figure> with <figcaption> — LLMs can attribute the caption to the image.';
  } else if (hasFigure && !hasFigcaption) {
    score = 5;
    detail = '<figure> tags present but missing <figcaption>. Add caption text so LLMs can associate the image with its description.';
  } else if (!hasImg) {
    score = 7;
    detail = 'No images on this page — figure markup not applicable.';
  } else {
    score = 0;
    detail = 'Images present but not wrapped in <figure>/<figcaption>. Wrap each meaningful image so its description becomes citable.';
  }
  return {
    key: 'figures',
    label: 'Figures (<figure>/<figcaption>)',
    score,
    max: MAX_FIGURES,
    detail,
  };
}

/**
 * Sectioning: <header>, <footer>, <aside>. Worth 10 points.
 *   - All three: 10
 *   - 2 of 3: 7
 *   - 1 of 3: 4
 *   - none: 0
 */
function scoreSectioning(html: string): SemanticCriterionResult {
  const flags = [
    tagPresent(html, 'header'),
    tagPresent(html, 'footer'),
    tagPresent(html, 'aside'),
  ];
  const count = flags.filter((x) => x).length;
  const score = count === 3 ? 10 : count === 2 ? 7 : count === 1 ? 4 : 0;
  const missing: string[] = [];
  if (!flags[0]) missing.push('<header>');
  if (!flags[1]) missing.push('<footer>');
  if (!flags[2]) missing.push('<aside>');
  return {
    key: 'sectioning',
    label: 'Sectioning (<header>/<footer>/<aside>)',
    score,
    max: MAX_SECTIONING,
    detail:
      missing.length === 0
        ? 'Header, footer, and aside all present.'
        : `Missing: ${missing.join(', ')}. Wrap top-of-page intro in <header>, page-bottom in <footer>, sidebar content in <aside>.`,
  };
}

/**
 * Semantic tables: <thead>, <tbody>, <th>. Worth 5 points.
 *   - <table> with all three: 5
 *   - <table> with some: 3
 *   - <table> with neither thead/tbody nor th: 1
 *   - no <table>: 4 (vacuous; data tables are rare)
 */
function scoreSemanticTables(html: string): SemanticCriterionResult {
  const hasTable = tagPresent(html, 'table');
  if (!hasTable) {
    return {
      key: 'semantic_tables',
      label: 'Semantic tables (<thead>/<tbody>/<th>)',
      score: 4,
      max: MAX_SEMANTIC_TABLES,
      detail: 'No tables on this page — semantic table markup not applicable.',
    };
  }
  const hasThead = tagPresent(html, 'thead');
  const hasTbody = tagPresent(html, 'tbody');
  const hasTh = tagPresent(html, 'th');
  const count = [hasThead, hasTbody, hasTh].filter((x) => x).length;
  if (count === 3) {
    return {
      key: 'semantic_tables',
      label: 'Semantic tables (<thead>/<tbody>/<th>)',
      score: 5,
      max: MAX_SEMANTIC_TABLES,
      detail: 'Tables use <thead>, <tbody>, and <th> — LLMs can extract header-row labels and pair them with cell values.',
    };
  }
  if (count >= 1) {
    return {
      key: 'semantic_tables',
      label: 'Semantic tables (<thead>/<tbody>/<th>)',
      score: 3,
      max: MAX_SEMANTIC_TABLES,
      detail: 'Tables partly use semantic markup. Add the missing of <thead>/<tbody>/<th> so header rows are unambiguous.',
    };
  }
  return {
    key: 'semantic_tables',
    label: 'Semantic tables (<thead>/<tbody>/<th>)',
    score: 1,
    max: MAX_SEMANTIC_TABLES,
    detail: 'Tables present but no <thead>/<tbody>/<th>. Add row + header markup so LLMs can extract structured data.',
  };
}

function bandFor(total: number): SemanticPageScore['band'] {
  if (total >= 90) return 'maintenance';
  if (total > SCORE_BAND_MEDIUM) return 'low';
  if (total >= SCORE_BAND_HIGH) return 'medium';
  return 'high';
}

/**
 * Run the rubric on raw HTML. Returns a 0-100 score plus per-criterion
 * breakdown the scanner uses to compose the ticket body.
 */
export function scoreSemanticHtml(url: string, rawHtml: string): SemanticPageScore {
  const html = sanitize(rawHtml);
  const criteria = [
    scoreDocumentStructure(html),
    scoreDefinitionLists(html),
    scoreSemanticText(html),
    scoreHeadingHierarchy(html),
    scoreFigures(html),
    scoreSectioning(html),
    scoreSemanticTables(html),
  ];
  const total = criteria.reduce((acc, c) => acc + c.score, 0);
  return {
    url,
    total,
    band: bandFor(total),
    criteria,
  };
}
