/**
 * Operator-experience research dump. Pure read queries — no inserts,
 * no updates, no scans. Run output goes into
 * tmp/operator-experience-research.md.
 *
 * Q1 — cross-firm ticket volume
 * Q2 — APL prioritization signal
 * Q4 — APL operator/firm/auto split + sample tickets
 *
 * Q3 is answered separately by reading dashboard route files.
 */
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
const _d = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolvePath(_d, '../../../.env.local'), override: true });

import { getDb } from '@ai-edge/db';
import { sql } from 'drizzle-orm';

const APL_SLUG = 'andrew-pickett-law';
const OPEN_STATUSES = ['open', 'in_progress'] as const;

function section(title: string) {
  console.log('\n');
  console.log('================================================================');
  console.log(title);
  console.log('================================================================');
}

async function main() {
  const db = getDb();

  // ── Q1 ─────────────────────────────────────────────────────
  section('Q1.1 — Open tickets per firm (desc)');
  const perFirm = await db.execute<{ slug: string; name: string; open_n: bigint }>(sql`
    SELECT f.slug, f.name, COUNT(*)::bigint AS open_n
      FROM remediation_ticket t
      JOIN firm f ON f.id = t.firm_id
     WHERE t.status IN ('open','in_progress')
  GROUP BY f.slug, f.name
  ORDER BY open_n DESC`);
  console.log('slug                                    n');
  for (const r of perFirm.rows ?? []) {
    console.log(`${r.slug.padEnd(38)} ${String(r.open_n).padStart(5)}  ${r.name}`);
  }

  section('Q1.1b — Buckets: >50 / >100 / >200 open tickets');
  const buckets = await db.execute<{ tier: string; n: bigint }>(sql`
    WITH t AS (
      SELECT firm_id, COUNT(*)::bigint AS n
        FROM remediation_ticket
       WHERE status IN ('open','in_progress')
    GROUP BY firm_id
    )
    SELECT 'firms_total' AS tier, COUNT(*)::bigint AS n FROM t
    UNION ALL SELECT 'firms_>50',  COUNT(*) FROM t WHERE n > 50
    UNION ALL SELECT 'firms_>100', COUNT(*) FROM t WHERE n > 100
    UNION ALL SELECT 'firms_>200', COUNT(*) FROM t WHERE n > 200
    UNION ALL SELECT 'firms_=0',   (SELECT COUNT(*)::bigint FROM firm) - COUNT(*) FROM t`);
  for (const r of buckets.rows ?? []) console.log(`  ${r.tier.padEnd(14)} ${String(r.n)}`);

  section('Q1.2 — Automation_tier × firm (top 10 firms by open count)');
  const tierByFirm = await db.execute<{
    slug: string; auto_n: bigint; assist_n: bigint; manual_n: bigint; null_n: bigint;
  }>(sql`
    WITH t AS (
      SELECT t.firm_id, t.automation_tier
        FROM remediation_ticket t
       WHERE t.status IN ('open','in_progress')
    ), agg AS (
      SELECT firm_id,
             COUNT(*) FILTER (WHERE automation_tier='auto')::bigint   AS auto_n,
             COUNT(*) FILTER (WHERE automation_tier='assist')::bigint AS assist_n,
             COUNT(*) FILTER (WHERE automation_tier='manual')::bigint AS manual_n,
             COUNT(*) FILTER (WHERE automation_tier IS NULL)::bigint  AS null_n,
             COUNT(*)::bigint AS total_n
        FROM t
    GROUP BY firm_id
    )
    SELECT f.slug, a.auto_n, a.assist_n, a.manual_n, a.null_n
      FROM agg a
      JOIN firm f ON f.id = a.firm_id
  ORDER BY a.total_n DESC
     LIMIT 10`);
  console.log('slug                                    auto  assist  manual  null');
  for (const r of tierByFirm.rows ?? []) {
    console.log(
      `${r.slug.padEnd(38)} ${String(r.auto_n).padStart(4)}  ${String(r.assist_n).padStart(6)}  ${String(r.manual_n).padStart(6)}  ${String(r.null_n).padStart(4)}`,
    );
  }

  section('Q1.3 — Top 5 firms × phase distribution');
  const topPhase = await db.execute<{
    slug: string; phase: number | null; sop_key: string | null; n: bigint;
  }>(sql`
    WITH top5 AS (
      SELECT t.firm_id, f.slug, COUNT(*) AS open_n
        FROM remediation_ticket t
        JOIN firm f ON f.id = t.firm_id
       WHERE t.status IN ('open','in_progress')
    GROUP BY t.firm_id, f.slug
    ORDER BY open_n DESC
       LIMIT 5
    )
    SELECT top5.slug, sr.phase, sr.sop_key, COUNT(*)::bigint AS n
      FROM remediation_ticket t
      JOIN top5 ON top5.firm_id = t.firm_id
 LEFT JOIN sop_run sr ON sr.id = t.sop_run_id
     WHERE t.status IN ('open','in_progress')
  GROUP BY top5.slug, sr.phase, sr.sop_key
  ORDER BY top5.slug, sr.phase NULLS LAST, n DESC`);
  console.log('slug                                    phase  sop_key                              n');
  for (const r of topPhase.rows ?? []) {
    console.log(
      `${r.slug.padEnd(38)} ${String(r.phase ?? '∅').padStart(5)}  ${(r.sop_key ?? '(no sop_run)').padEnd(36)} ${String(r.n).padStart(4)}`,
    );
  }

  section('Q1.4 — Ticket age distribution');
  const age = await db.execute<{ tier: string; n: bigint }>(sql`
    SELECT '>7d'  AS tier, COUNT(*)::bigint AS n
      FROM remediation_ticket
     WHERE status IN ('open','in_progress')
       AND created_at < now() - interval '7 days'
    UNION ALL
    SELECT '>30d',  COUNT(*) FROM remediation_ticket
     WHERE status IN ('open','in_progress')
       AND created_at < now() - interval '30 days'
    UNION ALL
    SELECT '>90d',  COUNT(*) FROM remediation_ticket
     WHERE status IN ('open','in_progress')
       AND created_at < now() - interval '90 days'
    UNION ALL
    SELECT 'total_open', COUNT(*) FROM remediation_ticket
     WHERE status IN ('open','in_progress')`);
  for (const r of age.rows ?? []) console.log(`  ${r.tier.padEnd(12)} ${r.n}`);

  section('Q1.4b — Closed-ticket throughput (last 30 days)');
  const closed = await db.execute<{ slug: string; closed_n: bigint }>(sql`
    SELECT f.slug, COUNT(*)::bigint AS closed_n
      FROM remediation_ticket t
      JOIN firm f ON f.id = t.firm_id
     WHERE t.status IN ('completed','closed','done','resolved')
       AND t.created_at > now() - interval '30 days'
  GROUP BY f.slug
  ORDER BY closed_n DESC
     LIMIT 20`);
  if ((closed.rows ?? []).length === 0) {
    console.log('  (no closed tickets in last 30d)');
  } else {
    for (const r of closed.rows ?? []) console.log(`  ${r.slug.padEnd(40)} ${r.closed_n}`);
  }

  section('Q1.4c — All status values present');
  const statuses = await db.execute<{ status: string; n: bigint }>(sql`
    SELECT status, COUNT(*)::bigint AS n
      FROM remediation_ticket
  GROUP BY status
  ORDER BY n DESC`);
  for (const r of statuses.rows ?? []) console.log(`  ${r.status.padEnd(16)} ${r.n}`);

  // ── Q2 ─────────────────────────────────────────────────────
  section('Q2.1 — APL priority_rank set vs null + distribution');
  const aplPriority = await db.execute<{ tier: string; n: bigint }>(sql`
    SELECT CASE
             WHEN priority_rank IS NULL THEN 'null'
             ELSE 'rank_' || priority_rank::text
           END AS tier,
           COUNT(*)::bigint AS n
      FROM remediation_ticket t
      JOIN firm f ON f.id = t.firm_id
     WHERE f.slug = ${APL_SLUG}
       AND t.status IN ('open','in_progress')
  GROUP BY 1
  ORDER BY 1`);
  for (const r of aplPriority.rows ?? []) console.log(`  ${r.tier.padEnd(10)} ${r.n}`);

  section('Q2.2 — APL tickets carrying click/traffic data');
  const aplTraffic = await db.execute<{ kind: string; n: bigint }>(sql`
    WITH apl AS (
      SELECT t.id, t.description, t.remediation_copy, t.evidence_links
        FROM remediation_ticket t
        JOIN firm f ON f.id = t.firm_id
       WHERE f.slug = ${APL_SLUG}
         AND t.status IN ('open','in_progress')
    )
    SELECT 'desc_mentions_clicks' AS kind, COUNT(*) FILTER (WHERE description ~* 'click')::bigint AS n FROM apl
    UNION ALL SELECT 'desc_mentions_gsc',     COUNT(*) FILTER (WHERE description ~* 'gsc|search console') FROM apl
    UNION ALL SELECT 'remed_mentions_clicks', COUNT(*) FILTER (WHERE remediation_copy ~* 'clicks/mo') FROM apl
    UNION ALL SELECT 'has_evidence_links',    COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(evidence_links,'[]'::jsonb)) > 0) FROM apl
    UNION ALL SELECT 'total',                 COUNT(*) FROM apl`);
  for (const r of aplTraffic.rows ?? []) console.log(`  ${r.kind.padEnd(24)} ${r.n}`);

  section('Q2.3 — APL factual/accuracy vs generic-drift markers');
  const aplKind = await db.execute<{ kind: string; n: bigint }>(sql`
    WITH apl AS (
      SELECT t.id, t.title, t.description, t.source_type, t.playbook_step
        FROM remediation_ticket t
        JOIN firm f ON f.id = t.firm_id
       WHERE f.slug = ${APL_SLUG}
         AND t.status IN ('open','in_progress')
    )
    SELECT 'title_factual_or_incorrect' AS kind, COUNT(*) FILTER (WHERE title ~* 'incorrect|factual|wrong')::bigint FROM apl
    UNION ALL SELECT 'title_didnt_mention',           COUNT(*) FILTER (WHERE title ~* 'didn''t mention|did not mention') FROM apl
    UNION ALL SELECT 'title_positioning_off',         COUNT(*) FILTER (WHERE title ~* 'positioning off') FROM apl
    UNION ALL SELECT 'title_reposition',              COUNT(*) FILTER (WHERE title ~* '^reposition') FROM apl
    UNION ALL SELECT 'title_no_index',                COUNT(*) FILTER (WHERE title ~* '^no-index') FROM apl
    UNION ALL SELECT 'title_redirect_or_delete',      COUNT(*) FILTER (WHERE title ~* '^redirect|^delete') FROM apl
    UNION ALL SELECT 'source_type:audit',             COUNT(*) FILTER (WHERE source_type='audit') FROM apl
    UNION ALL SELECT 'source_type:legacy',            COUNT(*) FILTER (WHERE source_type='legacy') FROM apl
    UNION ALL SELECT 'source_type:entity',            COUNT(*) FILTER (WHERE source_type='entity') FROM apl
    UNION ALL SELECT 'source_type:reddit',            COUNT(*) FILTER (WHERE source_type='reddit') FROM apl
    UNION ALL SELECT 'source_type:sop',               COUNT(*) FILTER (WHERE source_type='sop') FROM apl
    UNION ALL SELECT 'total',                         COUNT(*) FROM apl`);
  for (const r of aplKind.rows ?? []) console.log(`  ${r.kind.padEnd(34)} ${r.n}`);

  section('Q2.4 — APL repositioning (rewrite/keep_update) tickets — sub-distinguishers');
  const reposSub = await db.execute<{
    action: string; n: bigint; min_d: number; max_d: number; avg_d: number;
    avg_wc: number | null;
  }>(sql`
    SELECT lf.action, COUNT(*)::bigint AS n,
           MIN(lf.semantic_distance)::float AS min_d,
           MAX(lf.semantic_distance)::float AS max_d,
           AVG(lf.semantic_distance)::float AS avg_d,
           AVG(p.word_count)::float AS avg_wc
      FROM remediation_ticket t
      JOIN firm f ON f.id = t.firm_id
      JOIN legacy_finding lf ON lf.id = t.source_id
      JOIN page p ON p.id = lf.page_id
     WHERE f.slug = ${APL_SLUG}
       AND t.source_type = 'legacy'
       AND lf.action IN ('rewrite','keep_update')
       AND t.status IN ('open','in_progress')
  GROUP BY lf.action
  ORDER BY lf.action`);
  for (const r of reposSub.rows ?? []) {
    console.log(
      `  ${r.action.padEnd(14)} n=${r.n}  d∈[${r.min_d.toFixed(2)}, ${r.max_d.toFixed(2)}] avg=${r.avg_d.toFixed(2)}  avg_words=${r.avg_wc?.toFixed(0) ?? '∅'}`,
    );
  }

  section('Q2.4b — Repositioning distance histogram (10 bins)');
  const histo = await db.execute<{ bin: string; n: bigint }>(sql`
    WITH apl AS (
      SELECT lf.semantic_distance::float AS d
        FROM remediation_ticket t
        JOIN firm f ON f.id = t.firm_id
        JOIN legacy_finding lf ON lf.id = t.source_id
       WHERE f.slug = ${APL_SLUG}
         AND lf.action IN ('rewrite','keep_update')
         AND t.status IN ('open','in_progress')
    )
    SELECT WIDTH_BUCKET(d, 0.40, 0.70, 6)::text AS bin, COUNT(*)::bigint AS n
      FROM apl
  GROUP BY 1
  ORDER BY 1`);
  for (const r of histo.rows ?? []) console.log(`  bin_${r.bin}  ${r.n}`);

  // ── Q4 ─────────────────────────────────────────────────────
  section('Q4.1 — APL automation_tier breakdown');
  const aplTier = await db.execute<{ tier: string; n: bigint }>(sql`
    SELECT COALESCE(automation_tier,'(null)') AS tier, COUNT(*)::bigint AS n
      FROM remediation_ticket t
      JOIN firm f ON f.id = t.firm_id
     WHERE f.slug = ${APL_SLUG}
       AND t.status IN ('open','in_progress')
  GROUP BY 1
  ORDER BY n DESC`);
  for (const r of aplTier.rows ?? []) console.log(`  ${r.tier.padEnd(10)} ${r.n}`);

  section('Q4.2 — APL: 10 sampled assist/manual tickets (title + tier + phase + rank)');
  const aplSample = await db.execute<{
    id: string; title: string; tier: string; phase: number | null; sop_key: string | null;
    rank: number | null; source_type: string; remediation_copy: string | null;
    validation_steps: unknown;
  }>(sql`
    SELECT t.id, t.title, t.automation_tier AS tier, sr.phase, sr.sop_key,
           t.priority_rank AS rank, t.source_type, t.remediation_copy,
           t.validation_steps
      FROM remediation_ticket t
      JOIN firm f ON f.id = t.firm_id
 LEFT JOIN sop_run sr ON sr.id = t.sop_run_id
     WHERE f.slug = ${APL_SLUG}
       AND t.status IN ('open','in_progress')
       AND t.automation_tier IN ('assist','manual')
  ORDER BY random()
     LIMIT 10`);
  for (const r of aplSample.rows ?? []) {
    const valSteps = Array.isArray(r.validation_steps)
      ? (r.validation_steps as Array<{ description: string }>).map((v) => v.description).slice(0, 3)
      : [];
    console.log(`\n  · [${r.tier} | phase ${r.phase ?? '?'} | ${r.sop_key ?? 'no-sop'} | rank ${r.rank ?? '∅'}] ${(r.title ?? '(no title)').slice(0, 90)}`);
    console.log(`    source_type=${r.source_type}`);
    console.log(`    rem snippet: ${(r.remediation_copy ?? '').slice(0, 220).replace(/\n/g, ' ⏎ ')}`);
    console.log(`    validation: ${valSteps.join(' | ').slice(0, 220)}`);
  }

  section('Q4.3 — Export module: presence + invocation telemetry');
  // The export module from PR #86 was build-audit-delivery.ts. Look for
  // any persisted sop_deliverable rows in 'audit_delivery_pdf' or
  // related kinds, and any audit_log / event_log table presence.
  const deliverables = await db.execute<{ kind: string; n: bigint; latest: string | null }>(sql`
    SELECT kind, COUNT(*)::bigint AS n, MAX(generated_at)::text AS latest
      FROM sop_deliverable
  GROUP BY kind
  ORDER BY n DESC`);
  for (const r of deliverables.rows ?? []) {
    console.log(`  ${r.kind.padEnd(34)} n=${r.n}  latest=${r.latest ?? '∅'}`);
  }

  section('Q4.3b — Any audit / event / activity log table?');
  const tableHunt = await db.execute<{ table_name: string }>(sql`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema='public'
       AND (table_name ILIKE '%audit_log%' OR
            table_name ILIKE '%event%' OR
            table_name ILIKE '%activity%' OR
            table_name ILIKE '%log%')
  ORDER BY table_name`);
  if ((tableHunt.rows ?? []).length === 0) console.log('  (no log/event/activity tables)');
  else for (const r of tableHunt.rows ?? []) console.log(`  ${r.table_name}`);

  section('Q4.3c — Closed/completed APL tickets timestamps (last 90d)');
  const aplClosed = await db.execute<{ status: string; closed_at: string; n: bigint }>(sql`
    SELECT t.status, DATE(t.created_at)::text AS closed_at, COUNT(*)::bigint AS n
      FROM remediation_ticket t
      JOIN firm f ON f.id = t.firm_id
     WHERE f.slug = ${APL_SLUG}
       AND t.status NOT IN ('open','in_progress')
       AND t.created_at > now() - interval '90 days'
  GROUP BY 1, 2
  ORDER BY closed_at DESC
     LIMIT 30`);
  if ((aplClosed.rows ?? []).length === 0) console.log('  (no closed APL tickets in last 90d)');
  else for (const r of aplClosed.rows ?? []) console.log(`  ${r.closed_at}  ${r.status.padEnd(12)} ${r.n}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
