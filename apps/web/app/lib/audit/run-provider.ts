import type { ProviderQueryOptions, ProviderQueryResult } from './providers/openai';
import {
  queryOpenAI,
  PROVIDER_NAME as OPENAI_NAME,
  DEFAULT_MODEL as OPENAI_MODEL,
  SYSTEM_PROMPT as OPENAI_SYSTEM_PROMPT,
} from './providers/openai';
import {
  queryAnthropic,
  PROVIDER_NAME as ANTHROPIC_NAME,
  DEFAULT_MODEL as ANTHROPIC_MODEL,
  SYSTEM_PROMPT as ANTHROPIC_SYSTEM_PROMPT,
} from './providers/anthropic';
import {
  queryOpenRouter,
  PROVIDER_NAME as OPENROUTER_NAME,
  DEFAULT_MODEL as OPENROUTER_MODEL,
  SYSTEM_PROMPT as OPENROUTER_SYSTEM_PROMPT,
} from './providers/openrouter';
import {
  queryPerplexity,
  PROVIDER_NAME as PERPLEXITY_NAME,
  DEFAULT_MODEL as PERPLEXITY_MODEL,
  SYSTEM_PROMPT as PERPLEXITY_SYSTEM_PROMPT,
} from './providers/perplexity';
import { buildCacheKey, getCachedResponse, putCachedResponse } from './cache';
import { calculateCost, extractUsage, type ProviderName } from './pricing';

/**
 * Per-provider dispatch table. Keeps run-audit.ts clean — provider
 * selection happens here once and budget/cache wrapping is shared.
 */
interface ProviderDescriptor {
  name: ProviderName;
  defaultModel: string;
  systemPrompt: string;
  enabled: boolean;
  call: (text: string, options: ProviderQueryOptions) => Promise<ProviderQueryResult>;
}

export function getEnabledProviders(): ProviderDescriptor[] {
  return [
    {
      name: OPENAI_NAME,
      defaultModel: OPENAI_MODEL,
      systemPrompt: OPENAI_SYSTEM_PROMPT,
      enabled: !!process.env.OPENAI_API_KEY,
      call: queryOpenAI,
    },
    {
      name: ANTHROPIC_NAME,
      defaultModel: ANTHROPIC_MODEL,
      systemPrompt: ANTHROPIC_SYSTEM_PROMPT,
      enabled: !!process.env.ANTHROPIC_API_KEY,
      call: queryAnthropic,
    },
    {
      name: OPENROUTER_NAME,
      defaultModel: OPENROUTER_MODEL,
      systemPrompt: OPENROUTER_SYSTEM_PROMPT,
      enabled: !!process.env.OPENROUTER_API_KEY,
      call: queryOpenRouter,
    },
    {
      name: PERPLEXITY_NAME,
      defaultModel: PERPLEXITY_MODEL,
      systemPrompt: PERPLEXITY_SYSTEM_PROMPT,
      enabled: !!process.env.PERPLEXITY_API_KEY,
      call: queryPerplexity,
    },
  ].filter((p) => p.enabled);
}

export interface RunProviderArgs {
  provider: ProviderDescriptor;
  userPrompt: string;
  /** 0 for deterministic single-shot, ~0.7 for k=3 self-consistency. */
  temperature: number;
  /** Which sample (0-indexed) within a k=N run this is. */
  sampleIdx: number;
}

export interface RunProviderResult {
  text: string;
  model: string;
  latencyMs: number;
  raw: unknown;
  costUsd: number;
  /** True when the response came from the 24h cache — cost was $0. */
  cached: boolean;
}

/**
 * Single-shot provider invocation with 24h cache + cost accounting.
 *
 *   Miss path: call provider → extract usage → compute cost →
 *              write cache entry → return result.
 *   Hit path:  lookup cache → return cached text with costUsd=0 and
 *              `cached: true` flag (the caller should record attempt + 0
 *              cost but skip the recordRunCost delta).
 *
 * Cache key includes sampleIdx + temperature, so k=3 runs write three
 * distinct entries and subsequent k=3 runs within 24h hit all three.
 */
export async function runProviderQuery(
  args: RunProviderArgs,
): Promise<RunProviderResult> {
  const { provider, userPrompt, temperature, sampleIdx } = args;

  // Cache key pins the exact shape of the call. Changing model, prompt, or
  // sampling params invalidates the hit — which is what we want.
  const cacheKey = buildCacheKey({
    provider: provider.name,
    // Include temperature + sample in the "model" component so k=3/temp=0.7
    // gets three distinct keys while k=1/temp=0 collapses to one.
    model: `${provider.defaultModel}|t=${temperature}|s=${sampleIdx}`,
    systemPrompt: provider.systemPrompt,
    userPrompt,
  });

  const cached = await getCachedResponse(cacheKey);
  if (cached) {
    return {
      text: cached.response_text,
      model: cached.model,
      latencyMs: cached.latency_ms ?? 0,
      raw: cached.raw_response,
      costUsd: 0,
      cached: true,
    };
  }

  // Miss — call the provider.
  const result = await provider.call(userPrompt, { temperature });

  const usage = extractUsage(result.raw);
  const costUsd = calculateCost(provider.name, result.model, usage);

  await putCachedResponse({
    cacheKey,
    provider: provider.name,
    model: result.model,
    responseText: result.text,
    rawResponse: result.raw,
    latencyMs: result.latencyMs,
    costUsd,
  });

  return {
    text: result.text,
    model: result.model,
    latencyMs: result.latencyMs,
    raw: result.raw,
    costUsd,
    cached: false,
  };
}

export type { ProviderDescriptor };
