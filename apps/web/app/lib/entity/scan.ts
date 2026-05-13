import {
  getDb,
  auditRuns,
  entitySignals,
  brandTruthVersions,
  remediationTickets,
} from '@ai-edge/db';
import type { BrandTruth, FirmType } from '@ai-edge/shared';
import { eq, desc } from 'drizzle-orm';
import { scanJsonLd, diffExpectedTypes } from './schema-scan';
import { probeWikidata, probeGoogleKg } from './kg-probe';
import { ensureSopRun } from '../sop/ensure-run';
import { prescribeEntityTicket } from '../sop/legacy-prescription';
import { computePriority } from '../sop/priority-score';

/**
 * Map the entity scanner's playbook_step string (e.g. 'entity:wikidata:create',
 * 'entity:google-kg:claim', 'entity:schema:Person') to the PLATFORM_PRIORITY
 * key in lib/sop/priority-score.ts. Unknown shapes return '' which the
 * priority function treats as offset 0.
 */
function divergenceKindFromPlaybookStep(step: string): string {
  if (step.startsWith('entity:wikidata:create')) return 'wikidata_create';
  if (step.startsWith('entity:wikidata:update')) return 'wikidata_update';
  if (step.startsWith('entity:google-kg:claim')) return 'google_kg_claim';
  if (step.startsWith('entity:schema:')) return 'schema_add';
  if (step.includes('cross-source:divergent')) return 'third_party_listing_diverges';
  if (step.includes('badge-unverified')) return 'badge_unverified';
  return '';
}

/**
 * Entity-signals orchestrator (PLAN §5.6).
 *
 * One scan per firm:
 *   1. Create auditRun(kind='entity').
 *   2. Pull latest Brand Truth; resolve firm site URL.
 *   3. In parallel: fetch + parse home-page JSON-LD, probe Wikidata,
 *      probe Google KG (if key configured).
 *   4. Persist:
 *      - one entity_signals row per source ('website', 'wikidata', 'google-kg'),
 *        with `divergence_flags` carrying finding codes.
 *      - a remediation_ticket for each missing-required-schema-type OR when
 *        no KG entity was found.
 *
 * Non-goals for V1 (documented so operators know the edge):
 *   - Third-party directory parity (BBB/Avvo/SuperLawyers). Those need
 *     authenticated scraping or commercial feeds; deferred to v2.
 *   - JS-rendered JSON-LD. We fetch the raw HTML; pages that inject schema
 *     client-side won't register. If that becomes a problem, we lift the
 *     Playwright path we already have in the Python worker into this flow.
 *   - Trust-badge verification (ImageObject creator / acquireLicensePage).
 *     This is easy to add once we know which badges each firm claims —
 *     hook into Brand Truth `awards[]` and inspect `<img>` metadata.
 */

export async function runEntityScan(firmId: string): Promise<string> {
  const db = getDb();

  const [run] = await db
    .insert(auditRuns)
    .values({
      firm_id: firmId,
      kind: 'entity',
      status: 'running',
      started_at: new Date(),
    })
    .returning({ id: auditRuns.id });

  const runId = run!.id;

  // Resolve the Entity Optimization sop_run up-front so every ticket
  // emitted below attaches to it. See lib/sop/ensure-run.ts for why.
  const sopRunId = await ensureSopRun(
    firmId,
    'entity_optimization',
    'scanner:entity',
  );

  try {
    const [btv] = await db
      .select()
      .from(brandTruthVersions)
      .where(eq(brandTruthVersions.firm_id, firmId))
      .orderBy(desc(brandTruthVersions.version))
      .limit(1);

    if (!btv) {
      throw new Error('Firm has no Brand Truth — create one before running entity scan');
    }
    const brandTruth = btv.payload as BrandTruth;
    const firmType = brandTruth.firm_type as FirmType;

    // Same URL-resolution heuristic as the suppression scan. BrandTruth
    // schema is deliberately loose here because multiple historical payloads
    // shape this field differently.
    const bt = brandTruth as Record<string, unknown>;
    const siteUrl =
      [bt.primary_url, bt.website, bt.homepage_url].find(
        (v): v is string => typeof v === 'string' && /^https?:\/\//i.test(v),
      ) ?? null;

    // Run all three probes concurrently — the Wikidata/KG probes are
    // independent of the site fetch, so there's no reason to serialize.
    const [schemaResult, wikidataResult, googleKgResult] = await Promise.all([
      siteUrl
        ? scanJsonLd(siteUrl)
        : Promise.resolve({
            url: '',
            typesFound: [] as string[],
            fetchBlocked: false,
            httpStatus: null,
            blocks: [] as Array<{ type: string; raw: unknown }>,
            errors: ['no primary_url on Brand Truth — skipped home-page scan'],
          }),
      probeWikidata(brandTruth.firm_name),
      probeGoogleKg(brandTruth.firm_name),
    ]);

    // ── Persist website (schema.org) signal ──────────────────
    // When the page fetch was blocked (WAF / 4xx / network failure) we
    // genuinely don't know what schema is on the page. Don't write
    // `schema:missing_X` flags for types we never had a chance to look for —
    // that would tell the operator to add Organization markup to a homepage
    // where it already exists, and would open a remediation ticket the
    // operator can't actually resolve. Instead emit a single
    // `schema:fetch_blocked:<httpStatus>` flag so the dashboard can render
    // an "inconclusive — homepage couldn't be reached" state. The proper
    // fix for these sites is the Playwright + residential-proxy worker
    // path per ADR-0010, not a content change.
    const websiteFlags: string[] = [];
    if (schemaResult.fetchBlocked) {
      const status = schemaResult.httpStatus ?? 'network-error';
      websiteFlags.push(`schema:fetch_blocked:${status}`);
      websiteFlags.push(...schemaResult.errors.map((e) => `error:${e.slice(0, 80)}`));
    } else {
      const typeDiff = diffExpectedTypes(firmType, schemaResult.typesFound);
      websiteFlags.push(
        ...typeDiff.missingRequired.map((t) => `schema:missing_${t}`),
        ...typeDiff.missingRecommended.map((t) => `schema:recommended_${t}`),
        ...typeDiff.presentRequired.map((t) => `schema:present_${t}`),
        ...schemaResult.errors.map((e) => `error:${e.slice(0, 80)}`),
      );
    }

    await db.insert(entitySignals).values({
      firm_id: firmId,
      source: 'website',
      url: siteUrl,
      verified_at: new Date(),
      divergence_flags: websiteFlags,
    });

    // ── Persist Wikidata probe ────────────────────────────────
    const wdFlags: string[] = [];
    if (wikidataResult.hits.length === 0) {
      wdFlags.push('kg:missing');
    } else if (wikidataResult.hits.length === 1) {
      wdFlags.push(`kg:present:${wikidataResult.hits[0]!.id}`);
    } else {
      // Multiple hits = ambiguity. The operator needs to claim the right
      // one; we can't auto-resolve without more signal (headquarters
      // city, services) embedded in each hit.
      wdFlags.push(
        `kg:ambiguous:${wikidataResult.hits.map((h) => h.id).slice(0, 3).join(',')}`,
      );
    }
    if (wikidataResult.error) {
      wdFlags.push(`error:${wikidataResult.error.slice(0, 80)}`);
    }

    await db.insert(entitySignals).values({
      firm_id: firmId,
      source: 'wikidata',
      url: wikidataResult.hits[0]?.url ?? null,
      verified_at: new Date(),
      divergence_flags: wdFlags,
    });

    // ── Persist Google KG probe ───────────────────────────────
    const kgFlags: string[] = [];
    if (googleKgResult.error?.includes('not configured')) {
      kgFlags.push('kg:skipped_no_key');
    } else if (googleKgResult.hits.length === 0) {
      kgFlags.push('kg:missing');
    } else {
      kgFlags.push(`kg:present:${googleKgResult.hits[0]!.id || googleKgResult.hits[0]!.label}`);
    }
    if (googleKgResult.error && !googleKgResult.error.includes('not configured')) {
      kgFlags.push(`error:${googleKgResult.error.slice(0, 80)}`);
    }

    await db.insert(entitySignals).values({
      firm_id: firmId,
      source: 'google-kg',
      url: googleKgResult.hits[0]?.url ?? null,
      verified_at: new Date(),
      divergence_flags: kgFlags,
    });

    // ── Remediation tickets ───────────────────────────────────
    // Only open tickets for *required* schema gaps and for KG absence —
    // recommended gaps are additive and don't deserve their own queue entry
    // (the UI will still surface them as "nice to have").
    //
    // Ticket due dates: 14d for schema fixes (pure content change), 30d for
    // KG / Wikidata (editorial workflow with external approval latency).
    const tickets: Array<{
      playbook_step: string;
      due_days: number;
      source_id: string; // we reuse the auditRun id for MVP since entitySignals can have many rows per run
    }> = [];

    // Skip the missing-schema ticket when the homepage fetch was blocked —
    // we don't actually know what schema is on the page, and the operator
    // can't fix a "missing schema" ticket whose root cause is "WAF blocked
    // our crawler". The fetch-blocked state is already surfaced via
    // `schema:fetch_blocked:<status>` in entity_signals; ops can act on it
    // by reaching for the residential-proxy path (ADR-0010) rather than
    // editing site markup.
    if (!schemaResult.fetchBlocked) {
      const typeDiff = diffExpectedTypes(firmType, schemaResult.typesFound);
      if (typeDiff.missingRequired.length > 0) {
        tickets.push({
          playbook_step: `entity:schema:${typeDiff.missingRequired.join(',')}`,
          due_days: 14,
          source_id: runId,
        });
      }
    }

    if (wikidataResult.hits.length === 0) {
      tickets.push({
        playbook_step: 'entity:wikidata:create',
        due_days: 30,
        source_id: runId,
      });
    }

    if (googleKgResult.hits.length === 0 && !googleKgResult.error?.includes('not configured')) {
      tickets.push({
        playbook_step: 'entity:google-kg:claim',
        due_days: 30,
        source_id: runId,
      });
    }

    for (const t of tickets) {
      // Derive source label from the playbook_step prefix so the
      // prescription helper can compose a meaningful title.
      //   entity:wikidata:create     → wikidata
      //   entity:google-kg:claim     → gbp
      //   entity:schema:Person       → website
      const source = t.playbook_step.startsWith('entity:wikidata')
        ? 'wikidata'
        : t.playbook_step.startsWith('entity:google-kg')
          ? 'gbp'
          : t.playbook_step.startsWith('entity:schema')
            ? 'website'
            : 'entity';
      const presc = prescribeEntityTicket({
        source,
        url: null,
        divergenceFlags: [],
        playbookStep: t.playbook_step,
      });
      const { priorityClass, priorityScore } = computePriority({
        sourceType: 'entity',
        sopKey: 'entity_optimization',
        entityDivergenceKind: divergenceKindFromPlaybookStep(t.playbook_step),
      });
      await db.insert(remediationTickets).values({
        firm_id: firmId,
        source_type: 'entity',
        source_id: t.source_id,
        sop_run_id: sopRunId,
        status: 'open',
        playbook_step: t.playbook_step,
        due_at: new Date(Date.now() + t.due_days * 24 * 60 * 60 * 1000),
        title: presc.title,
        description: presc.description,
        priority_rank: presc.priorityRank,
        priority_class: priorityClass,
        priority_score: priorityScore,
        remediation_copy: presc.remediationCopy,
        validation_steps: presc.validationSteps,
        evidence_links: presc.evidenceLinks,
        automation_tier: presc.automationTier,
        execute_url: presc.executeUrl,
        execute_label: presc.executeLabel,
      });
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
        error: String(err),
      })
      .where(eq(auditRuns.id, runId));
  }

  return runId;
}
