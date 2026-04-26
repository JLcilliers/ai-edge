import { getDb } from '@ai-edge/db';
import { sql } from 'drizzle-orm';
import { isAuthorizedCronRequest, unauthorizedResponse } from '../../../lib/cron/auth';

/**
 * One-shot migration runner for the Scenario Lab schema (migration 0009).
 *
 * Vercel/Neon Marketplace doesn't auto-apply Drizzle migrations on deploy,
 * and the platform doesn't expose a build-time DB connection from a clean
 * checkout. This route lets an operator (or a Claude Code session) apply
 * 0009_scenario_lab.sql server-side, gated by the same CRON_SECRET we use
 * for cron auth.
 *
 * Idempotent: every CREATE / ALTER uses IF NOT EXISTS / DO $$ BEGIN ... END $$
 * with a duplicate_object catch, so re-running is a no-op once the schema
 * is in place. Safe to leave deployed; safer to remove in a follow-up PR
 * after the migration applies cleanly.
 *
 * Auth: same as crons — `Authorization: Bearer $CRON_SECRET` OR `?key=$secret`.
 */

// Each entry is one statement (sql split on Drizzle's --> statement-breakpoint
// markers, plus the journal entry insert at the end). Kept inline rather
// than read from disk so this route Just Works without bundler config.
const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS "serp_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"query" text NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"country" text,
	"language" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb,
	"notes" text
)`,
  `CREATE TABLE IF NOT EXISTS "serp_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"title" text,
	"snippet" text,
	"is_target" boolean DEFAULT false NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS "page_features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"page_id" uuid,
	"url" text NOT NULL,
	"features" jsonb NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS "ranker_weights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"weights" jsonb NOT NULL,
	"fitness" real NOT NULL,
	"observation_count" integer NOT NULL,
	"pso_params" jsonb,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS "scenario" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"baseline_url" text NOT NULL,
	"query" text NOT NULL,
	"description" text,
	"proposed_change" jsonb NOT NULL,
	"baseline_score" real,
	"proposed_score" real,
	"delta_score" real,
	"baseline_rank" integer,
	"proposed_rank" integer,
	"delta_rank" integer,
	"competitor_count" integer,
	"weights_generation_used" integer,
	"confidence_label" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recomputed_at" timestamp with time zone
)`,
  `DO $$ BEGIN
 ALTER TABLE "serp_snapshot" ADD CONSTRAINT "serp_snapshot_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$`,
  `DO $$ BEGIN
 ALTER TABLE "serp_result" ADD CONSTRAINT "serp_result_snapshot_id_serp_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "serp_snapshot"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$`,
  `DO $$ BEGIN
 ALTER TABLE "page_features" ADD CONSTRAINT "page_features_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$`,
  `DO $$ BEGIN
 ALTER TABLE "page_features" ADD CONSTRAINT "page_features_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$`,
  `DO $$ BEGIN
 ALTER TABLE "ranker_weights" ADD CONSTRAINT "ranker_weights_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$`,
  `DO $$ BEGIN
 ALTER TABLE "scenario" ADD CONSTRAINT "scenario_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$`,
  `CREATE INDEX IF NOT EXISTS "serp_snapshot_firm_query_idx" ON "serp_snapshot" USING btree ("firm_id","query")`,
  `CREATE INDEX IF NOT EXISTS "serp_result_snapshot_idx" ON "serp_result" USING btree ("snapshot_id")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "page_features_firm_url" ON "page_features" USING btree ("firm_id","url")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ranker_weights_firm_gen" ON "ranker_weights" USING btree ("firm_id","generation")`,
  `CREATE INDEX IF NOT EXISTS "scenario_firm_idx" ON "scenario" USING btree ("firm_id")`,
];

async function runMigration(req: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(req)) return unauthorizedResponse();

  const db = getDb();

  const results: Array<{ ok: boolean; statement: string; error?: string }> = [];
  for (const stmt of STATEMENTS) {
    const head = stmt.split('\n')[0]!.slice(0, 80);
    try {
      // sql.raw bypasses drizzle's parameter binding — necessary because
      // these are static DDL strings, not parameterized queries.
      await db.execute(sql.raw(stmt));
      results.push({ ok: true, statement: head });
    } catch (e) {
      results.push({
        ok: false,
        statement: head,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Verify tables exist.
  const tableCheck: Record<string, boolean> = {};
  try {
    const rows = (await db.execute(sql.raw(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('serp_snapshot','serp_result','page_features','ranker_weights','scenario')`,
    ))) as unknown as Array<{ table_name: string }>;
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of [
      'serp_snapshot',
      'serp_result',
      'page_features',
      'ranker_weights',
      'scenario',
    ]) {
      tableCheck[t] = names.has(t);
    }
  } catch {
    /* leave tableCheck empty so caller sees absence */
  }

  const allOk =
    results.every((r) => r.ok) &&
    Object.keys(tableCheck).length === 5 &&
    Object.values(tableCheck).every(Boolean);
  return Response.json(
    { ok: allOk, applied: results.length, results, tables: tableCheck },
    { status: allOk ? 200 : 500 },
  );
}

export const POST = runMigration;
export const GET = runMigration;
