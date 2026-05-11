/**
 * Brand Truth bootstrap — synthesize a Brand Truth v1 from the firm's
 * public website + JSON-LD + page content.
 *
 * Design doc: docs/design-brand-truth-bootstrap.md
 *
 * One Claude Sonnet 4.5 call with ~20k tokens of scraped context. The
 * caller (server action) is responsible for persisting the result as
 * `brand_truth_version` v1 — this module is pure synthesis, no DB writes.
 *
 * Output is Zod-validated against `brandTruthSchema` before return — the
 * caller never sees an invalid payload.
 *
 * Reuses existing modules:
 *   - `lib/suppression/crawler.ts`  → sitemap discovery
 *   - `lib/suppression/extract.ts`  → readability-style content extraction
 *   - `lib/entity/schema-scan.ts`   → JSON-LD parsing
 */

import Anthropic from '@anthropic-ai/sdk';
import { brandTruthSchema, type BrandTruth, type FirmType } from '@ai-edge/shared';
import { crawlViaSitemap } from '../suppression/crawler';
import { fetchAndExtract } from '../suppression/extract';
import { scanJsonLd } from '../entity/schema-scan';
import { calculateCost, extractUsage } from '../audit/pricing';

export const BOOTSTRAP_MODEL = 'claude-sonnet-4-20250514';

// How much page content the LLM sees per URL. ~3000 chars × 8 pages ≈ 6k
// tokens of page bodies, leaving plenty of room in Claude's 200k window
// for the JSON-LD dump + schema description + output budget.
const PAGE_CONTENT_CHARS_PER_URL = 3000;

// Pages to feed the model in priority order. Anything matching one of these
// patterns gets bumped to the front; unmatched URLs fall to the back.
// Limited to ~8 final URLs to keep input tokens predictable.
const KEY_PATH_PATTERNS: { pattern: RegExp; weight: number }[] = [
  { pattern: /^\/?$/, weight: 100 }, // homepage
  { pattern: /^\/about(\/|$)/i, weight: 90 },
  { pattern: /^\/(our-)?(team|attorneys|providers|staff|people)(\/|$)/i, weight: 85 },
  { pattern: /^\/(services|practice-areas?)(\/|$)/i, weight: 80 },
  { pattern: /^\/locations(\/|$)/i, weight: 75 },
  { pattern: /^\/(areas|service-areas?)(\/|$)/i, weight: 75 },
  { pattern: /^\/why-us(\/|$)/i, weight: 70 },
  { pattern: /^\/contact(\/|$)/i, weight: 60 },
];

const DEFAULT_MAX_PAGES = 8;

export interface BootstrapInput {
  firmName: string;
  firmType: FirmType;
  primaryUrl: string;
  /** Override the crawl size cap. */
  maxPages?: number;
}

export interface BootstrapProvenance {
  pagesScanned: number;
  pagesUsed: string[];
  jsonLdTypesDetected: string[];
  modelUsed: string;
  promptCharCount: number;
  outputCharCount: number;
}

export interface BootstrapSuccess {
  ok: true;
  payload: BrandTruth;
  provenance: BootstrapProvenance;
  costUsd: number;
  latencyMs: number;
}

export interface BootstrapFailure {
  ok: false;
  reason: string;
  // Best-effort diagnostics on failure paths so the caller can render a
  // useful UI error and we have something to debug from server logs.
  pagesScanned?: number;
  pagesUsed?: string[];
  rawModelOutput?: string;
}

export type BootstrapResult = BootstrapSuccess | BootstrapFailure;

interface ScrapedPage {
  url: string;
  title: string | null;
  content: string;
  wordCount: number;
}

/**
 * Synthesize a Brand Truth payload from the firm's public site.
 *
 * Never throws on expected failure paths (crawl-empty, fetch-failed,
 * model returned junk, Zod mismatch) — returns a `BootstrapFailure` with
 * a `reason` the caller can show the operator. Only throws on configuration
 * errors (missing ANTHROPIC_API_KEY) and unexpected runtime exceptions.
 */
export async function bootstrapBrandTruthFromUrl(
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const { firmName, firmType, primaryUrl } = input;
  const maxPages = Math.max(1, Math.min(15, input.maxPages ?? DEFAULT_MAX_PAGES));

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY not set — Brand Truth bootstrap requires Claude access.',
    );
  }

  // 1. Crawl. If the sitemap is missing or returns 0 URLs, fall back to
  // just the primary URL — better to bootstrap from the homepage alone
  // than to fail completely.
  let candidateUrls: string[] = [];
  try {
    const crawl = await crawlViaSitemap({ firmSiteUrl: primaryUrl, maxUrls: 50 });
    candidateUrls = crawl.urls;
  } catch {
    // Swallow — handled by fallback below.
  }
  if (candidateUrls.length === 0) {
    candidateUrls = [primaryUrl];
  }

  // 2. Always include the primary URL at the head of the candidate list —
  // some sitemaps (e.g. reimerhvac.com) list only blog posts and not the
  // homepage; without this injection we'd never feed the model the most
  // information-dense page on the site.
  //
  // Then rank by KEY_PATH_PATTERNS and take the top maxPages.
  const candidateSet = new Set<string>([primaryUrl, ...candidateUrls]);
  const prioritized = rankByPathWeight(Array.from(candidateSet), primaryUrl).slice(
    0,
    maxPages,
  );

  // 3. Fetch + extract main content for each ranked URL. Sequential to be
  // polite (same as suppression scan). Pages that fail are silently
  // dropped — we'll work with whatever extracts cleanly.
  const pages: ScrapedPage[] = [];
  for (const url of prioritized) {
    try {
      const extracted = await fetchAndExtract(url);
      // Drop pages with < 50 words — those are nav-only / thank-you /
      // 404 pages that won't help the model.
      if (extracted.wordCount < 50) continue;
      pages.push({
        url: extracted.url,
        title: extracted.title,
        content: extracted.mainContent.slice(0, PAGE_CONTENT_CHARS_PER_URL),
        wordCount: extracted.wordCount,
      });
    } catch {
      // Drop and continue — bad URL, fetch error, content-type mismatch.
    }
  }

  if (pages.length === 0) {
    return {
      ok: false,
      reason: 'no_extractable_content',
      pagesScanned: prioritized.length,
      pagesUsed: prioritized,
    };
  }

  // 4. JSON-LD scan against the homepage. The homepage usually has the
  // canonical Organization / LocalBusiness block; sub-pages often don't.
  let jsonLdBlocks: Array<{ type: string; raw: unknown }> = [];
  let jsonLdTypesDetected: string[] = [];
  try {
    const jsonLd = await scanJsonLd(primaryUrl);
    jsonLdBlocks = jsonLd.blocks;
    jsonLdTypesDetected = jsonLd.typesFound;
  } catch {
    // Non-fatal — model just gets fewer structured signals.
  }

  // 5. Build prompt + call Claude.
  const prompt = buildBootstrapPrompt({
    firmName,
    firmType,
    primaryUrl,
    pages,
    jsonLdBlocks,
  });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const t0 = Date.now();
  const response = await client.messages.create({
    model: BOOTSTRAP_MODEL,
    max_tokens: 8000,
    temperature: 0,
    system: BOOTSTRAP_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });
  const latencyMs = Date.now() - t0;

  const rawOutput = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  // 6. Parse JSON out of the response. Preferred form is ```json ...```
  // but accept a bare JSON object as a fallback.
  const parsed = extractJsonObject(rawOutput);
  if (!parsed) {
    return {
      ok: false,
      reason: 'model_returned_non_json',
      pagesScanned: pages.length,
      pagesUsed: pages.map((p) => p.url),
      rawModelOutput: rawOutput.slice(0, 2000),
    };
  }

  // 7. Zod-validate against the discriminated-union schema. Force the
  // firm_type to match the input — even if the model wrote a different
  // type, we don't honor it (the operator's choice on the new-client form
  // is canonical).
  const candidate = { ...parsed, firm_type: firmType };
  const validation = brandTruthSchema.safeParse(candidate);
  if (!validation.success) {
    return {
      ok: false,
      reason: `schema_validation_failed: ${validation.error.message.slice(0, 500)}`,
      pagesScanned: pages.length,
      pagesUsed: pages.map((p) => p.url),
      rawModelOutput: rawOutput.slice(0, 2000),
    };
  }

  // 8. Cost.
  const usage = extractUsage(response);
  const costUsd = calculateCost('anthropic', response.model, usage);

  return {
    ok: true,
    payload: validation.data,
    provenance: {
      pagesScanned: pages.length,
      pagesUsed: pages.map((p) => p.url),
      jsonLdTypesDetected,
      modelUsed: response.model,
      promptCharCount: prompt.length,
      outputCharCount: rawOutput.length,
    },
    costUsd,
    latencyMs,
  };
}

// ── helpers ───────────────────────────────────────────────────────────

function rankByPathWeight(urls: string[], primaryUrl: string): string[] {
  const baseHost = safeHost(primaryUrl);
  const scored = urls
    .filter((u) => {
      // Restrict to same-host URLs — sitemaps sometimes leak external
      // links, and we don't want to feed the model competitor pages.
      const h = safeHost(u);
      return !baseHost || h === baseHost;
    })
    .map((u) => {
      const path = safePathname(u);
      const match = KEY_PATH_PATTERNS.find((p) => p.pattern.test(path));
      return { url: u, weight: match?.weight ?? 0 };
    });
  scored.sort((a, b) => b.weight - a.weight);
  return scored.map((s) => s.url);
}

function safeHost(u: string): string {
  try {
    return new URL(u).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function safePathname(u: string): string {
  try {
    return new URL(u).pathname || '/';
  } catch {
    return '/';
  }
}

/**
 * Extract the first JSON object from a model response. Preferred form is
 * inside a ```json fence; falls back to the first balanced `{...}` block.
 * Returns the parsed object or `null` if nothing extracts.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  // Try fenced first — most reliable.
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced && fenced[1]) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to brace-balanced fallback
    }
  }

  // Brace-balanced fallback — find the first '{' and walk until matched.
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ── prompt ────────────────────────────────────────────────────────────

const BOOTSTRAP_SYSTEM_PROMPT = `You are a brand-truth synthesizer for the Clixsy Intercept AEO platform.

Your job: given a firm's public website content + any structured data (JSON-LD), produce a Brand Truth JSON payload that scoring downstream uses to evaluate how well LLMs describe this firm.

The Brand Truth has to be EVIDENCE-BACKED. Don't invent facts the source material doesn't support. If a field can't be derived from the input, omit it or leave it as an empty array — the operator will fill it in.

NEVER invent banned_claims. Always return banned_claims as an empty array; the operator owns this based on jurisdictional rules.

NEVER invent awards the firm hasn't claimed on their own site.

Output ONLY a valid JSON object inside a single \`\`\`json fence. No prose before or after. No commentary. The operator's tool will JSON.parse() your response.`;

interface PromptArgs {
  firmName: string;
  firmType: FirmType;
  primaryUrl: string;
  pages: ScrapedPage[];
  jsonLdBlocks: Array<{ type: string; raw: unknown }>;
}

function buildBootstrapPrompt(args: PromptArgs): string {
  const { firmName, firmType, primaryUrl, pages, jsonLdBlocks } = args;

  const schemaSection = schemaDescriptionFor(firmType);

  const jsonLdSection = jsonLdBlocks.length > 0
    ? jsonLdBlocks
        .slice(0, 15)
        .map(
          (b, i) =>
            `--- JSON-LD block ${i + 1} (type=${b.type}) ---\n${JSON.stringify(b.raw, null, 2).slice(0, 4000)}`,
        )
        .join('\n\n')
    : '(no structured data found on the homepage)';

  const pagesSection = pages
    .map(
      (p, i) =>
        `--- PAGE ${i + 1}: ${p.url} (${p.wordCount} words) ---\nTITLE: ${p.title ?? '(none)'}\n\n${p.content}`,
    )
    .join('\n\n');

  return `Synthesize a Brand Truth payload for the following firm.

FIRM:
  name: ${firmName}
  firm_type: ${firmType}
  primary_url: ${primaryUrl}

BRAND TRUTH SCHEMA (firm_type='${firmType}' variant):
${schemaSection}

STRUCTURED DATA EXTRACTED FROM HOMEPAGE JSON-LD:
${jsonLdSection}

PAGES SCRAPED FROM THE FIRM'S WEBSITE:
${pagesSection}

REQUIREMENTS:
1. Output a JSON object matching the firm_type='${firmType}' variant of the schema.
2. The output MUST include "firm_type": "${firmType}" exactly.
3. Set primary_url to "${primaryUrl}".
4. Set firm_name to "${firmName}".
5. For every field, populate from the evidence above. If a field can't be derived, omit it (for optional fields) or use an empty array/object (for required-but-empty defaults).
6. seed_query_intents: generate 15-20 realistic queries a prospect might type into an LLM. Mix:
     • Brand queries: "${firmName} reviews", "is ${firmName} legit", "${firmName} pricing", "should I hire ${firmName}"
     • Intent queries combining services + locations the firm serves
     • Comparative queries: "${firmName} vs [other firm]" (only if a competitor is named in the source material)
7. required_positioning_phrases: 2-3 short phrases (≤12 words each) derived from the firm's hero/value-prop copy. The kind of phrase that, if absent from an LLM's description of the firm, signals the LLM is off-brand.
8. unique_differentiators: 3-5 specific things the firm claims set them apart, in the firm's own words where possible.
9. tone_guidelines.voice: one short phrase (≤20 words) capturing the firm's voice as it reads in the scraped copy. Examples: "warm, neighborly, plainspoken — emphasizes longevity and trust" or "confident, results-focused, no hedging".
10. tone_guidelines.avoid: 2-3 things the firm's copy clearly does NOT do.
11. banned_claims: return as an empty array — the operator owns this.
12. compliance_jurisdictions: return as an empty array — the operator owns this.

OUTPUT (raw JSON, inside one \`\`\`json fence, nothing else):`;
}

/**
 * Per-firm-type schema description fed to the model. We intentionally do
 * NOT inline the entire Zod schema — the model gets confused by Zod's
 * internal types. Instead we describe the relevant variant in plain
 * TypeScript with comments about what each field means.
 *
 * Keep these in sync with the brandTruthSchema variants in
 * packages/shared/src/brand-truth.ts.
 */
function schemaDescriptionFor(firmType: FirmType): string {
  const sharedFields = `
  firm_name: string                              // canonical name
  primary_url: string (URL)                      // canonical homepage
  name_variants: string[]                        // alternate forms, abbreviations, "DBA" names
  common_misspellings: string[]                  // typos LLMs commonly produce
  legal_entity?: string                          // legal entity name if different from firm_name
  headquarters?: {                               // primary office
    street?: string
    city: string
    region?: string
    postal_code?: string
    country: string (2-letter ISO)
    phone?: string
    email?: string
  }
  unique_differentiators: string[]               // 3-5 specific things the firm claims sets them apart
  required_positioning_phrases: string[]         // phrases that should appear in good LLM descriptions
  banned_claims: []                              // ALWAYS empty array — operator owns this
  awards: Array<{                                // only awards visible on the firm's own site
    name: string
    year?: number
    source_url?: string (URL)
  }>
  tone_guidelines?: {
    voice: string                                // 1-line description of voice
    register?: string                            // e.g. "professional but approachable"
    avoid: string[]                              // anti-patterns
  }
  target_audience?: {
    primary_verticals: string[]                  // who the firm primarily serves
    firmographic?: string                        // free-form description
    persona?: string                             // free-form description
  }
  brand_values: string[]
  compliance_jurisdictions: []                   // ALWAYS empty array — operator owns this
  seed_query_intents: string[]                   // 15-20 queries (see requirement 6)
  competitors_for_llm_monitoring: string[]       // names of competitors mentioned in the source material; otherwise empty
  known_press_and_media: Array<{
    outlet: string
    title: string
    url: string (URL)
    date?: string
  }>
  third_party_listings: Array<{
    source: string                               // e.g. "bbb", "yelp", "google_business_profile"
    url: string (URL)
  }>`;

  switch (firmType) {
    case 'law_firm':
      return `{
  firm_type: "law_firm"
${sharedFields}
  practice_areas: string[]                       // min 1 — e.g. "personal injury", "family law"
  geographies_served: Array<{                    // min 1
    city: string
    state: string (2-3 letters)
    country: string (default "US")
    radius_mi: number (positive integer)
  }>
  attorney_bios: Array<{
    name: string
    role?: string                                // "Founding Partner", "Associate", etc.
    credentials: string[]                        // "JD, Harvard Law", "Member, NY State Bar"
    bio?: string
    bar_number?: string
  }>
  notable_cases: Array<{
    summary: string
    outcome?: string
    jurisdiction?: string
    source_url?: string (URL)
  }>
}`;

    case 'dental_practice':
      return `{
  firm_type: "dental_practice"
${sharedFields}
  practice_areas: string[]                       // min 1 — e.g. "general dentistry", "cosmetic dentistry", "implants"
  geographies_served: Array<{                    // min 1
    city: string
    state: string (2-3 letters)
    country: string (default "US")
    radius_mi: number (positive integer)
  }>
  provider_bios: Array<{
    name: string
    role?: string                                // "DDS, Owner", "Hygienist", etc.
    credentials: string[]                        // "DDS, NYU College of Dentistry"
    bio?: string
    license_number?: string
  }>
}`;

    case 'marketing_agency':
      return `{
  firm_type: "marketing_agency"
${sharedFields}
  service_offerings: Array<{                     // min 1
    name: string
    scope: string
  }>
  service_areas: string[]                        // min 1 — cities, regions, "remote/national"
  team_members: Array<{
    name: string
    role?: string
    credentials: string[]
    bio?: string
  }>
  key_clients_public: Array<{
    name: string
    vertical?: string
    location?: string
    testimonial_quote?: string
    attribution?: string
    source_url?: string (URL)
    ftc_material_connection_disclosed: boolean (default false)
  }>
}`;

    case 'other':
    default:
      return `{
  firm_type: "other"
${sharedFields}
  service_offerings: Array<{
    name: string
    scope: string
  }>
  service_areas: string[]                        // cities, regions, or "national"
  custom_fields: object (key-value)              // anything firm-specific not captured by the schema
}`;
  }
}
