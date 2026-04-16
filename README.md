# AI Edge

Trust Alignment for the AI search era. AEO platform that measures and closes the gap between how a firm positions itself and how LLMs actually describe it.

See [PLAN.md](./PLAN.md) for full scope, architecture, and roadmap.

## Repo layout

```
apps/
  web/      Next.js 16 client portal (Vercel)
  api/      FastAPI gateway (Vercel / Fly.io)
  worker/   Python + LangGraph + Playwright workers (Fly.io)
packages/
  shared/   Zod + pydantic Brand Truth schema, compliance rulebook
  db/       Drizzle schema + migrations (source of truth for Postgres)
docs/
  procurement-checklist.md   Phase 0 procurement actions
  decisions.md               ADR log
```

## Phase 0 bootstrap

Before first `pnpm install`, action the procurement checklist (`docs/procurement-checklist.md`). Then:

```bash
# 1. Install Vercel CLI (one-time)
npm i -g vercel

# 2. Link repo to Vercel project
vercel link --yes

# 3. Pull env vars into .env.local (includes VERCEL_OIDC_TOKEN for AI Gateway)
vercel env pull .env.local --yes

# 4. Install dependencies
pnpm install

# 5. Apply Drizzle migrations
pnpm --filter @ai-edge/db generate
pnpm --filter @ai-edge/db migrate

# 6. Start dev
pnpm dev
```

## Python services (apps/api, apps/worker)

Managed with `uv`.

```bash
cd apps/worker
uv sync
uv run python -m ai_edge_worker.main
```

Playwright browsers install into the Docker image; local dev uses `uv run playwright install chromium`.

## Stack

- **Frontend**: Next.js 16.2.3 LTS (App Router, `proxy.ts`)
- **TypeScript tooling**: pnpm 9 + Turborepo 2
- **Backend**: FastAPI (gateway) + Python 3.12 workers (LangGraph + Playwright)
- **LLM access**: Vercel AI Gateway (OIDC-auth) — ADR-0002
- **Database**: Neon Postgres via Vercel Marketplace, Drizzle ORM
- **Vectors**: Pinecone via Vercel Marketplace
- **Queue**: Upstash Redis via Vercel Marketplace
- **Blob**: Vercel Blob (private, for raw LLM responses + AIO captures)
- **Auth**: Clerk via Vercel Marketplace
- **Worker host**: Fly.io (region-controlled residential-proxy egress)
- **Proxies**: Bright Data residential
- **SERP**: DataForSEO
