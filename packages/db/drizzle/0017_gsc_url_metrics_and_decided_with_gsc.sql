-- 0017_gsc_url_metrics_and_decided_with_gsc
--
-- Two unrelated additions that land together because they're both required
-- for the Suppression decision framework rewrite (SOP Alignment Audit
-- finding C1):
--
-- 1. gsc_url_metric — per-URL clicks/impressions/ctr/position over a
--    rolling window. The existing gsc_daily_metric carries firm-wide
--    daily rollups; that's insufficient for Toth STEP3 because the
--    Delete / 301 / No-Index / Keep buckets gate on PER-PAGE clicks.
--    We populate this table via a per-URL search analytics query
--    (`dimensions: ['page']`) on a 30-day window at scan time.
--
--    Unique key on (firm, url, window_end_date) so a re-fetch on the
--    same window upserts cleanly. Most consumers will read the LATEST
--    row per (firm, url) — indexed accordingly.
--
-- 2. legacy_finding.decided_with_gsc — provenance flag on each
--    Suppression finding. When TRUE, the action bucket was decided
--    using Toth's full clicks-aware framework. When FALSE, only
--    semantic distance + backlinks were available (no-GSC fallback).
--    The flag lets a future re-bucketing pass identify findings that
--    need re-evaluation once GSC connects:
--      SELECT * FROM legacy_finding WHERE decided_with_gsc = false
--    Cheap to add now, expensive to retrofit if we needed it later.

CREATE TABLE IF NOT EXISTS "gsc_url_metric" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "firm_id" uuid NOT NULL REFERENCES "firm"("id") ON DELETE CASCADE,
  -- URL is normalized to the GSC-returned form (typically absolute, may
  -- include www / non-www depending on site_url scheme). Suppression
  -- code that joins against `page.url` is responsible for matching the
  -- normalization (trim trailing slash, lowercase host).
  "url" text NOT NULL,
  -- Window covered by this row. window_end_date is the most recent day
  -- included in the aggregate; window_start_date is window_end_date - N.
  -- Stored as TEXT (YYYY-MM-DD) for the same reason gsc_daily_metric
  -- does — Postgres DATE adds TZ surprises that bit us before.
  "window_start_date" text NOT NULL,
  "window_end_date" text NOT NULL,
  "clicks" integer NOT NULL,
  "impressions" integer NOT NULL,
  "ctr" real,
  "position" real,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- One row per (firm, url, window_end_date). Upserts on re-fetch.
CREATE UNIQUE INDEX IF NOT EXISTS "gsc_url_metric_firm_url_window"
  ON "gsc_url_metric" ("firm_id", "url", "window_end_date");

-- "Latest clicks per URL" lookups are hot — scanner reads per-URL on
-- every Suppression run. Index on (firm_id, url, window_end_date DESC)
-- so the order-by-DESC + LIMIT 1 lookup is index-only.
CREATE INDEX IF NOT EXISTS "gsc_url_metric_firm_url_recent_idx"
  ON "gsc_url_metric" ("firm_id", "url", "window_end_date" DESC);

-- ── legacy_finding.decided_with_gsc ──
ALTER TABLE "legacy_finding"
  ADD COLUMN IF NOT EXISTS "decided_with_gsc" boolean NOT NULL DEFAULT false;

-- Comment to surface the rebucketing query in psql introspection.
COMMENT ON COLUMN "legacy_finding"."decided_with_gsc" IS
  'TRUE when this finding was bucketed using Toth STEP3 clicks-aware framework. FALSE = no-GSC fallback (semantic distance + backlinks only). Re-bucket candidates: SELECT * FROM legacy_finding WHERE decided_with_gsc = false';
