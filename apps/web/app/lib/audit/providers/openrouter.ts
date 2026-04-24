import OpenAI from 'openai';
import type { ProviderQueryOptions, ProviderQueryResult } from './openai';

// OpenRouter is OpenAI-API-compatible — same SDK, different baseURL.
// Model IDs use "{vendor}/{model}" format (e.g. google/gemini-2.5-pro).
// See https://openrouter.ai/docs/quickstart
export const PROVIDER_NAME = 'openrouter' as const;
export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-pro';
export const SYSTEM_PROMPT =
  'You are a helpful assistant answering questions about marketing agencies and law firms. Provide detailed, factual answers. Always cite your sources when possible.';

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL ?? 'https://clixsy.com',
        'X-OpenRouter-Title': process.env.OPENROUTER_SITE_NAME ?? 'Clixsy Intercept',
      },
    });
  }
  return _client;
}

export async function queryOpenRouter(
  queryText: string,
  options: ProviderQueryOptions = {},
): Promise<ProviderQueryResult> {
  const client = getClient();
  const start = Date.now();

  const response = await client.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: options.temperature ?? 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: queryText },
    ],
  });

  const latencyMs = Date.now() - start;
  const text = response.choices[0]?.message?.content ?? '';

  return {
    text,
    model: response.model,
    latencyMs,
    raw: response,
  };
}
