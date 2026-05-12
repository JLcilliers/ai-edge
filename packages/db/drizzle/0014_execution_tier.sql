-- 0014_execution_tier
--
-- Adds the execution-tier prescription columns to remediation_ticket so
-- the UI can render each task with the right affordance:
--   • auto-execute  → green badge + [Apply] button that fires the
--                     auto-fix integration (Wikidata write, CMS schema
--                     deploy, Cloudflare 301, etc.)
--   • assist        → yellow badge + [Open <Platform> →] deep-link to
--                     the platform's admin UI, with remediation_copy
--                     pre-prepared on the ticket for paste
--   • manual        → red badge + descriptive "human-only" rationale
--                     (SME interview, sales call, Wikipedia direct edit
--                     forbidden by COI policy, LinkedIn outreach
--                     forbidden by TOS, etc.)
--
-- The split is enforced at ticket-factory time; the columns are nullable
-- because legacy tickets predate the tier classification.

ALTER TABLE "remediation_ticket"
  ADD COLUMN IF NOT EXISTS "automation_tier" text,
  ADD COLUMN IF NOT EXISTS "execute_url"      text,
  ADD COLUMN IF NOT EXISTS "execute_label"    text,
  ADD COLUMN IF NOT EXISTS "manual_reason"    text;

-- Constraint: automation_tier must be one of the three values when set.
-- Postgres CHECK with IS NULL fall-through so legacy rows stay valid.
ALTER TABLE "remediation_ticket"
  DROP CONSTRAINT IF EXISTS "remediation_ticket_automation_tier_check";
ALTER TABLE "remediation_ticket"
  ADD CONSTRAINT "remediation_ticket_automation_tier_check"
  CHECK (
    "automation_tier" IS NULL OR
    "automation_tier" IN ('auto', 'assist', 'manual')
  );

-- Index supports the action-items page's "filter by tier" UI.
CREATE INDEX IF NOT EXISTS "remediation_ticket_tier_idx"
  ON "remediation_ticket" ("firm_id", "automation_tier", "priority_rank");
