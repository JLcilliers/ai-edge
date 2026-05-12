-- 0015_deep_research_budget
--
-- Adds per-firm quarterly spend cap for the Deep Research Content Audit
-- scanner. Default $5/quarter; agencies paying for monthly Deep Research
-- runs can raise this per firm.
--
-- Why separate from the existing monthly_cap_usd?
--   monthly_cap_usd governs the audit pipeline (Brand Visibility Audit,
--   cross-source scan, etc.) — high-volume, recurring, predictable. Deep
--   Research is a different cost profile: one synthesis call per scan,
--   bursty, opt-in. Mixing them under the same cap means either capping
--   audits too tight or running Deep Research uncapped. Separate column
--   gives operators a clean knob per dimension.
--
-- The scanner refuses to run when quarter-to-date Deep Research cost +
-- estimated next-run cost would exceed the cap. Quarter is the calendar
-- quarter in UTC.
--
-- last_run_cost_usd and quarter_to_date_usd are populated by the scanner
-- itself — they're advisory mirrors for the UI, not the source of truth.
-- The actual cost ledger sits on the LLM-call cost rows.

ALTER TABLE "firm_budget"
  ADD COLUMN IF NOT EXISTS "deep_research_quarterly_cap_usd" real NOT NULL DEFAULT 5.0,
  ADD COLUMN IF NOT EXISTS "deep_research_quarter_to_date_usd" real NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS "deep_research_quarter_key" text;

-- quarter_key is 'YYYY-Qn' (e.g. '2026-Q2'); the scanner resets
-- quarter_to_date_usd → 0 when the current quarter doesn't match.
COMMENT ON COLUMN "firm_budget"."deep_research_quarter_key" IS
  'YYYY-Qn for the quarter the quarter_to_date_usd value covers. Scanner resets the running total when this rolls over.';
