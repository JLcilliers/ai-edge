CREATE TABLE IF NOT EXISTS "legacy_rewrite_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_finding_id" uuid NOT NULL,
	"brand_truth_version_id" uuid,
	"current_title" text,
	"current_excerpt" text,
	"proposed_title" text NOT NULL,
	"proposed_body" text NOT NULL,
	"change_summary" text,
	"entities_preserved" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"positioning_fixes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"banned_claims_avoided" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_by_model" text NOT NULL,
	"cost_usd" real,
	"status" text DEFAULT 'draft' NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "legacy_rewrite_draft" ADD CONSTRAINT "legacy_rewrite_draft_legacy_finding_id_legacy_finding_id_fk" FOREIGN KEY ("legacy_finding_id") REFERENCES "public"."legacy_finding"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "legacy_rewrite_draft" ADD CONSTRAINT "legacy_rewrite_draft_brand_truth_version_id_brand_truth_version_id_fk" FOREIGN KEY ("brand_truth_version_id") REFERENCES "public"."brand_truth_version"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "legacy_rewrite_draft_finding" ON "legacy_rewrite_draft" USING btree ("legacy_finding_id");