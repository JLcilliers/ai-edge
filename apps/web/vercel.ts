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
    // Monthly report generator — 05:00 UTC on the 1st, builds the
    // previous calendar month's roll-up and pushes JSON to Vercel Blob.
    { path: '/api/cron/report-monthly', schedule: '0 5 1 * *' },
    // Stale audit-run sweeper — hourly at :15, marks any audit_run stuck
    // in 'running' for >60 min as failed (process crash / deploy cycle).
    { path: '/api/cron/audit-sweep', schedule: '15 * * * *' },
  ],
  headers: [
    routes.cacheControl('/_next/static/(.*)', {
      public: true,
      maxAge: '1 year',
      immutable: true,
    }),
  ],
};
