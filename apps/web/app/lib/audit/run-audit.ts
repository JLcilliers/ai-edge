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
import { scoreAlignment } from './scoring/alignment-scorer';
import { detectCompetitorMentions } from '../competitors/detect';
import { getEnabledProviders, runProviderQuery, type ProviderDescriptor } from './run-provider';
import {
  getFirmBudgetStatus,
  isFirmOverBudget,
  recordRunCost,
} from './budget';

/**
 * Options for an audit run.
 *
 * `kind='full'` runs every seed query in the Brand Truth — the weekly cadence.
 * `kind='daily-priority'` runs only the top N queries (default 20) — cheap
 *   daily cadence for the high-value prospect-intent queries.
 *
 * Self-consistency (k):
 *   - Queries tagged 'top20' run k=3 at temperature=0.7 — majority-vote
 *     mentioned-ness, variance surfaces disagreement.
 *   - 'standard' queries run k=1 at temperature=0 (deterministic).
 *
 * Budget gate:
 *   - Pre-flight: `isFirmOverBudget` is checked before the run starts; if
 *     over, the caller (cron route or server action) skips with
 *     `status='skipped_budget_exceeded'` rather than creating a run.
 *   - In-flight: after each query we re-check and break out of the query
 *     loop if costs crossed the cap mid-run.
 */
export type AuditKind = 'full' | 'daily-priority';

export interface RunAuditOptions {
  kind?: AuditKind;
  /** Max number of seed queries to run. Only applied when kind='daily-priority'. */
  queryLimit?: number;
}

const K_HIGH_PRIORITY = 3;
const K_STANDARD = 1;
const TEMPERATURE_HIGH_PRIORITY = 0.7;
const TEMPERATURE_STANDARD = 0;
const TOP_PRIORITY_COUNT = 20;

interface SampleResult {
  providerName: string;
  model: string;
  attempt: number;
  text: string;
  raw: unknown;
  latencyMs: number;
  costUsd: number;
  cached: boolean;
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

    // Competitor roster snapshot — detection is local + deterministic.
    const competitorRoster = await db
      .select({
        id: competitorsTable.id,
        name: competitorsTable.name,
        website: competitorsTable.website,
      })
      .from(competitorsTable)
      .where(eq(competitorsTable.firm_id, firmId));

    // Seed queries: sliced to queryLimit for daily-priority, full list otherwise.
    const allSeedQueries = ((brandTruth as unknown) as { seed_query_intents?: string[] })
      .seed_query_intents ?? [];
    if (allSeedQueries.length === 0) throw new Error('No seed queries in Brand Truth');
    const seedQueries: string[] =
      kind === 'daily-priority'
        ? allSeedQueries.slice(0, queryLimit)
        : allSeedQueries;

    const providers = getEnabledProviders();
    let budgetHit = false;

    for (let qi = 0; qi < seedQueries.length; qi++) {
      // Mid-run budget gate. Also catches the case where the firm was *just*
      // below cap at kickoff and crossed over after a few expensive queries.
      if (await isFirmOverBudget(firmId)) {
        budgetHit = true;
        console.log(`[audit] firm ${firmId} over budget at query ${qi}; aborting remaining queries`);
        break;
      }

      const queryText = seedQueries[qi]!;
      // Top-N queries are the "high-priority" tier (PLAN §6) regardless of kind.
      // Daily-priority runs hit the top-N subset; weekly full runs see them
      // first in the seed list and still get k=3 treatment.
      const priority = qi < TOP_PRIORITY_COUNT ? 'top20' : 'standard';
      const k = priority === 'top20' ? K_HIGH_PRIORITY : K_STANDARD;
      const temperature = priority === 'top20' ? TEMPERATURE_HIGH_PRIORITY : TEMPERATURE_STANDARD;

      // Row for this query.
      const [queryRow] = await db
        .insert(queriesTable)
        .values({
          audit_run_id: auditRunId,
          text: queryText,
          priority,
        })
        .returning({ id: queriesTable.id });
      const queryId = queryRow!.id;

      // Fan out: for each provider, run k samples in parallel. At k=1 this
      // collapses to the old behaviour; at k=3 we get three samples per
      // provider to vote over.
      const perProviderResults = await Promise.allSettled(
        providers.map((provider) => runProviderWithSamples({
          provider,
          userPrompt: queryText,
          temperature,
          k,
        })),
      );

      // Persist each sample + score majority, in parallel across providers.
      //
      // Each provider's post-response block is independent:
      //   - writes target disjoint rows (one consensus_response + one
      //     alignment_score per provider, and citation / competitor rows
      //     scoped by (query, provider) or (query, competitor))
      //   - recordRunCost is SQL-side atomic (`coalesce + add`) so the
      //     shared audit_run.cost_usd row serializes cleanly via row-lock
      //   - scoreAlignment calls its own LLM endpoint and has no shared
      //     in-memory state between invocations
      //
      // Previously serial (for-loop), which at 4 providers made the per-
      // query wall-clock ~4× the single-provider time. Parallel Promise.all
      // collapses that to max-of-providers instead of sum-of-providers.
      await Promise.all(providers.map(async (provider, pi) => {
        const settled = perProviderResults[pi]!;

        if (settled.status === 'rejected') {
          // Record failure — don't kill the rest of the audit.
          await db.insert(modelResponses).values({
            query_id: queryId,
            provider: provider.name,
            model: 'error',
            attempt: 1,
            raw_response: { error: String(settled.reason) } as never,
            latency_ms: 0,
            cost_usd: 0,
          });
          return;
        }

        const samples = settled.value;
        if (samples.length === 0) return;

        // Persist every sample with its attempt index (1-based for legibility).
        await db.insert(modelResponses).values(
          samples.map((s) => ({
            query_id: queryId,
            provider: s.providerName,
            model: s.model,
            attempt: s.attempt,
            raw_response: s.raw as never,
            latency_ms: s.latencyMs,
            cost_usd: s.costUsd,
          })),
        );

        // Accumulate total cost onto the run (skips cached rows via costUsd=0).
        const totalCost = samples.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
        await recordRunCost(auditRunId, totalCost);

        // Majority-vote consensus: score each sample, pick the majority on
        // `mentioned`, and treat the canonical "winning" sample as the one
        // whose `mentioned` matches the majority (first match wins).
        const scored = await Promise.all(
          samples.map(async (s) => ({
            sample: s,
            score: await scoreAlignment(brandTruth, queryText, s.text),
          })),
        );

        const mentionedVotes = scored.filter((s) => s.score.mentioned).length;
        const majorityMentioned = mentionedVotes * 2 > samples.length;
        const variance = scored.length > 0
          ? scored.filter((s) => s.score.mentioned !== majorityMentioned).length / scored.length
          : 0;

        // Pick the sample that matches the majority as the "canonical" for
        // consensus answer + alignment_score. At k=1 this is the single sample.
        const canonical = scored.find((s) => s.score.mentioned === majorityMentioned) ?? scored[0]!;

        const [consensus] = await db
          .insert(consensusResponses)
          .values({
            query_id: queryId,
            self_consistency_k: samples.length,
            majority_answer: canonical.sample.text.slice(0, 10000),
            variance,
            mentioned: majorityMentioned,
          })
          .returning({ id: consensusResponses.id });
        const consensusId = consensus!.id;

        const [alignmentRow] = await db.insert(alignmentScores).values({
          consensus_response_id: consensusId,
          mentioned: majorityMentioned,
          tone_1_10: canonical.score.tone_score,
          rag_label: canonical.score.remediation_priority,
          gap_reasons: canonical.score.gap_reasons,
          factual_errors: canonical.score.factual_accuracy?.errors ?? [],
          remediation_priority:
            canonical.score.remediation_priority === 'red' ? 1 :
            canonical.score.remediation_priority === 'yellow' ? 2 : 3,
        }).returning({ id: alignmentScores.id });

        // Remediation ticket for Red consensus.
        if (canonical.score.remediation_priority === 'red' && alignmentRow) {
          await db.insert(remediationTickets).values({
            firm_id: firmId,
            source_type: 'audit',
            source_id: alignmentRow.id,
            status: 'open',
            playbook_step: 'initial_triage',
            due_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          });
        }

        // Citations from the canonical sample's score.
        if (canonical.score.citations.length > 0) {
          await db.insert(citationsTable).values(
            canonical.score.citations.map((url, rank) => ({
              consensus_response_id: consensusId,
              url,
              domain: extractDomain(url),
              rank,
            })),
          );
        }

        // Competitor detection runs on the canonical text — one set of
        // rows per (firm, competitor, query). At k=3 we could detect across
        // all samples and merge, but the canonical sample is consistent
        // with the consensus answer so it's the right signal.
        if (competitorRoster.length > 0) {
          const detected = detectCompetitorMentions({
            brandTruth,
            competitors: competitorRoster,
            responseText: canonical.sample.text,
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
      }));
    }

    // Mark completed (or budget-truncated).
    const finalStatus = budgetHit ? 'completed_budget_truncated' : 'completed';
    await db
      .update(auditRuns)
      .set({ status: finalStatus, finished_at: new Date() })
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

/** Run k samples of a provider in parallel and return them in attempt order. */
async function runProviderWithSamples(args: {
  provider: ProviderDescriptor;
  userPrompt: string;
  temperature: number;
  k: number;
}): Promise<SampleResult[]> {
  const { provider, userPrompt, temperature, k } = args;
  const results = await Promise.all(
    Array.from({ length: k }, (_, idx) =>
      runProviderQuery({
        provider,
        userPrompt,
        temperature,
        sampleIdx: idx,
      }).then((r) => ({
        providerName: provider.name,
        model: r.model,
        attempt: idx + 1,
        text: r.text,
        raw: r.raw,
        latencyMs: r.latencyMs,
        costUsd: r.costUsd,
        cached: r.cached,
      })),
    ),
  );
  return results;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Pre-flight wrapper for callers that want "skip if already over budget." */
export async function runAuditIfUnderBudget(
  firmId: string,
  brandTruthVersionId: string,
  options: RunAuditOptions = {},
): Promise<{ ok: true; auditRunId: string } | { ok: false; reason: 'budget_exceeded'; status: Awaited<ReturnType<typeof getFirmBudgetStatus>> }> {
  const status = await getFirmBudgetStatus(firmId);
  if (status.overBudget) {
    return { ok: false, reason: 'budget_exceeded', status };
  }
  const id = await runAudit(firmId, brandTruthVersionId, options);
  return { ok: true, auditRunId: id };
}
