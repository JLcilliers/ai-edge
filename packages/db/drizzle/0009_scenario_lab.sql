CREATE TABLE IF NOT EXISTS "serp_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"query" text NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"country" text,
	"language" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "serp_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"title" text,
	"snippet" text,
	"is_target" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"page_id" uuid,
	"url" text NOT NULL,
	"features" jsonb NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ranker_weights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"weights" jsonb NOT NULL,
	"fitness" real NOT NULL,
	"observation_count" integer NOT NULL,
	"pso_params" jsonb,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scenario" (
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
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "serp_snapshot" ADD CONSTRAINT "serp_snapshot_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "serp_result" ADD CONSTRAINT "serp_result_snapshot_id_serp_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "serp_snapshot"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_features" ADD CONSTRAINT "page_features_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_features" ADD CONSTRAINT "page_features_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ranker_weights" ADD CONSTRAINT "ranker_weights_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scenario" ADD CONSTRAINT "scenario_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "serp_snapshot_firm_query_idx" ON "serp_snapshot" USING btree ("firm_id","query");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "serp_result_snapshot_idx" ON "serp_result" USING btree ("snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "page_features_firm_url" ON "page_features" USING btree ("firm_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ranker_weights_firm_gen" ON "ranker_weights" USING btree ("firm_id","generation");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scenario_firm_idx" ON "scenario" USING btree ("firm_id");
