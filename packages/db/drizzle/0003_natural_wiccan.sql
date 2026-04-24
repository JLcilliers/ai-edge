CREATE TABLE IF NOT EXISTS "firm_budget" (
	"firm_id" uuid PRIMARY KEY NOT NULL,
	"monthly_cap_usd" real NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "query_response_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"response_text" text NOT NULL,
	"raw_response" jsonb,
	"latency_ms" integer,
	"cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "firm_budget" ADD CONSTRAINT "firm_budget_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "query_cache_expires_idx" ON "query_response_cache" USING btree ("expires_at");