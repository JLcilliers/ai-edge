import OpenAI from 'openai';
import type { BrandTruth } from '@ai-edge/shared';

/**
 * Embedding + cosine-similarity helpers for the suppression scan.
 *
 * Uses OpenAI's `text-embedding-3-large` (3072 dims) per PLAN §5.3. Batches
 * up to 100 inputs per request — OpenAI's limit is higher but 100 keeps
 * per-request latency reasonable.
 */

const MODEL = 'text-embedding-3-large';
const BATCH_SIZE = 100;

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

/**
 * Flatten a BrandTruth payload into a single string for embedding. The
 * "centroid" in PLAN §5.3 is: embed the Brand Truth once, treat that as
 * the target vector, and measure each page's cosine distance from it.
 *
 * Centroid breadth matters more than precision. text-embedding-3-large
 * spreads similarity over a wide cosine range, so a thin centroid (just
 * firm name + a 3-word practice area list) makes *every* page on the
 * site look semantically distant — even pages that are clearly on-brand.
 *
 * We use every descriptive field in the discriminated union — the
 * fields here must match `brandTruthSchema` in
 * `packages/shared/src/brand-truth.ts`, NOT a guessed/legacy shape.
 * Provider bios, notable cases, and service-offering scopes are the
 * richest descriptive vocabulary the firm has, so we include their
 * full body text — those bodies are what an aligned page reads like.
 *
 * Operational metadata (compliance_jurisdictions, banned_claims,
 * common_misspellings) is intentionally excluded — it doesn't describe
 * content, so including it would dilute the centroid.
 */
export function brandTruthToText(brandTruth: BrandTruth): string {
  const parts: string[] = [];

  // Identity — every firm type has these.
  parts.push(`Firm: ${brandTruth.firm_name}`);
  if (brandTruth.name_variants?.length) {
    parts.push(`Also known as: ${brandTruth.name_variants.join(', ')}`);
  }
  if (brandTruth.legal_entity) {
    parts.push(`Legal entity: ${brandTruth.legal_entity}`);
  }

  // Positioning markers.
  if (brandTruth.required_positioning_phrases?.length) {
    parts.push(
      `Positioning phrases: ${brandTruth.required_positioning_phrases.join('. ')}`,
    );
  }
  if (brandTruth.unique_differentiators?.length) {
    parts.push(
      `Differentiators: ${brandTruth.unique_differentiators.join('. ')}`,
    );
  }
  if (brandTruth.brand_values?.length) {
    parts.push(`Brand values: ${brandTruth.brand_values.join(', ')}`);
  }

  // Tone — `tone_guidelines.voice` is the actual prose, not a single word.
  if (brandTruth.tone_guidelines?.voice) {
    parts.push(`Tone of voice: ${brandTruth.tone_guidelines.voice}`);
    if (brandTruth.tone_guidelines.register) {
      parts.push(`Register: ${brandTruth.tone_guidelines.register}`);
    }
  }

  // Target audience — flatten the structured object so all sub-fields
  // contribute to the centroid.
  const aud = brandTruth.target_audience;
  if (aud) {
    if (aud.primary_verticals?.length) {
      parts.push(`Target audience: ${aud.primary_verticals.join(', ')}`);
    }
    if (aud.secondary_verticals?.length) {
      parts.push(`Also serves: ${aud.secondary_verticals.join(', ')}`);
    }
    if (aud.firmographic) parts.push(`Firmographic: ${aud.firmographic}`);
    if (aud.persona) parts.push(`Persona: ${aud.persona}`);
  }

  // What kinds of queries this firm wants to win — these are intent
  // strings written in the same register as user search queries, so
  // they pull the centroid toward search-relevant vocabulary.
  if (brandTruth.seed_query_intents?.length) {
    parts.push(
      `Search intents: ${brandTruth.seed_query_intents.join('. ')}`,
    );
  }

  // Awards — names alone are a useful signal for "this is the firm" pages.
  if (brandTruth.awards?.length) {
    const awardNames = brandTruth.awards.map((a) =>
      a.year ? `${a.name} (${a.year})` : a.name,
    );
    parts.push(`Awards: ${awardNames.join(', ')}`);
  }

  // Type-specific descriptive content — this is where the centroid gets
  // its body. Practice areas + bio prose + case summaries collectively
  // sample the firm's actual vocabulary.
  if (brandTruth.firm_type === 'law_firm') {
    if (brandTruth.practice_areas?.length) {
      parts.push(`Practice areas: ${brandTruth.practice_areas.join(', ')}`);
    }
    if (brandTruth.geographies_served?.length) {
      const geos = brandTruth.geographies_served.map(
        (g) => `${g.city}, ${g.state}`,
      );
      parts.push(`Geographies served: ${geos.join('; ')}`);
    }
    for (const bio of brandTruth.attorney_bios ?? []) {
      const line = [bio.name, bio.role, bio.bio].filter(Boolean).join(' — ');
      if (line) parts.push(`Attorney: ${line}`);
      if (bio.credentials?.length) {
        parts.push(`Credentials: ${bio.credentials.join(', ')}`);
      }
    }
    for (const c of brandTruth.notable_cases ?? []) {
      const line = [c.summary, c.outcome, c.jurisdiction]
        .filter(Boolean)
        .join(' — ');
      if (line) parts.push(`Notable case: ${line}`);
    }
  } else if (brandTruth.firm_type === 'dental_practice') {
    if (brandTruth.practice_areas?.length) {
      parts.push(`Services: ${brandTruth.practice_areas.join(', ')}`);
    }
    if (brandTruth.geographies_served?.length) {
      const geos = brandTruth.geographies_served.map(
        (g) => `${g.city}, ${g.state}`,
      );
      parts.push(`Geographies served: ${geos.join('; ')}`);
    }
    for (const bio of brandTruth.provider_bios ?? []) {
      const line = [bio.name, bio.role, bio.bio].filter(Boolean).join(' — ');
      if (line) parts.push(`Provider: ${line}`);
      if (bio.credentials?.length) {
        parts.push(`Credentials: ${bio.credentials.join(', ')}`);
      }
    }
  } else if (brandTruth.firm_type === 'marketing_agency') {
    for (const s of brandTruth.service_offerings ?? []) {
      parts.push(`Service: ${s.name} — ${s.scope}`);
    }
    if (brandTruth.service_areas?.length) {
      parts.push(`Service areas: ${brandTruth.service_areas.join(', ')}`);
    }
    for (const m of brandTruth.team_members ?? []) {
      const line = [m.name, m.role, m.bio].filter(Boolean).join(' — ');
      if (line) parts.push(`Team: ${line}`);
    }
    for (const c of brandTruth.key_clients_public ?? []) {
      const line = [c.name, c.vertical, c.testimonial_quote]
        .filter(Boolean)
        .join(' — ');
      if (line) parts.push(`Client: ${line}`);
    }
  } else if (brandTruth.firm_type === 'other') {
    for (const s of brandTruth.service_offerings ?? []) {
      parts.push(`Service: ${s.name} — ${s.scope}`);
    }
    if (brandTruth.service_areas?.length) {
      parts.push(`Service areas: ${brandTruth.service_areas.join(', ')}`);
    }
  }

  return parts.join('\n');
}

/**
 * Embed a list of texts. Returns vectors in the same order as input.
 * Empty strings get embedded too (OpenAI accepts them) — caller should
 * pre-filter if that's not desired.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const client = getClient();

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await client.embeddings.create({
      model: MODEL,
      input: batch,
    });
    // OpenAI guarantees the response preserves input ordering.
    for (const item of res.data) out.push(item.embedding);
  }

  return out;
}

export async function embedSingle(text: string): Promise<number[]> {
  const [vec] = await embedBatch([text]);
  return vec ?? [];
}

/** Dot product of two equal-length vectors. */
function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(a: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s);
}

/**
 * Cosine similarity ∈ [-1, 1]. text-embedding-3-large tends to produce
 * vectors with similarity >0 for any plausibly-related pair, so "negative"
 * in practice just means "very unrelated."
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const denom = norm(a) * norm(b);
  if (denom === 0) return 0;
  return dot(a, b) / denom;
}

/**
 * Semantic distance = 1 - cosine similarity. Distance in [0, 2]; PLAN
 * §5.3 threshold rules are expressed in distance:
 *   - d > 0.45  → no-index / redirect candidate
 *   - 0.30 < d ≤ 0.45 → rewrite candidate
 *   - d ≤ 0.30  → aligned, no action
 */
export function semanticDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

export const EMBEDDING_MODEL = MODEL;
