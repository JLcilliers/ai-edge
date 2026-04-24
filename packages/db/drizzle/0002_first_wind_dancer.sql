ALTER TABLE "page" ADD COLUMN "main_content" text;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "word_count" integer;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "embedding" jsonb;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "embedding_model" text;