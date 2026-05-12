/**
 * One-shot backfill: populate prescription-layer fields (title,
 * description, remediation_copy, automation_tier, execute_url,
 * validation_steps, evidence_links, priority_rank) on existing
 * remediation_ticket rows that the legacy scanner code paths inserted
 * before they were patched to do it themselves.
 *
 * Counterpart to the code patches in this PR — together they fix both
 * the historical rows and the future-write path. Uses the same
 * prescription helpers from lib/sop/legacy-prescription.ts so the
 * historical rows end up identical to what the patched scanners
 * produce going forward.
 *
 * Per source_type, joins to the backing row:
 *   audit   → alignment_score → consensus_response → query
 *   legacy  → legacy_finding → page
 *   entity  → entity_signal (when source_id resolves; else derive from
 *             playbook_step)
 *   reddit  → reddit_mention
 *
 * Idempotent. Skips tickets that already have a title (= already
 * prescribed). Safe to re-run.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-legacy-ticket-prescription.ts
 *   pnpm exec tsx scripts/backfill-legacy-ticket-prescription.ts --dry-run
 *   pnpm exec tsx scripts/backfill-legacy-ticket-prescription.ts --slug andrew-pickett-law
 */

import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
const _d = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolvePath(_d, '../../../.env.local'), override: true });

import { getDb, firms, remediationTickets } from '@ai-edge/db';
import { eq, sql } from 'drizzle-orm';
import {
  prescribeAuditTicket,
  prescribeLegacyTicket,
  prescribeEntityTicket,
  prescribeRedditTicket,
  type TicketPrescription,
} from '../app/lib/sop/legacy-prescription';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SLUG_FILTER = (() => {
  const i = args.indexOf('--slug');
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
})();

let totalUpdated = 0;
let totalSkipped = 0;
let totalFailed = 0;

async function main() {
  const db = getDb();
  let firmId: string | null = null;
  if (SLUG_FILTER) {
    const [f] = await db
      .select({ id: firms.id })
      .from(firms)
      .where(eq(firms.slug, SLUG_FILTER))
      .limit(1);
    if (!f) {
      console.error(`Firm not found: ${SLUG_FILTER}`);
      process.exit(2);
    }
    firmId = f.id;
  }

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Scanning for legacy tickets without prescription...`);
  if (firmId) console.log(`  scoped to firm: ${SLUG_FILTER}`);

  await processAudit(db, firmId);
  await processLegacy(db, firmId);
  await processEntity(db, firmId);
  await processReddit(db, firmId);

  console.log(
    `\nSummary: ${DRY_RUN ? '(dry run) ' : ''}updated=${totalUpdated} skipped=${totalSkipped} failed=${totalFailed}`,
  );
  if (totalFailed > 0) process.exit(1);
}

/** Build a firm-id WHERE clause fragment; empty when firmId is null. */
function firmClause(firmId: string | null) {
  return firmId ? sql`AND t.firm_id = ${firmId}` : sql``;
}

async function processAudit(db: ReturnType<typeof getDb>, firmId: string | null): Promise<void> {
  const rows = await db.execute<{
    ticket_id: string;
    query_text: string;
    rag_label: string;
    gap_reasons: unknown;
    factual_errors: unknown;
    citations: unknown;
    mentioned: boolean;
    provider: string;
  }>(
    sql`
      SELECT
        t.id AS ticket_id,
        q.text AS query_text,
        a.rag_label,
        a.gap_reasons,
        a.factual_errors,
        -- citations live on a separate table joined to consensus_response;
        -- aggregate up to N URLs per consensus to keep the payload bounded.
        COALESCE(
          (SELECT jsonb_agg(c.url ORDER BY c.rank NULLS LAST)
           FROM citation c
           WHERE c.consensus_response_id = cr.id),
          '[]'::jsonb
        ) AS citations,
        cr.mentioned,
        -- pick a representative provider — one model_response under this consensus.
        -- model_response is joined to query, not consensus, so go via cr.query_id.
        COALESCE(
          (SELECT mr.provider FROM model_response mr WHERE mr.query_id = cr.query_id LIMIT 1),
          'unknown'
        ) AS provider
      FROM remediation_ticket t
      INNER JOIN alignment_score a ON a.id = t.source_id
      INNER JOIN consensus_response cr ON cr.id = a.consensus_response_id
      INNER JOIN query q ON q.id = cr.query_id
      WHERE t.source_type = 'audit'
        AND (t.title IS NULL OR t.title = '')
        ${firmClause(firmId)}
    `,
  );

  console.log(`\n── source_type='audit': ${(rows.rows ?? []).length} rows to prescribe ──`);
  for (const row of rows.rows ?? []) {
    try {
      const presc = prescribeAuditTicket({
        queryText: row.query_text,
        provider: row.provider,
        ragLabel: (row.rag_label ?? 'red') as 'red' | 'yellow' | 'green',
        gapReasons: Array.isArray(row.gap_reasons) ? (row.gap_reasons as string[]) : [],
        factualErrors: Array.isArray(row.factual_errors) ? (row.factual_errors as string[]) : [],
        citations: Array.isArray(row.citations) ? (row.citations as string[]) : [],
        mentioned: Boolean(row.mentioned),
      });
      if (DRY_RUN) {
        console.log(`  [DRY] ${row.ticket_id.slice(0, 8)} → "${presc.title.slice(0, 70)}"`);
      } else {
        await applyPrescription(db, row.ticket_id, presc);
      }
      totalUpdated += 1;
    } catch (e) {
      console.log(`  ! ${row.ticket_id.slice(0, 8)} audit prescribe failed: ${e instanceof Error ? e.message : e}`);
      totalFailed += 1;
    }
  }
}

async function processLegacy(db: ReturnType<typeof getDb>, firmId: string | null): Promise<void> {
  const rows = await db.execute<{
    ticket_id: string;
    page_url: string;
    page_title: string | null;
    word_count: number | null;
    action: string;
    rationale: string;
    semantic_distance: number;
  }>(
    sql`
      SELECT
        t.id AS ticket_id,
        p.url AS page_url,
        p.title AS page_title,
        p.word_count,
        lf.action,
        lf.rationale,
        lf.semantic_distance
      FROM remediation_ticket t
      INNER JOIN legacy_finding lf ON lf.id = t.source_id
      INNER JOIN page p ON p.id = lf.page_id
      WHERE t.source_type = 'legacy'
        AND (t.title IS NULL OR t.title = '')
        ${firmClause(firmId)}
    `,
  );

  console.log(`\n── source_type='legacy': ${(rows.rows ?? []).length} rows to prescribe ──`);
  for (const row of rows.rows ?? []) {
    try {
      const presc = prescribeLegacyTicket({
        pageUrl: row.page_url,
        pageTitle: row.page_title,
        wordCount: row.word_count,
        action: row.action,
        rationale: row.rationale,
        semanticDistance: Number(row.semantic_distance ?? 0),
      });
      if (DRY_RUN) {
        console.log(`  [DRY] ${row.ticket_id.slice(0, 8)} → "${presc.title.slice(0, 70)}"`);
      } else {
        await applyPrescription(db, row.ticket_id, presc);
      }
      totalUpdated += 1;
    } catch (e) {
      console.log(`  ! ${row.ticket_id.slice(0, 8)} legacy prescribe failed: ${e instanceof Error ? e.message : e}`);
      totalFailed += 1;
    }
  }
}

async function processEntity(db: ReturnType<typeof getDb>, firmId: string | null): Promise<void> {
  // Entity tickets are mixed-shape: some have source_id → entity_signal,
  // others have source_id → audit_run (runEntityScan used the audit_run.id
  // as source_id). LEFT JOIN entity_signal and fall back to playbook_step
  // parsing when the join misses.
  const rows = await db.execute<{
    ticket_id: string;
    playbook_step: string;
    source: string | null;
    url: string | null;
    divergence_flags: unknown;
  }>(
    sql`
      SELECT
        t.id AS ticket_id,
        t.playbook_step,
        es.source,
        es.url,
        es.divergence_flags
      FROM remediation_ticket t
      LEFT JOIN entity_signal es ON es.id = t.source_id
      WHERE t.source_type = 'entity'
        AND (t.title IS NULL OR t.title = '')
        ${firmClause(firmId)}
    `,
  );

  console.log(`\n── source_type='entity': ${(rows.rows ?? []).length} rows to prescribe ──`);
  for (const row of rows.rows ?? []) {
    try {
      const inferredSource = row.source ?? inferEntitySourceFromPlaybook(row.playbook_step);
      const presc = prescribeEntityTicket({
        source: inferredSource,
        url: row.url ?? null,
        divergenceFlags: Array.isArray(row.divergence_flags)
          ? (row.divergence_flags as string[])
          : [],
        playbookStep: row.playbook_step ?? 'entity:unknown',
      });
      if (DRY_RUN) {
        console.log(`  [DRY] ${row.ticket_id.slice(0, 8)} → "${presc.title.slice(0, 70)}"`);
      } else {
        await applyPrescription(db, row.ticket_id, presc);
      }
      totalUpdated += 1;
    } catch (e) {
      console.log(`  ! ${row.ticket_id.slice(0, 8)} entity prescribe failed: ${e instanceof Error ? e.message : e}`);
      totalFailed += 1;
    }
  }
}

function inferEntitySourceFromPlaybook(step: string | null): string {
  if (!step) return 'entity';
  if (step.startsWith('entity:wikidata')) return 'wikidata';
  if (step.startsWith('entity:google-kg')) return 'gbp';
  if (step.startsWith('entity:schema')) return 'website';
  if (step.includes('cross-source:')) {
    const m = step.match(/cross-source:(?:divergent|badge-unverified):(.+)$/);
    if (m && m[1]) return m[1];
  }
  return 'entity';
}

async function processReddit(db: ReturnType<typeof getDb>, firmId: string | null): Promise<void> {
  const rows = await db.execute<{
    ticket_id: string;
    subreddit: string;
    url: string;
    karma: number | null;
    sentiment: string | null;
    text: string | null;
    posted_at: Date | null;
  }>(
    sql`
      SELECT
        t.id AS ticket_id,
        rm.subreddit,
        rm.url,
        rm.karma,
        rm.sentiment,
        rm.text,
        rm.posted_at
      FROM remediation_ticket t
      INNER JOIN reddit_mention rm ON rm.id = t.source_id
      WHERE t.source_type = 'reddit'
        AND (t.title IS NULL OR t.title = '')
        ${firmClause(firmId)}
    `,
  );

  console.log(`\n── source_type='reddit': ${(rows.rows ?? []).length} rows to prescribe ──`);
  for (const row of rows.rows ?? []) {
    try {
      const presc = prescribeRedditTicket({
        subreddit: row.subreddit,
        threadUrl: row.url,
        karma: row.karma,
        sentiment: row.sentiment,
        text: row.text,
        postedAt: row.posted_at,
      });
      if (DRY_RUN) {
        console.log(`  [DRY] ${row.ticket_id.slice(0, 8)} → "${presc.title.slice(0, 70)}"`);
      } else {
        await applyPrescription(db, row.ticket_id, presc);
      }
      totalUpdated += 1;
    } catch (e) {
      console.log(`  ! ${row.ticket_id.slice(0, 8)} reddit prescribe failed: ${e instanceof Error ? e.message : e}`);
      totalFailed += 1;
    }
  }
}

async function applyPrescription(
  db: ReturnType<typeof getDb>,
  ticketId: string,
  presc: TicketPrescription,
): Promise<void> {
  await db
    .update(remediationTickets)
    .set({
      title: presc.title,
      description: presc.description,
      priority_rank: presc.priorityRank,
      remediation_copy: presc.remediationCopy,
      validation_steps: presc.validationSteps,
      evidence_links: presc.evidenceLinks,
      automation_tier: presc.automationTier,
      execute_url: presc.executeUrl,
      execute_label: presc.executeLabel,
      manual_reason: presc.manualReason,
    })
    .where(eq(remediationTickets.id, ticketId));
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
