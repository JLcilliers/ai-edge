import OpenAI from 'openai';

// Perplexity Sonar is OpenAI-API-compatible — same SDK, different baseURL.
// Sonar models run live web search and include citations in the response
// body under `citations`, which makes them a distinct voice vs. the raw
// training-data responses from OpenAI / Anthropic / OpenRouter.
//
// See https://docs.perplexity.ai/api-reference/chat-completions-post
const SYSTEM_PROMPT =
  'You are a helpful assistant answering questions about marketing agencies and law firms. Provide detailed, factual answers. Always cite your sources when possible.';

// `sonar` is the budget tier with built-in web search — fine for audit
// fan-out. Override to `sonar-pro` / `sonar-reasoning` via env when we want
// deeper answers per query.
const DEFAULT_MODEL = process.env.PERPLEXITY_MODEL ?? 'sonar';

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.PERPLEXITY_API_KEY,
      baseURL: 'https://api.perplexity.ai',
    });
  }
  return _client;
}

export async function queryPerplexity(queryText: string): Promise<{
  text: string;
  model: string;
  latencyMs: number;
  raw: unknown;
}> {
  const client = getClient();
  const start = Date.now();

  const response = await client.chat.completions.create({
    model: DEFAULT_MODEL,
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
    // Raw response includes Perplexity's structured `citations` array. We
    // keep the whole payload in model_response.raw_response so a later
    // pass can promote those into the citations table directly instead
    // of relying on the judge model to re-extract URLs from text.
    raw: response,
  };
}
