/**
 * Backfill — recompute priority_class + priority_score for every
 * remediation_ticket using the current `computePriority()` formula.
 *
 * Idempotent: running twice produces the same result. Joins the
 * source-row data each scanner already persists (alignment_score,
 * legacy_finding, page, entity_signal, reddit_mention, sop_step_state)
 * and reconstructs the priority inputs from those rows. New tickets
 * emitted by scanners already carry the score at insert time; this
 * script is for (a) historical rows that pre-date the columns and
 * (b) policy changes (formula updates) that need to refresh stored
 * scores without re-running scanners.
 *
 * Usage:
 *   pnpm score:recompute            — process every open ticket
 *   pnpm score:recompute -- --all   — process every ticket (including closed)
 *   pnpm score:recompute -- --firm=<slug>  — limit to a single firm
 *
 * The script processes in batches; each ticket update is a single
 * UPDATE. Safe to interrupt — re-running picks up where it left off
 * (rows that already have the latest score get the same score on
 * recompute, so the writes are no-ops semantically).
 *
 * Migration: 0018 added the priority_class + priority_score columns.
 * Spec: tmp/priority-score-spec.md.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
const _d = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(_d, '../../../.env.local'), override: true });

import {
  getDb,
  remediationTickets,
  alignmentScores,
  legacyFindings,
  entitySignals,
  redditMentions,
  sopRuns,
  firms,
} from '@ai-edge/db';
import { eq, and, inArray } from 'drizzle-orm';
import { computePriority } from '../app/lib/sop/priority-score';

interface CliArgs {
  all: boolean;
  firmSlug: string | null;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let all = false;
  let dryRun = false;
  let firmSlug: string | null = null;
  for (const a of argv) {
    if (a === '--all') all = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a.startsWith('--firm=')) firmSlug = a.slice('--firm='.length);
  }
  return { all, firmSlug, dryRun };
}

/**
 * Pull every ticket + the joinable source data into one batch query.
 * The select shape is wide because computePriority needs different
 * inputs depending on source_type. NULLs are normal — most rows only
 * need the columns relevant to their own source_type.
 */
async function loadTicketsForBackfill(args: CliArgs) {
  const db = getDb();
  const conditions: ReturnType<typeof eq>[] = [];
  if (!args.all) conditions.push(inArray(remediationTickets.status, ['open', 'in_progress']));
  if (args.firmSlug) {
    const [firm] = await db
      .select({ id: firms.id })
      .from(firms)
      .where(eq(firms.slug, args.firmSlug))
      .limit(1);
    if (!firm) {
      console.error(`Firm not found: ${args.firmSlug}`);
      process.exit(1);
    }
    conditions.push(eq(remediationTickets.firm_id, firm.id));
  }

  // Single wide select with left-joins so a row with no matching
  // legacy_finding (audit ticket) still returns and gets sensible
  // null defaults from computePriority.
  const rows = await db
    .select({
      ticketId: remediationTickets.id,
      sourceType: remediationTickets.source_type,
      sourceId: remediationTickets.source_id,
      playbookStep: remediationTickets.playbook_step,
      currentClass: remediationTickets.priority_class,
      currentScore: remediationTickets.priority_score,
      sopKey: sopRuns.sop_key,
      // Audit signals
      auditFactualErrors: alignmentScores.factual_errors,
      auditMentioned: alignmentScores.mentioned,
      // Legacy signals
      legacyAction: legacyFindings.action,
      legacyDistance: legacyFindings.semantic_distance,
      // Entity signal (divergence_flags is an array — we'll pick from playbook_step too)
      entityDivergenceFlags: entitySignals.divergence_flags,
      entitySource: entitySignals.source,
      // Reddit signal
      redditSentiment: redditMentions.sentiment,
    })
    .from(remediationTickets)
    .leftJoin(sopRuns, eq(sopRuns.id, remediationTickets.sop_run_id))
    .leftJoin(
      alignmentScores,
      and(
        eq(remediationTickets.source_type, 'audit'),
        eq(alignmentScores.id, remediationTickets.source_id),
      ),
    )
    .leftJoin(
      legacyFindings,
      and(
        eq(remediationTickets.source_type, 'legacy'),
        eq(legacyFindings.id, remediationTickets.source_id),
      ),
    )
    .leftJoin(
      entitySignals,
      and(
        eq(remediationTickets.source_type, 'entity'),
        eq(entitySignals.id, remediationTickets.source_id),
      ),
    )
    .leftJoin(
      redditMentions,
      and(
        eq(remediationTickets.source_type, 'reddit'),
        eq(redditMentions.id, remediationTickets.source_id),
      ),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return rows;
}

/**
 * Map playbook_step strings (entity scanner format) to the
 * PLATFORM_PRIORITY enum key. Mirrors the helper in
 * lib/entity/scan.ts so the backfill produces the same scores as the
 * emit path.
 */
function divergenceKindFromPlaybookStep(step: string | null): string {
  if (!step) return '';
  if (step.startsWith('entity:wikidata:create')) return 'wikidata_create';
  if (step.startsWith('entity:wikidata:update')) return 'wikidata_update';
  if (step.startsWith('entity:google-kg:claim')) return 'google_kg_claim';
  if (step.startsWith('entity:schema:')) return 'schema_add';
  if (step.includes('cross-source:divergent')) return 'third_party_listing_diverges';
  if (step.includes('badge-unverified')) return 'badge_unverified';
  return '';
}

async function main() {
  const args = parseArgs();
  console.log('Score recompute backfill — args:', args);

  const rows = await loadTicketsForBackfill(args);
  console.log(`Loaded ${rows.length} tickets for recompute.`);

  const db = getDb();
  let updated = 0;
  let unchanged = 0;
  const byClass = new Map<string, number>();

  for (const r of rows) {
    // Reconstruct the priority inputs from the joined source data.
    const result = computePriority({
      sourceType: r.sourceType,
      sopKey: r.sopKey ?? undefined,
      auditHasFactualErrors:
        r.sourceType === 'audit'
          ? Array.isArray(r.auditFactualErrors) && r.auditFactualErrors.length > 0
          : undefined,
      auditMentioned:
        r.sourceType === 'audit' ? r.auditMentioned ?? undefined : undefined,
      // providerCount is not stored — defaults to 1 in computePriority.
      // The backfill leaves this conservatively at 1; live scanners
      // could supply higher counts when they consolidate.
      providerCount: 1,
      legacyAction: r.sourceType === 'legacy' ? r.legacyAction ?? undefined : undefined,
      semanticDistance:
        r.sourceType === 'legacy' && r.legacyDistance != null
          ? Number(r.legacyDistance)
          : undefined,
      // clicksPerMonth is not joinable from this view (gsc_url_metric
      // lookup is per-URL). Backfill omits it; emit path passes it
      // when GSC is connected. Backfilled rows fall through to the
      // distance-based content_drift offset.
      clicksPerMonth: undefined,
      // monthsDormant isn't stored as a column — freshness scanner
      // encodes age in ticket description. For backfill we leave it
      // undefined; the SOP-routing for content_freshness_audit
      // produces a score at the time_sensitive floor (500). Live
      // scanner runs supply the real months_dormant.
      monthsDormant: undefined,
      // rubricScore / rubricMax aren't stored on the ticket row.
      // Same logic: backfill produces the per_page_quality floor
      // (300), live scanner runs supply the real signals.
      rubricScore: undefined,
      rubricMax: undefined,
      // Entity divergence kind reconstructed from playbook_step.
      entityDivergenceKind:
        r.sourceType === 'entity'
          ? divergenceKindFromPlaybookStep(r.playbookStep)
          : undefined,
      redditIsComplaint:
        r.sourceType === 'reddit' ? r.redditSentiment === 'complaint' : undefined,
    });

    byClass.set(result.priorityClass, (byClass.get(result.priorityClass) ?? 0) + 1);

    // Idempotency: skip the UPDATE when both columns already match.
    if (r.currentClass === result.priorityClass && r.currentScore === result.priorityScore) {
      unchanged += 1;
      continue;
    }

    if (!args.dryRun) {
      await db
        .update(remediationTickets)
        .set({
          priority_class: result.priorityClass,
          priority_score: result.priorityScore,
        })
        .where(eq(remediationTickets.id, r.ticketId));
    }
    updated += 1;
  }

  console.log(`\nRecompute summary:`);
  console.log(`  updated:   ${updated}${args.dryRun ? ' (DRY RUN — no writes)' : ''}`);
  console.log(`  unchanged: ${unchanged}`);
  console.log(`  total:     ${rows.length}`);
  console.log(`\nDistribution by priority_class:`);
  const sortedClasses = [...byClass.entries()].sort((a, b) => b[1] - a[1]);
  for (const [cls, n] of sortedClasses) {
    console.log(`  ${cls.padEnd(20)} ${n}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
