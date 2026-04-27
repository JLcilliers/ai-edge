import { getDb } from '@ai-edge/db';
import { sql } from 'drizzle-orm';
import { isAuthorizedCronRequest, unauthorizedResponse } from '../../../lib/cron/auth';

/**
 * One-shot migration runner for the Search Console schema (0010_gsc_connection).
 *
 * Same pattern as the earlier migrate-scenario-lab one-shot: we don't have
 * direct DB access from a clean checkout (Vercel/Neon Marketplace doesn't
 * expose DATABASE_URL outside the runtime), so this route applies the
 * 0010 SQL server-side, gated by CRON_SECRET. Idempotent — every CREATE
 * uses IF NOT EXISTS and the FK ALTERs catch duplicate_object.
 *
 * After the migration applies cleanly to prod, this route should be
 * removed in a follow-up PR (same pattern as the previous migrate +
 * cleanup admin scaffolding routes that were retired).
 *
 * Auth: same Authorization: Bearer $CRON_SECRET as every other admin
 * one-shot.
 */

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS "gsc_connection" (
	"firm_id" uuid PRIMARY KEY NOT NULL,
	"site_url" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"connected_by" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text
)`,
  `CREATE TABLE IF NOT EXISTS "gsc_daily_metric" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"date" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" real,
	"position" real,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
)`,
  `DO $$ BEGIN
 ALTER TABLE "gsc_connection" ADD CONSTRAINT "gsc_connection_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$`,
  `DO $$ BEGIN
 ALTER TABLE "gsc_daily_metric" ADD CONSTRAINT "gsc_daily_metric_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "gsc_daily_firm_date" ON "gsc_daily_metric" USING btree ("firm_id","date")`,
];

async function runMigration(req: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(req)) return unauthorizedResponse();

  const db = getDb();
  const results: Array<{ ok: boolean; statement: string; error?: string }> = [];
  for (const stmt of STATEMENTS) {
    const head = stmt.split('\n')[0]!.slice(0, 80);
    try {
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
  const allOk = results.every((r) => r.ok);
  console.log(`[admin:migrate-gsc] applied=${results.length} ok=${allOk}`);
  return Response.json(
    { ok: allOk, applied: results.length, results },
    { status: allOk ? 200 : 500 },
  );
}

export const POST = runMigration;
export const GET = runMigration;
