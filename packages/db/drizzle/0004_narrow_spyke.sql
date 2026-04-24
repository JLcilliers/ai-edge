CREATE TABLE IF NOT EXISTS "monthly_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"month_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"blob_url" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monthly_report" ADD CONSTRAINT "monthly_report_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monthly_report_firm_month" ON "monthly_report" USING btree ("firm_id","month_key");