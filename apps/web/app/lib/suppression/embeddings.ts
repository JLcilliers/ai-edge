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
 * We include the fields that describe the firm's voice + positioning
 * (identity, services, value props) but skip operational metadata like
 * compliance_jurisdictions — those don't describe content.
 */
export function brandTruthToText(brandTruth: BrandTruth): string {
  const bt = brandTruth as any;
  const parts: string[] = [];

  if (bt.firm_name) parts.push(`Firm: ${bt.firm_name}`);
  if (Array.isArray(bt.name_variants) && bt.name_variants.length > 0) {
    parts.push(`Also known as: ${bt.name_variants.join(', ')}`);
  }
  if (bt.positioning) parts.push(`Positioning: ${bt.positioning}`);
  if (bt.elevator_pitch) parts.push(`Elevator pitch: ${bt.elevator_pitch}`);
  if (bt.mission) parts.push(`Mission: ${bt.mission}`);

  if (Array.isArray(bt.practice_areas) && bt.practice_areas.length > 0) {
    parts.push(`Practice areas: ${bt.practice_areas.join(', ')}`);
  }
  if (Array.isArray(bt.services) && bt.services.length > 0) {
    parts.push(`Services: ${bt.services.join(', ')}`);
  }
  if (Array.isArray(bt.value_props) && bt.value_props.length > 0) {
    parts.push(`Value propositions: ${bt.value_props.join('. ')}`);
  }
  if (Array.isArray(bt.differentiators) && bt.differentiators.length > 0) {
    parts.push(`Differentiators: ${bt.differentiators.join('. ')}`);
  }
  if (bt.tone) parts.push(`Tone of voice: ${bt.tone}`);
  if (Array.isArray(bt.target_audience) && bt.target_audience.length > 0) {
    parts.push(`Target audience: ${bt.target_audience.join(', ')}`);
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
