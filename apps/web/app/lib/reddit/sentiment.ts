import OpenAI from 'openai';

/**
 * Classify a Reddit post's sentiment toward a firm via a cheap LLM judge.
 * Uses OpenRouter Gemini 2.5 Flash — fast, cheap, JSON-mode compatible.
 *
 * Rationale: we're on Vercel Fluid Compute (Node runtime) and don't want to
 * host a distilbert model. The LLM judge also captures nuance the simple
 * polarity classifiers miss ("asking for a recommendation" vs "complaining").
 */
export type RedditSentiment =
  | 'praise'
  | 'complaint'
  | 'neutral'
  | 'recommendation_request';

const MODEL = 'google/gemini-2.5-flash';

const SYSTEM_PROMPT = `You classify Reddit posts for a brand reputation monitor.
Return EXACTLY ONE of these labels: praise | complaint | neutral | recommendation_request

Definitions:
- praise: the post recommends, endorses, or speaks positively about the firm.
- complaint: the post criticizes, warns about, or describes a bad experience.
- recommendation_request: the post asks for suggestions/opinions about the firm
  or about firms like it (high-value prospect signal).
- neutral: factual mention, news, or unrelated context.

Return ONLY JSON: {"label":"<one of the four labels>","confidence":0.0-1.0}`;

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

export async function classifySentiment(args: {
  firmName: string;
  title: string;
  body: string;
}): Promise<{ label: RedditSentiment; confidence: number }> {
  // No key — fall back to 'neutral' rather than killing the scan.
  if (!process.env.OPENROUTER_API_KEY) {
    return { label: 'neutral', confidence: 0 };
  }

  const client = getClient();
  const userPrompt = `Firm: ${args.firmName}
Post title: ${args.title}
Post body: ${args.body.slice(0, 2000)}`;

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(raw) as { label?: string; confidence?: number };
    const label = normalizeLabel(parsed.label);
    const confidence =
      typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
    return { label, confidence };
  } catch {
    // Any parse/API error → neutral with 0 confidence so the row still saves.
    return { label: 'neutral', confidence: 0 };
  }
}

function normalizeLabel(raw: string | undefined): RedditSentiment {
  const v = (raw ?? '').toLowerCase().trim();
  if (v === 'praise') return 'praise';
  if (v === 'complaint') return 'complaint';
  if (v === 'recommendation_request' || v === 'recommendation-request')
    return 'recommendation_request';
  return 'neutral';
}
