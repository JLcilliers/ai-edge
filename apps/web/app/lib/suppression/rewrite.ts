import Anthropic from '@anthropic-ai/sdk';
import type { BrandTruth } from '@ai-edge/shared';
import {
  getDb,
  pages,
  legacyFindings,
  legacyRewriteDrafts,
  brandTruthVersions,
} from '@ai-edge/db';
import { eq, desc } from 'drizzle-orm';
import { calculateCost, extractUsage } from '../audit/pricing';

/**
 * AI-assisted rewrite generator for legacy-suppression findings (PLAN §5.3).
 *
 * Given a `legacy_finding_id`, this:
 *   1. Loads the flagged page + its extracted main content.
 *   2. Loads the current Brand Truth (latest version) for the firm.
 *   3. Asks Claude Sonnet 4 for a rewrite that:
 *        - preserves on-page entities (names, credentials, phone, address),
 *        - fixes positioning so the page actually reflects the Brand Truth,
 *        - never uses anything in `banned_claims`.
 *   4. Parses the model's structured JSON response.
 *   5. Upserts a `legacy_rewrite_draft` row (one draft per finding).
 *
 * Design choices:
 *   - Claude (long-context) over GPT-4.1: we sometimes feed it 20k-char
 *     pages, and Sonnet 4's context window + positioning-writing quality
 *     are the right trade-off. JSON mode via the explicit
 *     "Respond ONLY with JSON matching this schema" instruction — Anthropic
 *     honors this in practice at temperature 0.
 *   - Temperature 0: deterministic generations so regeneration of the same
 *     finding produces the same output until the Brand Truth or page changes.
 *   - The model is told to put the title and body in clearly-named JSON
 *     fields; we do a lenient parse and fall back to raising an error so
 *     the operator can retry rather than silently persisting garbage.
 *   - Upsert by `legacy_finding_id` via the unique index — regeneration
 *     replaces the current draft in place (schema §5.3 comment).
 */

export const REWRITE_MODEL = 'claude-sonnet-4-20250514';
const MAX_OUTPUT_TOKENS = 4096;
// Cap on the page content we feed the model. Claude Sonnet 4 has a 200k
// context, but we rarely need more than ~8k chars of the flagged page —
// the Brand Truth block is already the bulk of the useful context.
const MAX_PAGE_CHARS = 12_000;
// Excerpt we snapshot alongside the draft for stable diff rendering.
const CURRENT_EXCERPT_MAX_CHARS = 600;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/** Structured shape the model is instructed to return. */
export interface RewriteDraftResponse {
  proposed_title: string;
  proposed_body: string;
  change_summary: string;
  entities_preserved: string[];
  positioning_fixes: string[];
  banned_claims_avoided: string[];
}

export interface GeneratedRewriteDraft extends RewriteDraftResponse {
  draftId: string;
  model: string;
  costUsd: number;
  brandTruthVersionId: string;
}

/**
 * Build the rubric prompt. We deliberately dump the full BrandTruth JSON —
 * the model is better at respecting structured constraints when it can see
 * the fields it's being asked about rather than a human paraphrase.
 */
function buildRewritePrompt(args: {
  brandTruth: BrandTruth;
  pageUrl: string;
  pageTitle: string | null;
  pageContent: string;
  distance: number;
  action: string;
  rationale: string | null;
}): string {
  const { brandTruth, pageUrl, pageTitle, pageContent, distance, action, rationale } = args;
  return `You are rewriting a page on a professional-services firm's own website so that AI answer engines (ChatGPT, Perplexity, Google AI Overviews) describe this firm the way its current Brand Truth says it should be described.

The Brand Truth is the firm's source of truth for positioning, voice, and compliance constraints. Your output must be aligned with it.

<brand_truth>
${JSON.stringify(brandTruth, null, 2)}
</brand_truth>

<legacy_page>
URL: ${pageUrl}
Title: ${pageTitle ?? '(no title)'}
Semantic distance from Brand Truth: ${distance.toFixed(3)}
Recommended action: ${action}
Rationale: ${rationale ?? '(none)'}

Main content (verbatim, up to ${MAX_PAGE_CHARS} chars):
${pageContent.slice(0, MAX_PAGE_CHARS)}
</legacy_page>

Your rewrite MUST:
1. Preserve every concrete on-page entity: person names, credentials/licenses, phone numbers, physical addresses, email addresses, award names, press citations, case/matter names. If an entity appears in the legacy page, it must appear verbatim in your rewrite (unless it contradicts a banned_claim — in which case drop it and note this in banned_claims_avoided).
2. Use the tone, voice, and register from brand_truth.tone_guidelines. Avoid anything in tone_guidelines.avoid.
3. Work in at least one phrase from brand_truth.required_positioning_phrases where it reads naturally. Do not force-fit; if none fit, say so in positioning_fixes.
4. Never use any of the claims in brand_truth.banned_claims. If the legacy page uses one, silently drop it and note the removal in banned_claims_avoided.
5. Match the structure expected for this firm_type: e.g., a law_firm practice-area page should stay a practice-area page, not become a generic "About Us".
6. Stay under roughly the same length as the original (±25%) — the goal is a drop-in replacement, not a new page.
7. Output HTML-safe plain text (no raw HTML tags). Paragraphs separated by blank lines.

Respond with ONLY a single JSON object, no prose before or after, matching this exact schema:
{
  "proposed_title": string,
  "proposed_body": string,
  "change_summary": string,
  "entities_preserved": string[],
  "positioning_fixes": string[],
  "banned_claims_avoided": string[]
}

- proposed_title: the new <title>/H1 for the page (plain text, under 80 chars).
- proposed_body: the new main-content body as plain text with paragraph breaks.
- change_summary: 2-3 sentence plain-English description of what changed and why, aimed at the marketing ops person who will approve this.
- entities_preserved: every concrete entity from the legacy page that you carried through verbatim.
- positioning_fixes: bullet-level description of how the rewrite reflects Brand Truth positioning that the legacy page did not.
- banned_claims_avoided: specific banned_claim.claim strings you actively dropped or rewrote around; empty array if none were present.`;
}

/**
 * Tolerant JSON extraction — the model is told to return pure JSON, but if
 * it wraps in ```json``` or drops a trailing period we'd rather retry the
 * parse than fail the whole generation.
 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // Strip ```json fences if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced ? fenced[1]! : trimmed;
  return JSON.parse(body);
}

function validateDraft(parsed: unknown): RewriteDraftResponse {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Rewrite response was not an object');
  }
  const p = parsed as Record<string, unknown>;
  const str = (k: string): string => {
    if (typeof p[k] !== 'string' || !(p[k] as string).trim()) {
      throw new Error(`Rewrite response missing required string field: ${k}`);
    }
    return p[k] as string;
  };
  const strArr = (k: string): string[] => {
    if (!Array.isArray(p[k])) return [];
    return (p[k] as unknown[]).filter((v): v is string => typeof v === 'string');
  };
  return {
    proposed_title: str('proposed_title'),
    proposed_body: str('proposed_body'),
    change_summary: typeof p.change_summary === 'string' ? p.change_summary : '',
    entities_preserved: strArr('entities_preserved'),
    positioning_fixes: strArr('positioning_fixes'),
    banned_claims_avoided: strArr('banned_claims_avoided'),
  };
}

/**
 * Load the finding joined with its page and the firm's latest Brand Truth.
 * Throws if any piece is missing — generation has no reasonable default if
 * any of them is absent.
 */
async function loadContext(findingId: string) {
  const db = getDb();

  const [finding] = await db
    .select({
      id: legacyFindings.id,
      page_id: legacyFindings.page_id,
      semantic_distance: legacyFindings.semantic_distance,
      action: legacyFindings.action,
      rationale: legacyFindings.rationale,
    })
    .from(legacyFindings)
    .where(eq(legacyFindings.id, findingId))
    .limit(1);
  if (!finding) throw new Error(`Legacy finding not found: ${findingId}`);

  const [page] = await db
    .select({
      id: pages.id,
      firm_id: pages.firm_id,
      url: pages.url,
      title: pages.title,
      main_content: pages.main_content,
    })
    .from(pages)
    .where(eq(pages.id, finding.page_id))
    .limit(1);
  if (!page) throw new Error(`Page for finding not found: ${finding.page_id}`);
  if (!page.main_content || !page.main_content.trim()) {
    throw new Error('Page has no extracted main content — re-run the suppression scan');
  }

  const [btv] = await db
    .select({
      id: brandTruthVersions.id,
      payload: brandTruthVersions.payload,
    })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, page.firm_id))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  if (!btv) throw new Error('Firm has no Brand Truth — create one before generating rewrites');

  return { finding, page, brandTruthVersion: btv };
}

/**
 * Generate a rewrite draft and upsert it. Returns the fully-hydrated draft.
 * Safe to call repeatedly — each call replaces the draft in place.
 */
export async function generateRewriteDraftForFinding(
  findingId: string,
): Promise<GeneratedRewriteDraft> {
  const db = getDb();
  const { finding, page, brandTruthVersion } = await loadContext(findingId);

  const prompt = buildRewritePrompt({
    brandTruth: brandTruthVersion.payload,
    pageUrl: page.url,
    pageTitle: page.title,
    pageContent: page.main_content!,
    distance: finding.semantic_distance,
    action: finding.action,
    rationale: finding.rationale,
  });

  const client = getClient();
  const response = await client.messages.create({
    model: REWRITE_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (!text) throw new Error('Rewrite model returned no text');

  let parsed: RewriteDraftResponse;
  try {
    parsed = validateDraft(extractJson(text));
  } catch (err) {
    // Surface the first 300 chars of the model output so the operator can
    // tell if it refused, babbled, or returned structurally-bad JSON.
    throw new Error(
      `Rewrite parse failed (${String(err)}); model output started: ${text.slice(0, 300)}…`,
    );
  }

  const usage = extractUsage(response);
  const costUsd = calculateCost('anthropic', response.model, usage);

  const currentExcerpt =
    page.main_content!.length > CURRENT_EXCERPT_MAX_CHARS
      ? page.main_content!.slice(0, CURRENT_EXCERPT_MAX_CHARS).trim() + '…'
      : page.main_content!.trim();

  const values = {
    legacy_finding_id: findingId,
    brand_truth_version_id: brandTruthVersion.id,
    current_title: page.title ?? null,
    current_excerpt: currentExcerpt,
    proposed_title: parsed.proposed_title,
    proposed_body: parsed.proposed_body,
    change_summary: parsed.change_summary || null,
    entities_preserved: parsed.entities_preserved,
    positioning_fixes: parsed.positioning_fixes,
    banned_claims_avoided: parsed.banned_claims_avoided,
    generated_by_model: response.model,
    cost_usd: costUsd,
    status: 'draft' as const,
    generated_at: new Date(),
    reviewed_at: null,
  };

  const [row] = await db
    .insert(legacyRewriteDrafts)
    .values(values)
    .onConflictDoUpdate({
      target: legacyRewriteDrafts.legacy_finding_id,
      set: {
        brand_truth_version_id: values.brand_truth_version_id,
        current_title: values.current_title,
        current_excerpt: values.current_excerpt,
        proposed_title: values.proposed_title,
        proposed_body: values.proposed_body,
        change_summary: values.change_summary,
        entities_preserved: values.entities_preserved,
        positioning_fixes: values.positioning_fixes,
        banned_claims_avoided: values.banned_claims_avoided,
        generated_by_model: values.generated_by_model,
        cost_usd: values.cost_usd,
        status: 'draft',
        generated_at: values.generated_at,
        reviewed_at: null,
      },
    })
    .returning({ id: legacyRewriteDrafts.id });

  return {
    draftId: row!.id,
    model: response.model,
    costUsd,
    brandTruthVersionId: brandTruthVersion.id,
    ...parsed,
  };
}
