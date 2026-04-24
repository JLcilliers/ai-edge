/**
 * Shared constants for the remediation ticket queue.
 *
 * These live in a dedicated module (no `'use server'` directive) because
 * Next.js 16 enforces that files marked with `'use server'` may only
 * export async functions — runtime values like `const` tuples cause a
 * build-time validation failure.
 *
 * Server actions in `remediation-actions.ts` import from here for their
 * own validation logic; client components import from here for filter
 * pills + badge ordering.
 */

/** Canonical order for filter pills + badge ordering. */
export const TICKET_SOURCES = ['audit', 'legacy', 'reddit', 'entity'] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export const TICKET_STATUSES = ['open', 'in_progress', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
