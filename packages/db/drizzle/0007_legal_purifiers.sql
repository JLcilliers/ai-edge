CREATE TABLE IF NOT EXISTS "cron_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cron_name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"duration_ms" integer,
	"summary" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cron_run_name_started_idx" ON "cron_run" USING btree ("cron_name","started_at");