/**
 * Shared constants for the Reddit mention triage workflow.
 *
 * Lives in a dedicated module (no `'use server'` directive) because Next.js
 * 16 enforces that files marked with `'use server'` may only export async
 * functions. The triage vocabulary is both the runtime validator for
 * `updateRedditMentionTriage` and the derived TS union the UI uses for
 * filter pills — order matters.
 */

export const TRIAGE_STATUSES = [
  'open',
  'acknowledged',
  'dismissed',
  'escalated',
] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];
