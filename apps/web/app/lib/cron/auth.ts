/**
 * Shared auth guard for Vercel-Cron-triggered API routes.
 *
 * Vercel automatically injects `Authorization: Bearer $CRON_SECRET` on requests
 * triggered by the platform cron scheduler (when `CRON_SECRET` is set in the
 * project's env). In production we require that header; in development we
 * allow unauthenticated access so you can hit the routes via `curl localhost`.
 *
 * The handlers also accept a manual override via `?key=...` query param that
 * matches `CRON_SECRET` — useful for one-off operator runs from the Vercel
 * dashboard's "Run now" action which sends a GET without a bearer token.
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;

  // Dev shortcut: no secret set → allow everything. Safe because production
  // deploys always have CRON_SECRET provisioned.
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      // Fail closed in production if the env is missing — better than silently
      // accepting every public request.
      return false;
    }
    return true;
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader === `Bearer ${secret}`) return true;

  // Manual-trigger fallback — operator can append ?key=<secret> from the
  // Vercel dashboard.
  const url = new URL(request.url);
  if (url.searchParams.get('key') === secret) return true;

  return false;
}

export function unauthorizedResponse(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}
