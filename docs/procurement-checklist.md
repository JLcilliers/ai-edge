# Phase 0 Procurement Checklist

Ordered by what blocks downstream work. 🟢 = user action. 🔵 = Claude Code action.

## Critical path — unblocks Phase 1

- [ ] 🟢 Install Vercel CLI: `npm i -g vercel`
- [x] 🟢 Vercel team = **`quickrank-projects`** (https://vercel.com/quickrank-projects)
- [ ] 🟢 `vercel link --yes --scope quickrank-projects` inside repo root
- [ ] 🟢 Clerk via Vercel Marketplace → `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
- [ ] 🟢 Neon Postgres via Vercel Marketplace → `DATABASE_URL`, `DIRECT_URL`
- [ ] 🟢 Upstash Redis via Vercel Marketplace → `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- [ ] 🟢 Pinecone via Vercel Marketplace → `PINECONE_API_KEY` + create index `brand-truth` (dimension 3072, cosine, us-east-1, serverless) ✅ DONE
- [ ] 🟢 Vercel Blob → `BLOB_READ_WRITE_TOKEN` (private, for raw LLM JSON + AIO captures)
- [ ] 🟢 Vercel AI Gateway enabled on the team → OIDC auto-wiring (no manual key needed on Vercel; local dev uses `vercel env pull` for `VERCEL_OIDC_TOKEN`)
- [ ] 🟢 `vercel env pull .env.local --yes` after each Marketplace provisioning step
- [ ] 🟢 Fly.io account + CLI (`flyctl auth signup` then `flyctl auth login`)

## Provider access (Phase 1–2)

- [ ] 🟢 OpenAI API key — already have
- [ ] 🟢 Anthropic API key — already have
- [ ] 🟢 GCP project + billing + Vertex AI enabled; Gemini 3.1 Pro + Claude Sonnet 4.6 via Model Garden → `GOOGLE_VERTEX_PROJECT`, service-account JSON
- [ ] 🟢 Perplexity Sonar API key (~$3/$15 per 1M in/out tokens) → `PERPLEXITY_API_KEY`
- [ ] 🟢 Reddit commercial-tier app → `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`
- [ ] 🟢 Bright Data residential-proxy zone (US + UK + DE gateways) → `BRIGHT_DATA_*`
- [ ] 🟢 DataForSEO account (SERP + Keywords + Backlinks + On-Page under one contract) → `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`
- [ ] 🟢 Google Search Console service accounts per client

## Compliance & brand

- [x] 🟢 "PreFlight Ranker" — working-name clearance complete (no live registration, distinctive against competitors). Formal TM-counsel search before any paid landing page.
- [ ] 🟢 Ethics counsel engagement — bar + dental-board + GDC + FTC ad-rule review (gates Phase 3 client launch)
- [x] 🟢 Clixsy (P0 dogfood, marketing_agency) — Brand Truth v1 seeded: `docs/seed-brand-truth-clixsy.json`
- [ ] 🟢 Fresh Dental Marketing (P1 validation, dental_practice) — Brand Truth intake
- [ ] 🟢 Natural Smiles (P2 validation, dental_practice UK) — Brand Truth intake

## Repo / CI

- [x] 🔵 Monorepo scaffold — landed
- [x] 🟢 GitHub account = **`JLcilliers`**; repo target = `https://github.com/JLcilliers/ai-edge` (private)
- [ ] 🟢 Create private repo `JLcilliers/ai-edge` on GitHub (transferable to Clixsy/QRM org later per ADR-0014)
- [ ] 🔵 Initial push once repo exists
- [ ] 🔵 Fly.io apps: `clixsy-ai-edge-api` + `clixsy-ai-edge-worker` (ADR-0014) — `fly.toml` lands Phase 0 week 2
- [ ] 🔵 GitHub Actions: lint + typecheck + test on PR — Phase 0 week 2

## After the above

Run locally:

```bash
vercel link --yes
vercel env pull .env.local --yes
pnpm install
npx dotenv -e .env.local -- pnpm --filter @ai-edge/db generate
npx dotenv -e .env.local -- pnpm --filter @ai-edge/db migrate
pnpm dev
```
