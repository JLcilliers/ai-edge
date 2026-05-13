-- 0018_priority_score
--
-- Adds the unified priority signal to remediation_ticket so the queue
-- can be ranked end-to-end across scanners. See the operator-experience
-- research (Q2): three scanners currently hand out priority_rank on
-- incompatible scales (audit severity 1-3, legacy traffic-ordinal 1-N,
-- sop per-page-score 1-N), producing 21+ tickets all colliding at
-- "rank 1" on APL. The new columns give every ticket a globally-
-- comparable class + score.
--
-- Two columns, both NOT NULL with defaults so existing rows stay
-- compatible until the backfill (pnpm score:recompute) runs:
--
--   priority_class TEXT  — stable semantic label of the work shape.
--     One of: factual_error / non_mention / time_sensitive /
--     content_drift / per_page_quality / entity_gap / config_gate /
--     unknown. The UI groups by class when it wants to render
--     section headers; downstream surfaces (Today's Actions, the
--     SOP alignment report) key off this.
--
--   priority_score INTEGER  — global comparable rank in [0, 799].
--     Computed by lib/sop/priority-score.ts at scanner-emit time:
--       class_base + within_class_offset
--     Class bases: 700 / 600 / 500 / 400 / 300 / 200 / 100 / 0
--     (factual / nonmention / timesens / drift / pagequal / entity /
--     unknown / config_gate). Within-class offset is [0, 99]. Higher
--     score = higher priority. Sort: priority_score DESC, created_at
--     DESC.
--
-- priority_rank stays in the schema as scanner-internal documentation.
-- The UI stops reading it; new code reads priority_score.
--
-- Index: composite (firm_id, status, priority_score DESC, created_at
-- DESC) matches the new default sort path in /tickets +
-- per-phase pages exactly. The (firm_id, status) prefix mirrors every
-- existing read against this table, so the index also serves the
-- ticket-count badges + status-filtered lookups without a separate
-- index.

ALTER TABLE "remediation_ticket"
  ADD COLUMN "priority_class" text NOT NULL DEFAULT 'unknown',
  ADD COLUMN "priority_score" integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "remediation_ticket_priority_idx"
  ON "remediation_ticket" ("firm_id", "status", "priority_score" DESC, "created_at" DESC);

COMMENT ON COLUMN "remediation_ticket"."priority_class" IS
  'Stable semantic label: factual_error | non_mention | time_sensitive | content_drift | per_page_quality | entity_gap | config_gate | unknown. Computed by lib/sop/priority-score.ts.';

COMMENT ON COLUMN "remediation_ticket"."priority_score" IS
  'Global comparable rank in [0, 799]. class_base + within_class_offset. Sort: priority_score DESC, created_at DESC. See lib/sop/priority-score.ts for the formula.';
