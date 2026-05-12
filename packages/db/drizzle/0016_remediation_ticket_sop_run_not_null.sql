-- 0016_remediation_ticket_sop_run_not_null
--
-- Hardens the invariant that every remediation_ticket attaches to a
-- sop_run. The original schema left sop_run_id nullable because the
-- prescription-layer columns landed alongside the SOP engine (0013) but
-- predate the auto-anchor work — and four legacy scanner code paths
-- (run-audit.ts, suppression/scan.ts, entity/scan.ts,
-- entity/cross-source-scan.ts, reddit/scan.ts) had not been migrated to
-- go through createTicketFromStep / ensureSopRun yet.
--
-- The migration runs AFTER:
--   1. Those five legacy paths have been patched to call ensureSopRun()
--      and pass sop_run_id on insert (this PR), AND
--   2. apps/web/scripts/backfill-untagged-tickets.ts has run and zero
--      tickets remain with sop_run_id IS NULL.
--
-- The constraint is a fail-loud guardrail. Any future scanner that
-- bypasses the SOP-engine path will get an immediate insert failure
-- from Postgres rather than silently emitting tickets that don't show
-- up in the phase-page execution-task list or the sidebar count.
--
-- Safety: this is a one-way migration. To reverse, drop the NOT NULL —
-- but you should never want to: nullable sop_run_id IS the bug.

-- Verify zero nulls before applying. If any null rows remain the ALTER
-- will fail and the migration aborts cleanly, which is the right
-- behavior — operator needs to run the backfill script first.
--
-- Two-step transaction:
--   1. ALTER COLUMN ... SET NOT NULL
--   2. Drop the old FK (onDelete: SET NULL — incompatible with the
--      new NOT NULL constraint; would crash on sop_run delete) and
--      replace with onDelete: CASCADE, matching sop_step_state and
--      sop_deliverable which already use CASCADE on the same parent.
-- Wrapped in a transaction so a failed step rolls everything back.

BEGIN;

ALTER TABLE "remediation_ticket"
  ALTER COLUMN "sop_run_id" SET NOT NULL;

ALTER TABLE "remediation_ticket"
  DROP CONSTRAINT IF EXISTS "remediation_ticket_sop_run_id_fkey";

ALTER TABLE "remediation_ticket"
  ADD CONSTRAINT "remediation_ticket_sop_run_id_fkey"
  FOREIGN KEY ("sop_run_id") REFERENCES "sop_run" ("id") ON DELETE CASCADE;

COMMIT;
