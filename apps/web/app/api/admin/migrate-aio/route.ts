import { getDb } from '@ai-edge/db';
import { sql } from 'drizzle-orm';
import { isAuthorizedCronRequest, unauthorizedResponse } from '../../../lib/cron/auth';

/**
 * One-shot migration runner for the AIO capture schema (Phase B #7).
 *
 * Same idempotent pattern as migrate-scenario-lab and migrate-gsc.
 * Gated by CRON_SECRET. Should be removed once applied.
 */
const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS "aio_capture" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"query" text NOT NULL,
	"provider" text NOT NULL,
	"country" text,
	"language" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"has_aio" boolean DEFAULT false NOT NULL,
	"overview_text" text,
	"sources" jsonb DEFAULT '[]'::jsonb,
	"firm_cited" boolean DEFAULT false NOT NULL,
	"raw" jsonb
)`,
  `DO $$ BEGIN
 ALTER TABLE "aio_capture" ADD CONSTRAINT "aio_capture_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$`,
  `CREATE INDEX IF NOT EXISTS "aio_capture_firm_query" ON "aio_capture" USING btree ("firm_id","query")`,
  `CREATE INDEX IF NOT EXISTS "aio_capture_firm_fetched" ON "aio_capture" USING btree ("firm_id","fetched_at")`,
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
  console.log(`[admin:migrate-aio] applied=${results.length} ok=${allOk}`);
  return Response.json(
    { ok: allOk, applied: results.length, results },
    { status: allOk ? 200 : 500 },
  );
}

export const POST = runMigration;
export const GET = runMigration;
