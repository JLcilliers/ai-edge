import OpenAI from 'openai';

export const PROVIDER_NAME = 'openai' as const;
export const DEFAULT_MODEL = 'gpt-4.1';
export const SYSTEM_PROMPT =
  'You are a helpful assistant answering questions about marketing agencies and law firms. Provide detailed, factual answers. Always cite your sources when possible.';

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

export interface ProviderQueryResult {
  text: string;
  model: string;
  latencyMs: number;
  raw: unknown;
}

export interface ProviderQueryOptions {
  /** 0 for deterministic k=1 runs, ~0.7 for k=3 self-consistency fan-out. */
  temperature?: number;
}

export async function queryOpenAI(
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
