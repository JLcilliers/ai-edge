CREATE TABLE IF NOT EXISTS "alignment_score" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consensus_response_id" uuid NOT NULL,
	"mentioned" boolean NOT NULL,
	"tone_1_10" real,
	"rag_label" text NOT NULL,
	"gap_reasons" jsonb DEFAULT '[]'::jsonb,
	"remediation_priority" integer DEFAULT 3
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"brand_truth_version_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cost_usd" real DEFAULT 0,
	"error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_truth_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "citation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consensus_response_id" uuid NOT NULL,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"rank" integer,
	"type" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "competitor_mention" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"competitor_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"share" real,
	"praise_flag" boolean DEFAULT false,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "competitor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consensus_response" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_id" uuid NOT NULL,
	"self_consistency_k" integer NOT NULL,
	"majority_answer" text,
	"variance" real,
	"mentioned" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"source" text NOT NULL,
	"url" text,
	"nap_hash" text,
	"description_hash" text,
	"verified_at" timestamp with time zone,
	"divergence_flags" jsonb DEFAULT '[]'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "firm" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"firm_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legacy_finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"semantic_distance" real NOT NULL,
	"action" text NOT NULL,
	"rationale" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_response" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"attempt" integer NOT NULL,
	"raw_response" jsonb NOT NULL,
	"latency_ms" integer,
	"cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"content_hash" text,
	"embedding_id" text,
	"fetched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "query" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_run_id" uuid NOT NULL,
	"text" text NOT NULL,
	"practice_area" text,
	"intent" text,
	"priority" text DEFAULT 'standard'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reddit_mention" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"subreddit" text NOT NULL,
	"post_id" text NOT NULL,
	"comment_id" text,
	"author" text,
	"karma" integer,
	"sentiment" text,
	"text" text,
	"url" text NOT NULL,
	"posted_at" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "remediation_ticket" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"owner" text,
	"playbook_step" text,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scenario_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"baseline_serp_snapshot_id" uuid,
	"proposed_change" jsonb NOT NULL,
	"predicted_rank_delta" real,
	"confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alignment_score" ADD CONSTRAINT "alignment_score_consensus_response_id_consensus_response_id_fk" FOREIGN KEY ("consensus_response_id") REFERENCES "public"."consensus_response"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_run" ADD CONSTRAINT "audit_run_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_run" ADD CONSTRAINT "audit_run_brand_truth_version_id_brand_truth_version_id_fk" FOREIGN KEY ("brand_truth_version_id") REFERENCES "public"."brand_truth_version"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brand_truth_version" ADD CONSTRAINT "brand_truth_version_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "citation" ADD CONSTRAINT "citation_consensus_response_id_consensus_response_id_fk" FOREIGN KEY ("consensus_response_id") REFERENCES "public"."consensus_response"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "competitor_mention" ADD CONSTRAINT "competitor_mention_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "competitor_mention" ADD CONSTRAINT "competitor_mention_competitor_id_competitor_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitor"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "competitor_mention" ADD CONSTRAINT "competitor_mention_query_id_query_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."query"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "competitor" ADD CONSTRAINT "competitor_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consensus_response" ADD CONSTRAINT "consensus_response_query_id_query_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."query"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_signal" ADD CONSTRAINT "entity_signal_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "legacy_finding" ADD CONSTRAINT "legacy_finding_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_response" ADD CONSTRAINT "model_response_query_id_query_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."query"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page" ADD CONSTRAINT "page_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "query" ADD CONSTRAINT "query_audit_run_id_audit_run_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "public"."audit_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reddit_mention" ADD CONSTRAINT "reddit_mention_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "remediation_ticket" ADD CONSTRAINT "remediation_ticket_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scenario_run" ADD CONSTRAINT "scenario_run_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brand_truth_firm_version" ON "brand_truth_version" USING btree ("firm_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "citation_domain_idx" ON "citation" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "page_firm_url" ON "page" USING btree ("firm_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reddit_firm_post" ON "reddit_mention" USING btree ("firm_id","post_id","comment_id");