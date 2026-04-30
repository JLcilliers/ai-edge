/**
 * Single source of truth for which `audit_run.status` values count as
 * "this run produced data the rest of the dashboard should read."
 *
 * Three terminal states all carry usable signal:
 *   - `completed` — every seed query × provider scored cleanly. The happy
 *     path; this is what most runs hit.
 *   - `completed_budget_truncated` — the audit pipeline ran out of monthly
 *     LLM budget mid-loop and stopped early. The queries that did execute
 *     wrote real citations and mention counts; partial data is real data.
 *   - `completed_partial` — the serverless function crashed (deploy cycle,
 *     OOM, hung provider) before the final UPDATE could fire, but the
 *     audit-sweep watchdog (cron `15 * * * *`) promoted the run because at
 *     least one consensus_response landed. The rows that did write are
 *     still real — visibility / share-of-voice / drift / citation diff
 *     aggregations should count them so the operator isn't blocked behind
 *     a single hung provider.
 *
 * Failed and cancelled runs do NOT carry usable signal:
 *   - `failed` / `cancelled` — either no rows landed, or the operator
 *     explicitly aborted; either way these are sentinel rows for the
 *     audit-list UI, not data sources.
 *
 * Use the spread `[...COMPLETED_STATUSES]` form when passing to drizzle's
 * `inArray()` because the `as const` makes this a readonly tuple and
 * `inArray` wants a mutable array type.
 *
 * @example
 *   import { COMPLETED_STATUSES } from '../../lib/audit/run-status';
 *   // ...
 *   .where(inArray(auditRuns.status, [...COMPLETED_STATUSES]))
 */
export const COMPLETED_STATUSES = [
  'completed',
  'completed_budget_truncated',
  'completed_partial',
] as const;

export type CompletedAuditStatus = (typeof COMPLETED_STATUSES)[number];

/** Boolean predicate form for non-SQL contexts (e.g. filtering an array). */
export function isCompletedStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return (COMPLETED_STATUSES as readonly string[]).includes(status);
}
