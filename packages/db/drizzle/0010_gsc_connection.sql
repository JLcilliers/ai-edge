CREATE TABLE IF NOT EXISTS "gsc_connection" (
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
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gsc_daily_metric" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"date" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" real,
	"position" real,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gsc_connection" ADD CONSTRAINT "gsc_connection_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gsc_daily_metric" ADD CONSTRAINT "gsc_daily_metric_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gsc_daily_firm_date" ON "gsc_daily_metric" USING btree ("firm_id","date");
