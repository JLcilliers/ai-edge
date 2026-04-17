import {
  getDb,
  auditRuns,
  queries as queriesTable,
  modelResponses,
  consensusResponses,
  alignmentScores,
  citations as citationsTable,
  brandTruthVersions,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { eq } from 'drizzle-orm';
import { queryOpenAI } from './providers/openai';
import { queryAnthropic } from './providers/anthropic';
import { scoreAlignment } from './scoring/alignment-scorer';

export async function runAudit(firmId: string, brandTruthVersionId: string): Promise<string> {
  const db = getDb();

  // Create audit run
  const [run] = await db
    .insert(auditRuns)
    .values({
      firm_id: firmId,
      brand_truth_version_id: brandTruthVersionId,
      kind: 'full',
      status: 'running',
      started_at: new Date(),
    })
    .returning({ id: auditRuns.id });

  const auditRunId = run!.id;

  try {
    // Fetch Brand Truth
    const [btVersion] = await db
      .select()
      .from(brandTruthVersions)
      .where(eq(brandTruthVersions.id, brandTruthVersionId))
      .limit(1);

    if (!btVersion) throw new Error('Brand Truth version not found');
    const brandTruth = btVersion.payload as BrandTruth;

    // Get seed queries from the Brand Truth
    const seedQueries = (brandTruth as any).seed_query_intents ?? [];
    if (seedQueries.length === 0) throw new Error('No seed queries in Brand Truth');

    // Process each query
    for (const queryText of seedQueries) {
      // Create query row
      const [queryRow] = await db
        .insert(queriesTable)
        .values({
          audit_run_id: auditRunId,
          text: queryText,
          priority: 'standard',
        })
        .returning({ id: queriesTable.id });

      const queryId = queryRow!.id;

      // Fan out to providers in parallel
      const providers = [
        { name: 'openai', fn: queryOpenAI },
        { name: 'anthropic', fn: queryAnthropic },
      ] as const;

      const results = await Promise.allSettled(
        providers.map(async (provider) => {
          try {
            const result = await provider.fn(queryText);

            // Store model response
            const [modelResp] = await db
              .insert(modelResponses)
              .values({
                query_id: queryId,
                provider: provider.name,
                model: result.model,
                attempt: 1,
                raw_response: result.raw as any,
                latency_ms: result.latencyMs,
              })
              .returning({ id: modelResponses.id });

            // Score alignment
            const score = await scoreAlignment(brandTruth, queryText, result.text);

            // Create consensus response (k=1 for Phase 1)
            const [consensus] = await db
              .insert(consensusResponses)
              .values({
                query_id: queryId,
                self_consistency_k: 1,
                majority_answer: result.text.slice(0, 10000), // cap storage
                variance: 0,
                mentioned: score.mentioned,
              })
              .returning({ id: consensusResponses.id });

            const consensusId = consensus!.id;

            // Store alignment score
            await db.insert(alignmentScores).values({
              consensus_response_id: consensusId,
              mentioned: score.mentioned,
              tone_1_10: score.tone_score,
              rag_label: score.remediation_priority,
              gap_reasons: score.gap_reasons,
              remediation_priority:
                score.remediation_priority === 'red' ? 1 :
                score.remediation_priority === 'yellow' ? 2 : 3,
            });

            // Store citations
            if (score.citations.length > 0) {
              await db.insert(citationsTable).values(
                score.citations.map((url, rank) => ({
                  consensus_response_id: consensusId,
                  url,
                  domain: extractDomain(url),
                  rank,
                })),
              );
            }

            return { provider: provider.name, success: true };
          } catch (err) {
            // Store the failure — don't kill the whole audit
            await db.insert(modelResponses).values({
              query_id: queryId,
              provider: provider.name,
              model: 'error',
              attempt: 1,
              raw_response: { error: String(err) },
              latency_ms: 0,
            });
            return { provider: provider.name, success: false, error: String(err) };
          }
        }),
      );
    }

    // Mark completed
    await db
      .update(auditRuns)
      .set({ status: 'completed', finished_at: new Date() })
      .where(eq(auditRuns.id, auditRunId));
  } catch (err) {
    // Mark failed
    await db
      .update(auditRuns)
      .set({ status: 'failed', finished_at: new Date(), error: String(err) })
      .where(eq(auditRuns.id, auditRunId));
  }

  return auditRunId;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
