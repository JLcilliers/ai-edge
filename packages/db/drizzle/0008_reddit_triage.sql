ALTER TABLE "reddit_mention" ADD COLUMN IF NOT EXISTS "triage_status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "reddit_mention" ADD COLUMN IF NOT EXISTS "triage_note" text;--> statement-breakpoint
ALTER TABLE "reddit_mention" ADD COLUMN IF NOT EXISTS "triaged_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reddit_firm_triage_idx" ON "reddit_mention" USING btree ("firm_id","triage_status");
