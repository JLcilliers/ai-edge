CREATE TABLE IF NOT EXISTS "citation_diff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"latest_run_id" uuid NOT NULL,
	"previous_run_id" uuid NOT NULL,
	"gained" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lost" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gained_count" integer DEFAULT 0 NOT NULL,
	"lost_count" integer DEFAULT 0 NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "citation_diff" ADD CONSTRAINT "citation_diff_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "citation_diff" ADD CONSTRAINT "citation_diff_latest_run_id_audit_run_id_fk" FOREIGN KEY ("latest_run_id") REFERENCES "public"."audit_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "citation_diff" ADD CONSTRAINT "citation_diff_previous_run_id_audit_run_id_fk" FOREIGN KEY ("previous_run_id") REFERENCES "public"."audit_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "citation_diff_firm_latest" ON "citation_diff" USING btree ("firm_id","latest_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "citation_diff_firm_detected" ON "citation_diff" USING btree ("firm_id","detected_at");