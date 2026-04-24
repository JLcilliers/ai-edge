import { getDb, cronRuns } from '@ai-edge/db';
import { eq } from 'drizzle-orm';

/**
 * Wrapper that bookends a cron handler with `cron_run` rows so the admin
 * dashboard can show durable execution history without trawling the Vercel
 * log stream.
 *
 * Usage:
 *
 *   export async function GET(request: Request) {
 *     if (!isAuthorizedCronRequest(request)) return unauthorizedResponse();
 *     return recordCronRun('audit-weekly', async () => {
 *       // …cron body…
 *       return { body: { ran: 3 }, summary: { ran: 3, ok: 2, errored: 1 } };
 *     });
 *   }
 *
 * The wrapper inserts a `status='running'` row on entry, then updates it to
 * `'ok'` or `'error'` on exit. Errors are re-thrown so the Vercel platform
 * still sees the 500 status and can retry / alert normally. Return-value
 * shape:
 *   - `body`    — serialised back to the HTTP client (the cron runner)
 *   - `summary` — persisted to the cron_run.summary jsonb column (shown in
 *                 the admin UI when a row is expanded)
 *
 * The two are often the same object; they're split to give handlers room
 * to return user-facing JSON that differs from what ops wants to store
 * (e.g., drop verbose per-firm result arrays from the persisted summary).
 */
export async function recordCronRun<TBody, TSummary = TBody>(
  cronName: string,
  handler: () => Promise<{ body: TBody; summary: TSummary }>,
): Promise<Response> {
  const db = getDb();
  const startedAt = Date.now();

  // Insert the running row so the admin page can show in-flight crons.
  const [row] = await db
    .insert(cronRuns)
    .values({ cron_name: cronName })
    .returning({ id: cronRuns.id });

  const runId = row?.id;
  if (!runId) {
    // Defensive — if we couldn't log the run, still execute the cron. We'd
    // rather lose observability than lose work.
    console.warn(`[cron:${cronName}] failed to insert cron_run row; running without logging`);
    const { body } = await handler();
    return Response.json(body);
  }

  try {
    const { body, summary } = await handler();
    const durationMs = Date.now() - startedAt;
    await db
      .update(cronRuns)
      .set({
        status: 'ok',
        finished_at: new Date(),
        duration_ms: durationMs,
        summary: summary as unknown,
      })
      .where(eq(cronRuns.id, runId));
    return Response.json(body);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(cronRuns)
      .set({
        status: 'error',
        finished_at: new Date(),
        duration_ms: durationMs,
        error: message.slice(0, 4000), // cap to protect the row size
      })
      .where(eq(cronRuns.id, runId))
      .catch((logErr) => {
        // Last-resort logging — if we can't even log the failure, at least
        // get it into the Vercel stream.
        console.error(`[cron:${cronName}] failed to write error row:`, logErr);
      });
    throw err;
  }
}
