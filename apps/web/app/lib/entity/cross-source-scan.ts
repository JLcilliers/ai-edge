import {
  getDb,
  auditRuns,
  entitySignals,
  brandTruthVersions,
  remediationTickets,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { eq, desc } from 'drizzle-orm';
import { fetchAndExtract } from '../suppression/extract';
import {
  brandTruthToText,
  embedBatch,
  embedSingle,
  semanticDistance,
} from '../suppression/embeddings';
import { ensureSopRun } from '../sop/ensure-run';

/**
 * Cross-source vector alignment + third-party badge verification scanner
 * (Phase B items #2 + #5).
 *
 * The premise. LLMs and search engines weight third-party listings (BBB,
 * Super Lawyers, Avvo, Justia, Findlaw, Healthgrades, Zocdoc, Yelp,
 * Clutch, G2 — and also award-issuer profile pages reachable via
 * `awards[].source_url`) as authoritative descriptions of a firm. If the
 * prose on those listings has drifted from the firm's current Brand
 * Truth — or worse, if a "Super Lawyers 2024" badge in Brand Truth
 * doesn't actually appear on the corresponding Super Lawyers profile —
 * the firm's downstream LLM attribution suffers.
 *
 * What this scan does.
 *   1. Pulls every URL the operator has curated:
 *        - Brand Truth `third_party_listings[]` (BBB, Super Lawyers, etc.)
 *        - Brand Truth `awards[].source_url` (award-issuer pages)
 *   2. Fetches each page's main content (uses the existing readability-
 *      style extractor from suppression/extract.ts — same code path as
 *      the site-wide suppression scan, so the comparison is apples-to-
 *      apples with the on-site distance scores).
 *   3. Embeds the Brand Truth centroid (single embedding call) and the
 *      list of third-party page contents (batched).
 *   4. Computes cosine distance per source and emits an `entity_signal`
 *      row with `divergence_flags` carrying both the alignment finding
 *      and the badge-verification finding.
 *   5. Opens a remediation ticket per source URL that's significantly
 *      divergent OR whose award appears UNVERIFIED (i.e., the firm's
 *      name doesn't show up on the page).
 *
 * Threshold semantics (mirrors suppression/scan.ts):
 *   - d > 0.55  → 'cross-source:divergent' — listing reads off-brand
 *   - 0.40 < d ≤ 0.55 → 'cross-source:drift'    — informational
 *   - d ≤ 0.40  → 'cross-source:aligned'       — no action
 *
 * Badge verification:
 *   For each `awards[].source_url`, we check whether the firm's name
 *   (or any of `name_variants[]`) appears anywhere in the fetched page
 *   text. If absent → 'badge:unverified' flag + ticket. If present →
 *   'badge:verified'. This is a presence check, not a semantic claim
 *   about which year/category — but it catches the most common failure
 *   mode (an award stale-listed in Brand Truth that the issuer no longer
 *   credits the firm with).
 *
 * Cost. Sequential fetches with a 250ms politeness gap (third-party
 * directories are extremely sensitive to bot-like access patterns). One
 * embedding call for the Brand Truth centroid, one batched call for all
 * third-party pages — typically <$0.01 per scan.
 *
 * Why this scanner is separate from `runEntityScan`. The existing entity
 * scan checks the firm's own homepage for JSON-LD coverage and probes
 * Wikidata + Google KG. This one looks OUTWARD at how third parties are
 * describing the firm. They produce different ticket types (entity:
 * schema:* vs entity:cross-source:*) and run on different cadences (the
 * cross-source scan is weekly; the entity scan can be daily).
 */

const DISTANCE_THRESHOLD_DRIFT = 0.40;
const DISTANCE_THRESHOLD_DIVERGENT = 0.55;
const POLITENESS_DELAY_MS = 250;
const MIN_WORDS_TO_SCORE = 50; // Lower than suppression — directory listings are short.

interface CandidateSource {
  source: string; // matches entity_signal.source
  url: string;
  // 'listing' = generic third-party directory; 'award' = award-issuer page
  // (subject to badge verification). Drives which divergence_flags emit.
  kind: 'listing' | 'award';
  // For award sources, the award name surfaces in the verification
  // ticket so the operator knows which one is unverified.
  awardName?: string;
}

function safeHostFromUrl(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Sample a CandidateSource list off Brand Truth. We dedupe by URL so an
 * award whose `source_url` is the same as a `third_party_listings[]` entry
 * doesn't get double-fetched.
 */
function gatherSources(brandTruth: BrandTruth): CandidateSource[] {
  const seen = new Map<string, CandidateSource>();

  // third_party_listings (the operator's curated directory list)
  const bt = brandTruth as unknown as {
    third_party_listings?: Array<{ source: string; url: string; notes?: string }>;
  };
  for (const l of bt.third_party_listings ?? []) {
    if (!l.url || seen.has(l.url)) continue;
    seen.set(l.url, { source: l.source || 'listing', url: l.url, kind: 'listing' });
  }

  // awards[].source_url — award-issuer pages (subject to badge verification)
  for (const award of brandTruth.awards ?? []) {
    if (!award.source_url) continue;
    if (seen.has(award.source_url)) {
      // If the operator listed the same URL under both directory and award,
      // upgrade the kind to 'award' so we run badge verification on it.
      const existing = seen.get(award.source_url)!;
      if (existing.kind !== 'award') {
        existing.kind = 'award';
        existing.awardName = award.name;
      }
      continue;
    }
    const host = safeHostFromUrl(award.source_url) ?? 'award';
    // Best-effort source label from the host: 'superlawyers.com' → 'superlawyers'.
    const sourceLabel = host.replace(/\.(com|org|net|io|co)$/, '').split('.').pop() ?? host;
    seen.set(award.source_url, {
      source: sourceLabel,
      url: award.source_url,
      kind: 'award',
      awardName: award.name,
    });
  }

  return Array.from(seen.values());
}

export interface CrossSourceOutcome {
  runId: string;
  sourcesScanned: number;
  sourcesFetched: number;
  sourcesAligned: number;
  sourcesDrifted: number;
  sourcesDivergent: number;
  awardsVerified: number;
  awardsUnverified: number;
  ticketsOpened: number;
  errors: Array<{ url: string; error: string }>;
}

export async function runCrossSourceScan(
  firmId: string,
): Promise<CrossSourceOutcome> {
  const db = getDb();

  const [run] = await db
    .insert(auditRuns)
    .values({
      firm_id: firmId,
      kind: 'cross-source',
      status: 'running',
      started_at: new Date(),
    })
    .returning({ id: auditRuns.id });
  const runId = run!.id;

  // Cross-source divergence is an Entity Optimization concern — the
  // scan emits tickets to be triaged in Phase 4 entity_optimization
  // sop_run. Resolve it up-front so the inserts below carry sop_run_id.
  const sopRunId = await ensureSopRun(
    firmId,
    'entity_optimization',
    'scanner:cross-source',
  );

  let outcome: CrossSourceOutcome = {
    runId,
    sourcesScanned: 0,
    sourcesFetched: 0,
    sourcesAligned: 0,
    sourcesDrifted: 0,
    sourcesDivergent: 0,
    awardsVerified: 0,
    awardsUnverified: 0,
    ticketsOpened: 0,
    errors: [],
  };

  try {
    const [btv] = await db
      .select()
      .from(brandTruthVersions)
      .where(eq(brandTruthVersions.firm_id, firmId))
      .orderBy(desc(brandTruthVersions.version))
      .limit(1);
    if (!btv) throw new Error('Firm has no Brand Truth — create one first');
    const brandTruth = btv.payload as BrandTruth;

    const sources = gatherSources(brandTruth);
    outcome.sourcesScanned = sources.length;
    if (sources.length === 0) {
      // Nothing to do — operator hasn't curated any listings or award URLs.
      // Mark run completed so the UI doesn't spin forever.
      await db
        .update(auditRuns)
        .set({ status: 'completed', finished_at: new Date() })
        .where(eq(auditRuns.id, runId));
      return outcome;
    }

    // Fetch each source sequentially with a politeness gap. Capture errors
    // per-source so a single 404/cloudflare-block doesn't blow up the whole
    // scan.
    interface Fetched {
      candidate: CandidateSource;
      mainContent: string;
      title: string | null;
    }
    const fetched: Fetched[] = [];
    for (const c of sources) {
      try {
        const r = await fetchAndExtract(c.url);
        if (r.wordCount >= MIN_WORDS_TO_SCORE) {
          fetched.push({
            candidate: c,
            mainContent: r.mainContent,
            title: r.title,
          });
        } else {
          outcome.errors.push({
            url: c.url,
            error: `extracted ${r.wordCount} words (< ${MIN_WORDS_TO_SCORE} threshold)`,
          });
        }
      } catch (e) {
        outcome.errors.push({
          url: c.url,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      await new Promise((r) => setTimeout(r, POLITENESS_DELAY_MS));
    }
    outcome.sourcesFetched = fetched.length;

    if (fetched.length === 0) {
      // Every fetch errored — mark run completed but with no signals.
      await db
        .update(auditRuns)
        .set({
          status: 'completed',
          finished_at: new Date(),
          error: `all ${sources.length} fetches failed`,
        })
        .where(eq(auditRuns.id, runId));
      return outcome;
    }

    // Embed Brand Truth centroid + every fetched page in batch.
    const centroidText = brandTruthToText(brandTruth);
    const [centroidVec, pageVecs] = await Promise.all([
      embedSingle(centroidText),
      embedBatch(fetched.map((f) => f.mainContent)),
    ]);
    if (pageVecs.length !== fetched.length) {
      throw new Error(
        `embedding count mismatch: ${pageVecs.length} vs ${fetched.length}`,
      );
    }

    // Build name-presence checker for badge verification.
    const nameTokens: string[] = [
      brandTruth.firm_name,
      ...(brandTruth.name_variants ?? []),
    ]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .map((s) => s.toLowerCase());

    // Per-source: distance + (for awards) presence-check, then emit
    // entity_signal + (if needed) ticket.
    for (let i = 0; i < fetched.length; i++) {
      const f = fetched[i]!;
      const distance = semanticDistance(centroidVec, pageVecs[i]!);

      const flags: string[] = [];

      // Alignment classification.
      if (distance > DISTANCE_THRESHOLD_DIVERGENT) {
        flags.push('cross-source:divergent');
        outcome.sourcesDivergent += 1;
      } else if (distance > DISTANCE_THRESHOLD_DRIFT) {
        flags.push('cross-source:drift');
        outcome.sourcesDrifted += 1;
      } else {
        flags.push('cross-source:aligned');
        outcome.sourcesAligned += 1;
      }
      flags.push(`distance:${distance.toFixed(3)}`);

      // Badge verification — only for award sources.
      let badgeUnverified = false;
      if (f.candidate.kind === 'award') {
        const haystack = f.mainContent.toLowerCase();
        const found = nameTokens.some((tok) => haystack.includes(tok));
        if (found) {
          flags.push('badge:verified');
          outcome.awardsVerified += 1;
        } else {
          flags.push('badge:unverified');
          outcome.awardsUnverified += 1;
          badgeUnverified = true;
        }
        if (f.candidate.awardName) {
          flags.push(`award:${f.candidate.awardName.slice(0, 60)}`);
        }
      }

      const [signal] = await db
        .insert(entitySignals)
        .values({
          firm_id: firmId,
          source: f.candidate.source,
          url: f.candidate.url,
          verified_at: new Date(),
          divergence_flags: flags,
        })
        .returning({ id: entitySignals.id });

      // Ticket policy:
      //   divergent listing → 14d ticket (operator updates listing via
      //                                  platform's own form)
      //   unverified award  → 30d ticket (editorial check + possibly
      //                                  removing the award from BT)
      //   drift / aligned   → no ticket (informational)
      const wantsTicket =
        distance > DISTANCE_THRESHOLD_DIVERGENT || badgeUnverified;
      if (wantsTicket && signal) {
        const dueDays = badgeUnverified ? 30 : 14;
        const playbookStep = badgeUnverified
          ? `entity:cross-source:badge-unverified:${f.candidate.source}`
          : `entity:cross-source:divergent:${f.candidate.source}`;
        await db.insert(remediationTickets).values({
          firm_id: firmId,
          source_type: 'entity',
          source_id: signal.id,
          sop_run_id: sopRunId,
          status: 'open',
          playbook_step: playbookStep,
          due_at: new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000),
        });
        outcome.ticketsOpened += 1;
      }
    }

    await db
      .update(auditRuns)
      .set({ status: 'completed', finished_at: new Date() })
      .where(eq(auditRuns.id, runId));
  } catch (err) {
    await db
      .update(auditRuns)
      .set({
        status: 'failed',
        finished_at: new Date(),
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(auditRuns.id, runId));
    outcome.errors.push({
      url: '(orchestrator)',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return outcome;
}
