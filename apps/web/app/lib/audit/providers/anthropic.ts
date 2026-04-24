import Anthropic from '@anthropic-ai/sdk';
import type { ProviderQueryOptions, ProviderQueryResult } from './openai';

export const PROVIDER_NAME = 'anthropic' as const;
export const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
export const SYSTEM_PROMPT =
  'You are a helpful assistant answering questions about marketing agencies and law firms. Provide detailed, factual answers. Always cite your sources when possible.';

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

export async function queryAnthropic(
  queryText: string,
  options: ProviderQueryOptions = {},
): Promise<ProviderQueryResult> {
  const client = getClient();
  const start = Date.now();

  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 4096,
    temperature: options.temperature ?? 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: queryText }],
  });

  const latencyMs = Date.now() - start;
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return {
    text,
    model: response.model,
    latencyMs,
    raw: response,
  };
}
