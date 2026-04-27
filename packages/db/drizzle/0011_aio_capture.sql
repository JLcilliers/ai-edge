CREATE TABLE IF NOT EXISTS "aio_capture" (
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
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "aio_capture" ADD CONSTRAINT "aio_capture_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aio_capture_firm_query" ON "aio_capture" USING btree ("firm_id","query");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aio_capture_firm_fetched" ON "aio_capture" USING btree ("firm_id","fetched_at");
