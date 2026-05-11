-- 0012_brand_truth_bootstrap_meta
--
-- Adds the bootstrap_meta column to brand_truth_version so versions
-- produced by lib/brand-truth/bootstrap.ts can record their provenance
-- (pages crawled, JSON-LD types detected, model used, cost). Null for
-- manually-authored versions.
--
-- The other CREATE TABLE / FK / INDEX statements the generator emitted
-- have been stripped — those tables already exist from migrations
-- 0009..0011 against this Neon DB. Keeping them in the migration would
-- be harmless (all marked IF NOT EXISTS) but obscures what THIS
-- migration is actually changing.

ALTER TABLE "brand_truth_version" ADD COLUMN IF NOT EXISTS "bootstrap_meta" jsonb;
