import { routes, type VercelConfig } from '@vercel/config/v1';

// Root Vercel config for the monorepo. apps/web deploys from this root
// with the buildCommand targeting the Next.js app via Turborepo.
export const config: VercelConfig = {
  framework: 'nextjs',
  buildCommand: 'pnpm turbo run build --filter=@ai-edge/web',
  installCommand: 'pnpm install --frozen-lockfile',
  outputDirectory: 'apps/web/.next',
  crons: [
    // Weekly full audit per firm — fan-out inside the handler
    { path: '/api/cron/audit-weekly', schedule: '0 6 * * 1' },
    // Daily top-20 priority queries per firm
    { path: '/api/cron/audit-daily', schedule: '0 8 * * *' },
    // Reddit 24h poll
    { path: '/api/cron/reddit-poll', schedule: '0 */24 * * *' },
    // Citation diff nightly
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
