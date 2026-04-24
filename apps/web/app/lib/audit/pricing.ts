/**
 * Per-provider, per-model token pricing. All prices in USD per 1M tokens.
 *
 * This is a deliberately small, hand-curated table — the prices shift every
 * few months and we'd rather have a single wrong number we notice than a
 * silently-stale network fetch. Override an individual model's price via
 * env (`LLM_PRICE_OVERRIDES_JSON`) if procurement has a negotiated rate.
 *
 * Sources (checked 2026-04):
 * - OpenAI:       https://openai.com/api/pricing
 * - Anthropic:    https://www.anthropic.com/pricing
 * - OpenRouter:   https://openrouter.ai/models  (pass-through at provider price)
 * - Perplexity:   https://docs.perplexity.ai/guides/pricing  (+ request fees ignored here)
 *
 * We fail *open* — an unknown (provider, model) defaults to zero cost and
 * logs a warning. That keeps audits running during a model rename; the
 * missing cost shows up as "$0.00" in the audit row which is the audit
 * signal that the table needs an entry.
 */

export type ProviderName = 'openai' | 'anthropic' | 'openrouter' | 'perplexity';

interface ModelPrice {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}

const BASE_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  'openai:gpt-4.1': { input: 2.0, output: 8.0 },
  'openai:gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'openai:gpt-4o': { input: 2.5, output: 10.0 },
  'openai:gpt-4o-mini': { input: 0.15, output: 0.6 },

  // Anthropic
  'anthropic:claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'anthropic:claude-opus-4-20250514': { input: 15.0, output: 75.0 },
  'anthropic:claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },

  // OpenRouter — most-used models here; pass-through pricing. The router
  // reports `{vendor}/{model}` as the returned model id, which is what we
  // key on (see the lookup below).
  'openrouter:google/gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'openrouter:google/gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'openrouter:meta-llama/llama-3.3-70b-instruct': { input: 0.23, output: 0.4 },
  'openrouter:deepseek/deepseek-chat': { input: 0.27, output: 1.1 },

  // Perplexity Sonar
  'perplexity:sonar': { input: 1.0, output: 1.0 },
  'perplexity:sonar-pro': { input: 3.0, output: 15.0 },
  'perplexity:sonar-reasoning': { input: 1.0, output: 5.0 },
};

// Env override: JSON map of "provider:model" → { input, output }.
// Example: LLM_PRICE_OVERRIDES_JSON='{"openai:gpt-4.1":{"input":1.5,"output":6}}'
let _overrides: Record<string, ModelPrice> | null = null;
function getOverrides(): Record<string, ModelPrice> {
  if (_overrides !== null) return _overrides;
  try {
    const raw = process.env.LLM_PRICE_OVERRIDES_JSON;
    _overrides = raw ? JSON.parse(raw) : {};
  } catch {
    _overrides = {};
  }
  return _overrides!;
}

function lookupPrice(provider: ProviderName, model: string): ModelPrice | null {
  const key = `${provider}:${model}`;
  const overrides = getOverrides();
  if (overrides[key]) return overrides[key];
  if (BASE_PRICES[key]) return BASE_PRICES[key];
  return null;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Extract token usage from whatever shape the provider returned. All the
 * providers we use expose usage under `response.usage`, but the field
 * names differ:
 *   - OpenAI / OpenRouter / Perplexity: `prompt_tokens` + `completion_tokens`
 *   - Anthropic: `input_tokens` + `output_tokens`
 *
 * Returns zeros if nothing parseable is found — the cost will be $0 and
 * the row will flag itself.
 */
export function extractUsage(raw: unknown): TokenUsage {
  if (!raw || typeof raw !== 'object') return { input_tokens: 0, output_tokens: 0 };
  const u = (raw as { usage?: Record<string, unknown> }).usage;
  if (!u || typeof u !== 'object') return { input_tokens: 0, output_tokens: 0 };

  const input =
    typeof u.prompt_tokens === 'number' ? u.prompt_tokens :
    typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const output =
    typeof u.completion_tokens === 'number' ? u.completion_tokens :
    typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  return { input_tokens: input, output_tokens: output };
}

/**
 * Convert a token-usage pair + model into a USD cost. Returns 0 if the
 * model isn't in the price table — we'd rather keep running than crash
 * an audit on a model rename.
 */
export function calculateCost(
  provider: ProviderName,
  model: string,
  usage: TokenUsage,
): number {
  const price = lookupPrice(provider, model);
  if (!price) {
    // Surface the miss so operators can add the model.
    console.warn(`[pricing] no price for ${provider}:${model}; cost set to 0`);
    return 0;
  }
  const inputCost = (usage.input_tokens / 1_000_000) * price.input;
  const outputCost = (usage.output_tokens / 1_000_000) * price.output;
  // Round to 6 decimals so the real column doesn't carry float noise.
  return Math.round((inputCost + outputCost) * 1e6) / 1e6;
}
