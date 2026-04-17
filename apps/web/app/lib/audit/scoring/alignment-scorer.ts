import OpenAI from 'openai';
import type { BrandTruth } from '@ai-edge/shared';

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

export interface AlignmentScore {
  mentioned: boolean;
  tone_score: number;
  factual_accuracy: { has_errors: boolean; errors: string[] };
  citations: string[];
  gap_reasons: string[];
  remediation_priority: 'red' | 'yellow' | 'green';
}

function buildJudgePrompt(
  brandTruth: BrandTruth,
  queryText: string,
  responseText: string,
): string {
  return `You are an AI brand alignment evaluator. Given a Brand Truth document and an LLM's response to a prospect-intent query, score the response.

<brand_truth>
${JSON.stringify(brandTruth, null, 2)}
</brand_truth>

<query>
${queryText}
</query>

<llm_response>
${responseText}
</llm_response>

Evaluate:
1. MENTIONED: Is the firm mentioned by name in the response? (boolean)
2. TONE_SCORE: How well does the description align with the Brand Truth positioning? (1-10, where 10 = perfect alignment)
3. FACTUAL_ACCURACY: Are there any factually incorrect claims about the firm? (boolean has_errors, string[] errors)
4. CITATIONS: List any URLs or sources cited in the response (string[])
5. GAP_REASONS: If tone_score < 8, explain specifically what's misaligned (string[])
6. REMEDIATION_PRIORITY: Based on the above, assign Red (not mentioned OR factual errors), Yellow (mentioned but misaligned tone < 7), Green (mentioned AND tone >= 7 AND no factual errors)

Respond ONLY with valid JSON matching this schema:
{
  "mentioned": boolean,
  "tone_score": number,
  "factual_accuracy": { "has_errors": boolean, "errors": string[] },
  "citations": string[],
  "gap_reasons": string[],
  "remediation_priority": "red" | "yellow" | "green"
}`;
}

export async function scoreAlignment(
  brandTruth: BrandTruth,
  queryText: string,
  responseText: string,
): Promise<AlignmentScore> {
  const client = getClient();
  const prompt = buildJudgePrompt(brandTruth, queryText, responseText);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: 'gpt-4.1',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(content) as AlignmentScore;

      // Basic validation
      if (typeof parsed.mentioned !== 'boolean' || typeof parsed.tone_score !== 'number') {
        throw new Error('Invalid score structure');
      }

      return parsed;
    } catch (err) {
      if (attempt === 1) {
        // Second failure — return fallback
        return {
          mentioned: false,
          tone_score: 0,
          factual_accuracy: { has_errors: false, errors: [] },
          citations: [],
          gap_reasons: ['scoring_parse_failure'],
          remediation_priority: 'red',
        };
      }
    }
  }

  // TypeScript exhaustiveness — unreachable
  throw new Error('unreachable');
}
