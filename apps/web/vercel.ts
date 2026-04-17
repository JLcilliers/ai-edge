import { routes, type VercelConfig } from '@vercel/config/v1';

// Vercel project config for the Clixsy Intercept web app.
// Root Directory is apps/web (set in project settings). Framework + build
// command are auto-detected from apps/web/package.json.
export const config: VercelConfig = {
  crons: [
    // Weekly full audit per firm (Monday 06:00 UTC)
    { path: '/api/cron/audit-weekly', schedule: '0 6 * * 1' },
    // Daily top-20 priority queries per firm (08:00 UTC)
    { path: '/api/cron/audit-daily', schedule: '0 8 * * *' },
    // Reddit 24h poll (07:00 UTC)
    { path: '/api/cron/reddit-poll', schedule: '0 7 * * *' },
    // Citation diff nightly (04:00 UTC)
    { path: '/api/cron/citation-diff', schedule: '0 4 * * *' },
  ],
  headers: [
    routes.cacheControl('/_next/static/(.*)', {
      public: true,
      maxAge: '1 year',
      immutable: true,
    }),
  ],
};
