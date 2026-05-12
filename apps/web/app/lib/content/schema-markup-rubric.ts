/**
 * Schema Markup Deployment — pure detection + classification.
 *
 * Phase 5 SOP `schema_markup_deployment`. The scanner audits every
 * page's JSON-LD presence, parses it, classifies @type values, and
 * compares against what the page *should* have based on URL +
 * content heuristics.
 *
 * V1 detection rules (each independently surfaced):
 *   1. No JSON-LD on the page at all
 *   2. Malformed JSON-LD (script tag present, JSON.parse throws)
 *   3. Missing Organization-family schema sitewide
 *   4. FAQ-shaped page without FAQPage schema
 *   5. Article-shaped page without Article/BlogPosting schema
 *   6. Non-homepage page without BreadcrumbList
 *
 * Severity bands:
 *   - High: no JSON-LD, or malformed JSON-LD, or missing Organization
 *   - Medium: page type mismatch (FAQ without FAQPage, etc.)
 *   - Low: missing breadcrumbs
 *
 * Pure module. No DB, no fetch. The scanner runs this per page after
 * fetching the HTML.
 */

export type SchemaFindingSeverity = 'high' | 'medium' | 'low';

export type SchemaFindingKey =
  | 'no_jsonld'
  | 'malformed_jsonld'
  | 'missing_organization'
  | 'faq_without_faqpage'
  | 'article_without_article_schema'
  | 'missing_breadcrumb';

export interface SchemaFinding {
  key: SchemaFindingKey;
  severity: SchemaFindingSeverity;
  label: string;
  detail: string;
}

export interface SchemaPageAudit {
  url: string;
  /** Every @type discovered in JSON-LD blocks on this page. */
  detectedTypes: string[];
  /** Page-type guess from URL + content. */
  pageKind: PageKind;
  /** Each finding emits one ticket. */
  findings: SchemaFinding[];
  /** True if the page has at least one parseable JSON-LD block. */
  hasAnySchema: boolean;
  /** True if any JSON-LD block on the page is malformed. */
  hasMalformedSchema: boolean;
}

export type PageKind = 'home' | 'about' | 'article' | 'faq' | 'service' | 'generic';

/**
 * Recursively walk a parsed JSON-LD payload and collect every `@type`
 * value. Schema-org blocks come in many shapes — single object, array,
 * `@graph` of nested entities, mainEntity references — so we treat the
 * whole tree as opaque and just dig.
 */
function collectAtTypes(node: unknown, out: Set<string>): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectAtTypes(item, out);
    return;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const t = obj['@type'];
    if (typeof t === 'string') {
      out.add(t);
    } else if (Array.isArray(t)) {
      for (const v of t) if (typeof v === 'string') out.add(v);
    }
    for (const v of Object.values(obj)) collectAtTypes(v, out);
  }
}

/**
 * Extract every JSON-LD script block from the HTML, parse each, and
 * return the union of all @type values plus a malformed flag.
 */
export function extractJsonLdTypes(html: string): {
  types: string[];
  blocks: number;
  malformed: number;
} {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const found = new Set<string>();
  let blocks = 0;
  let malformed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    blocks += 1;
    const body = m[1]?.trim();
    if (!body) {
      malformed += 1;
      continue;
    }
    try {
      const parsed = JSON.parse(body) as unknown;
      collectAtTypes(parsed, found);
    } catch {
      malformed += 1;
    }
  }
  return { types: [...found], blocks, malformed };
}

/**
 * Classify a page from its URL + simple body signals. The output drives
 * which "expected schemas" are checked.
 *
 * Heuristics in URL-path order so the test is cheap; body fallback
 * detects FAQ pages by counting question-shaped headings.
 */
export function classifyPage(url: string, html: string): PageKind {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    // Malformed URL — treat as generic.
    return 'generic';
  }

  if (path === '/' || path === '') return 'home';
  if (/(^|\/)about(\/|$)/.test(path)) return 'about';
  if (/(^|\/)(faqs?|q-?and-?a|questions)(\/|$)/.test(path)) return 'faq';
  if (/(^|\/)(blog|news|articles?|posts?|insights?|resources?)(\/|$)/.test(path)) return 'article';
  if (/(^|\/)(services?|practice-areas?|solutions?|products?|specialties)(\/|$)/.test(path)) return 'service';

  // Body fallback: count question-shaped headings. 3+ Hx items ending in
  // '?' is a strong FAQ signal even if the URL doesn't say so.
  const questionHeadings = (html.match(/<h[1-6][^>]*>[^<]*\?\s*<\/h[1-6]>/gi) ?? []).length;
  if (questionHeadings >= 3) return 'faq';

  return 'generic';
}

/**
 * Does the detected-types list contain any Organization-family type?
 * Organization itself plus the major subtypes Google's structured-data
 * docs recognize as substitutes.
 */
function hasOrganizationType(types: readonly string[]): boolean {
  const set = new Set(types.map((t) => t.toLowerCase()));
  return [
    'organization',
    'localbusiness',
    'corporation',
    'legalservice',
    'attorney',
    'medicalbusiness',
    'medicalclinic',
    'dentist',
    'professionalservice',
    'restaurant',
    'store',
    'foodestablishment',
  ].some((t) => set.has(t));
}

function hasArticleType(types: readonly string[]): boolean {
  const set = new Set(types.map((t) => t.toLowerCase()));
  return ['article', 'blogposting', 'newsarticle', 'techarticle', 'scholarlyarticle'].some(
    (t) => set.has(t),
  );
}

function hasFaqPageType(types: readonly string[]): boolean {
  const set = new Set(types.map((t) => t.toLowerCase()));
  return set.has('faqpage') || set.has('qapage');
}

function hasBreadcrumbType(types: readonly string[]): boolean {
  return types.some((t) => t.toLowerCase() === 'breadcrumblist');
}

/**
 * Run the V1 detection rules against the parsed JSON-LD + page kind.
 * Returns the list of findings — each one maps 1:1 to a remediation
 * ticket the scanner emits.
 */
export function auditPageSchema(url: string, html: string): SchemaPageAudit {
  const { types, blocks, malformed } = extractJsonLdTypes(html);
  const pageKind = classifyPage(url, html);
  const findings: SchemaFinding[] = [];
  const hasAnySchema = blocks > 0 && malformed < blocks; // at least one parseable block
  const hasMalformedSchema = malformed > 0;

  if (blocks === 0) {
    findings.push({
      key: 'no_jsonld',
      severity: 'high',
      label: 'No JSON-LD schema on this page',
      detail:
        'No <script type="application/ld+json"> blocks were detected. Add at minimum Organization (or LocalBusiness/Attorney/MedicalBusiness as appropriate) and the page-type schema (WebPage / Article / FAQPage).',
    });
  } else if (malformed > 0) {
    findings.push({
      key: 'malformed_jsonld',
      severity: 'high',
      label: `${malformed} malformed JSON-LD block${malformed === 1 ? '' : 's'}`,
      detail:
        'JSON.parse failed on one or more JSON-LD scripts on this page. Broken schema is worse than missing schema — LLMs and Google silently ignore the block. Validate at https://search.google.com/test/rich-results.',
    });
  }

  if (blocks > 0 && !hasOrganizationType(types)) {
    findings.push({
      key: 'missing_organization',
      severity: 'high',
      label: 'Missing Organization-family schema',
      detail:
        'Schema is present but no Organization, LocalBusiness, Attorney, Dentist, MedicalBusiness, or related entity type appears in @type. Add an Organization block at the site level so every page inherits a verified entity anchor.',
    });
  }

  if (pageKind === 'faq' && !hasFaqPageType(types)) {
    findings.push({
      key: 'faq_without_faqpage',
      severity: 'medium',
      label: 'FAQ-shaped page without FAQPage schema',
      detail:
        'Page contains Q&A markup (URL path or ≥3 question-shaped headings) but no FAQPage schema. FAQPage is the highest-yield schema for LLM extraction — add it.',
    });
  }

  if (pageKind === 'article' && !hasArticleType(types)) {
    findings.push({
      key: 'article_without_article_schema',
      severity: 'medium',
      label: 'Article-shaped page without Article/BlogPosting schema',
      detail:
        'URL path indicates a blog/article/news page but no Article, BlogPosting, NewsArticle, or related schema is present. Add Article with author, datePublished, dateModified, and headline.',
    });
  }

  if (pageKind !== 'home' && !hasBreadcrumbType(types)) {
    findings.push({
      key: 'missing_breadcrumb',
      severity: 'low',
      label: 'Missing BreadcrumbList schema',
      detail:
        'BreadcrumbList helps Google + LLMs locate the page in your site\'s hierarchy. Add it on every non-homepage page so the path to the entity is unambiguous.',
    });
  }

  return {
    url,
    detectedTypes: types,
    pageKind,
    findings,
    hasAnySchema,
    hasMalformedSchema,
  };
}

/** Rank pages by the highest-severity finding they carry, then by # findings. */
export function compareAuditsBySeverity(a: SchemaPageAudit, b: SchemaPageAudit): number {
  const aMax = severityRank(a);
  const bMax = severityRank(b);
  if (aMax !== bMax) return bMax - aMax; // higher rank first
  return b.findings.length - a.findings.length;
}

function severityRank(a: SchemaPageAudit): number {
  if (a.findings.some((f) => f.severity === 'high')) return 3;
  if (a.findings.some((f) => f.severity === 'medium')) return 2;
  if (a.findings.some((f) => f.severity === 'low')) return 1;
  return 0;
}
