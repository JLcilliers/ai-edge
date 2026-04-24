import {
  getDb,
  auditRuns,
  queries as queriesTable,
  modelResponses,
  consensusResponses,
  alignmentScores,
  citations as citationsTable,
  brandTruthVersions,
  remediationTickets,
  competitors as competitorsTable,
  competitorMentions,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { eq } from 'drizzle-orm';
import { queryOpenAI } from './providers/openai';
import { queryAnthropic } from './providers/anthropic';
import { queryOpenRouter } from './providers/openrouter';
import { queryPerplexity } from './providers/perplexity';
import { scoreAlignment } from './scoring/alignment-scorer';
import { detectCompetitorMentions } from '../competitors/detect';

/**
 * Options for an audit run.
 *
 * `kind='full'` runs every seed query in the Brand Truth — the weekly cadence.
 * `kind='daily-priority'` runs only the top N queries (default 20) — cheap
 *   daily cadence for the high-value prospect-intent queries.
 */
export type AuditKind = 'full' | 'daily-priority';

export interface RunAuditOptions {
  kind?: AuditKind;
  /** Max number of seed queries to run. Only applied when kind='daily-priority'. */
  queryLimit?: number;
}

export async function runAudit(
  firmId: string,
  brandTruthVersionId: string,
  options: RunAuditOptions = {},
): Promise<string> {
  const db = getDb();
  const kind = options.kind ?? 'full';
  const queryLimit = options.queryLimit ?? 20;

  // Create audit run
  const [run] = await db
    .insert(auditRuns)
    .values({
      firm_id: firmId,
      brand_truth_version_id: brandTruthVersionId,
      kind,
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

    // Load competitor roster once for the whole run — detection only needs
    // name + website, and the roster doesn't change mid-run.
    const competitorRoster = await db
      .select({
        id: competitorsTable.id,
        name: competitorsTable.name,
        website: competitorsTable.website,
      })
      .from(competitorsTable)
      .where(eq(competitorsTable.firm_id, firmId));

    // Get seed queries from the Brand Truth, sliced for daily-priority
    const allSeedQueries = (brandTruth as any).seed_query_intents ?? [];
    if (allSeedQueries.length === 0) throw new Error('No seed queries in Brand Truth');
    const seedQueries: string[] =
      kind === 'daily-priority'
        ? allSeedQueries.slice(0, queryLimit)
        : allSeedQueries;

    // Process each query
    for (const queryText of seedQueries) {
      // Create query row
      const [queryRow] = await db
        .insert(queriesTable)
        .values({
          audit_run_id: auditRunId,
          text: queryText,
          priority: kind === 'daily-priority' ? 'top20' : 'standard',
        })
        .returning({ id: queriesTable.id });

      const queryId = queryRow!.id;

      // Fan out to providers in parallel. Each is gated on its env key so
      // we never pay for an unkeyed provider. OpenRouter covers Gemini /
      // Llama / DeepSeek / Mistral under one key; Perplexity Sonar runs live
      // web search and brings back its own citations.
      const providers = [
        { name: 'openai', fn: queryOpenAI, enabled: !!process.env.OPENAI_API_KEY },
        { name: 'anthropic', fn: queryAnthropic, enabled: !!process.env.ANTHROPIC_API_KEY },
        { name: 'openrouter', fn: queryOpenRouter, enabled: !!process.env.OPENROUTER_API_KEY },
        { name: 'perplexity', fn: queryPerplexity, enabled: !!process.env.PERPLEXITY_API_KEY },
      ].filter((p) => p.enabled);

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

            // Store alignment score (including factual errors from the judge)
            const [alignmentRow] = await db.insert(alignmentScores).values({
              consensus_response_id: consensusId,
              mentioned: score.mentioned,
              tone_1_10: score.tone_score,
              rag_label: score.remediation_priority,
              gap_reasons: score.gap_reasons,
              factual_errors: score.factual_accuracy?.errors ?? [],
              remediation_priority:
                score.remediation_priority === 'red' ? 1 :
                score.remediation_priority === 'yellow' ? 2 : 3,
            }).returning({ id: alignmentScores.id });

            // Create remediation ticket for Red results
            if (score.remediation_priority === 'red' && alignmentRow) {
              await db.insert(remediationTickets).values({
                firm_id: firmId,
                source_type: 'audit',
                source_id: alignmentRow.id,
                status: 'open',
                playbook_step: 'initial_triage',
                due_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
              });
            }

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

            // Detect competitor mentions in the response. Deterministic +
            // local — no extra LLM call — so we run it for every provider.
            // The table is scoped by (firm_id, competitor_id, query_id), not
            // per-provider; if multiple providers mention competitor X for
            // the same query we currently write one row per provider. That
            // gives us more signal than dedup'd rows and matches the per-
            // provider-per-query shape of consensus_responses.
            if (competitorRoster.length > 0) {
              const detected = detectCompetitorMentions({
                brandTruth,
                competitors: competitorRoster,
                responseText: result.text,
              });
              if (detected.length > 0) {
                await db.insert(competitorMentions).values(
                  detected.map((d) => ({
                    firm_id: firmId,
                    competitor_id: d.competitorId,
                    query_id: queryId,
                    share: d.share,
                    praise_flag: d.praiseFlag,
                  })),
                );
              }
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
