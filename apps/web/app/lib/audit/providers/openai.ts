import OpenAI from 'openai';

const SYSTEM_PROMPT =
  'You are a helpful assistant answering questions about marketing agencies and law firms. Provide detailed, factual answers. Always cite your sources when possible.';

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

export async function queryOpenAI(queryText: string): Promise<{
  text: string;
  model: string;
  latencyMs: number;
  raw: unknown;
}> {
  const client = getClient();
  const start = Date.now();

  const response = await client.chat.completions.create({
    model: 'gpt-4.1',
    temperature: 0,
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
