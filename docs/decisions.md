# ADR log — Clixsy Intercept

Architecture Decision Records. Append-only. Reference decisions by ID from PRs and code comments.

## ADR-0001: Monorepo layout

**Status**: Accepted (Phase 0).
**Decision.** pnpm workspaces + Turborepo. `apps/web` (Next.js 16), `apps/api` (FastAPI), `apps/worker` (Python + LangGraph), `packages/shared` (Zod + pydantic types), `packages/db` (Drizzle schema + migrations).
**Why.** Consolidates TS and Python without forcing one language on the wrong layer. Drizzle stays the migration source of truth; Python reads the same Postgres.
**Revisit if.** Python outgrows the repo or CI runtimes diverge sharply.

## ADR-0002: Vercel AI Gateway as the LLM abstraction

**Status**: Accepted.
**Decision.** All multi-model LLM calls route through Vercel AI Gateway. Keep direct provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, Vertex service account, `PERPLEXITY_API_KEY`) as fallback + for provider-specific endpoints (e.g., Perplexity Sonar live-citation mode).
**Why.** Unified invocation, built-in observability, model fallback routing, zero data retention, OIDC auth in production, one billing line. Eliminates per-provider SDK sprawl in the audit engine.
**Revisit if.** Gateway pricing, rate-limit policy, or model catalog diverges from direct-provider needs.

## ADR-0003: Next.js 16.2.3 LTS, App Router, `proxy.ts`

**Status**: Accepted.
**Decision.** Next.js 16.2.3 LTS (current stable 2026-04-08). Middleware is renamed to `proxy` in v16 — use `proxy.ts` in the app. Root-level `vercel.ts` is the platform config.
**Why.** v14 EOL Oct 2025; v16 is current LTS. Proxy rename is the new idiom (CVE-2025-29927 motivation).

## ADR-0004: Drizzle as migration source; pydantic mirrors for Python

**Status**: Accepted.
**Decision.** Drizzle schema in `packages/db` is the source of truth for Postgres. Python workers read the same Postgres via SQLAlchemy Core; pydantic v2 models in `apps/api/src/ai_edge_api/schemas` + `packages/shared` are manually kept in sync. Parity test comparing field names + required shape lands Phase 0 week 2.
**Why.** Avoids Alembic/Drizzle race; keeps TS-first for Vercel deployment; Python side is read-heavy.
**Revisit if.** Python becomes the primary writer or schema grows past ~40 tables.

## ADR-0005: Fly.io for Python workers; Vercel for Next.js + API gateway

**Status**: Accepted.
**Decision.** Python workers (Playwright, LangGraph, PRAW, sentence-transformers) deploy to Fly.io. Regions: `sea` (US), `lhr` (UK), `fra` (EU). FastAPI gateway co-locates on Fly for low-latency worker dispatch. Next.js portal + cron endpoints deploy to Vercel.
**Why.** Fluid Compute + Playwright at long-job scale is unreliable (community-confirmed). Fly region control matches residential-proxy egress geo (Bright Data).
**Revisit if.** Vercel Sandbox (GA Jan 2026) proves out for short-lived Playwright runs — could absorb some scraping load.

## ADR-0006: Scenario Lab (ex-MarketBrew) scope and name

**Status**: Accepted.
**Decision.** Proposed name: **PreFlight Ranker** (pending USPTO/WIPO TM clearance). Fallback: Scenario Lab. Descoped from v1 to post-v1 R&D track. Phase 1–4 ship first; Scenario Lab builds only after Phases 1–4 are live and generating revenue.
**Why.** MarketBrew is a real commercial product — trademark collision. "PreFlight Ranker" has aviation-metaphor personality and the value prop in two words. Scenario Lab is highest-variance deliverable; calibration corpus needs Phase 1–2 data before there's anything to calibrate.

## ADR-0007: Brand Truth versioning

**Status**: Accepted.
**Decision.** Every edit to Brand Truth creates a new `brand_truth_version` row; `audit_run.brand_truth_version_id` pins which version was in effect. No in-place edits.
**Why.** Alignment scores are only interpretable against the exact truth at run time. In-place edits would retroactively invalidate historical RAG trends.

## ADR-0008: Monthly reporting hands off to existing N8N pipeline

**Status**: Accepted.
**Decision.** Clixsy Intercept generates monthly client-facing report payloads (PPTX or structured JSON) and hands off to the existing N8N monthly SEO reporting pipeline for delivery. No new delivery infrastructure (email, Slack, PDF-renderer) in v1.
**Why.** Consolidates with existing workflow; avoids parallel delivery infra. Aligns agency ops.

## ADR-0009: SERP capture via DataForSEO, AIO fallback via Playwright

**Status**: Accepted.
**Decision.** DataForSEO primary for SERP + AI Overview capture (SERP, Keywords, Backlinks, On-Page endpoints under one contract). Playwright on Fly.io as fallback for AIO pages DataForSEO doesn't cover. Perplexity data via Sonar API, not scraping.
**Why.** DataForSEO cost-scales cleaner at agency volume; one contract simplifies Phase 3 Entity + Suppression work. Playwright only where strictly needed.
**Revisit if.** DataForSEO AIO coverage regresses — re-price Playwright share.

## ADR-0010: Bright Data residential proxies (single pool for v1)

**Status**: Accepted.
**Decision.** Bright Data as the single residential-proxy pool in v1. Zone: multi-geo (US + UK + DE) with per-job geo-match to target SERP.
**Why.** Google AIO is the hardest anti-bot target in the stack; residential pool quality > cost delta vs. Oxylabs. One pool = simpler ops for v1.
**Revisit if.** A second vertical/region opens where Oxylabs outperforms.

## ADR-0011: Multi-tenant from day 1; dogfood-then-dental rollout

**Status**: Accepted, revised 2026-04-16.
**Decision.** Multi-tenant from Phase 0. Tenant order:
  1. **Clixsy** (marketing_agency) — P0 dogfood; no client-approval cycles.
  2. **Fresh Dental Marketing** (dental_practice) — first dental validation.
  3. **Natural Smiles** (dental_practice, UK) — second dental + first UK tenant (tests GDC compliance branch).
  4. **First paying PI firm** (law_firm) — v2 vertical.
**Why.** Agencies don't ship single-tenant products. Dogfooding on Clixsy lets RAG scoring, Brand Truth editor, and remediation UX iterate without external approval cycles. Clixsy is also a marketing agency, not a law firm, which forced the firm_type discriminator in ADR-0013 and means we prove the multi-vertical story from day 1.

## ADR-0013: Brand Truth is a discriminated union on firm_type

**Status**: Accepted.
**Decision.** `firm_type` is a required top-level field. Values: `law_firm`, `dental_practice`, `marketing_agency`, `other`. Each branch has type-specific fields (law: attorney_bios, notable_cases; dental: provider_bios, geographies_served; agency: service_offerings, team_members, key_clients_public; other: escape hatch). The editor renders only the active branch. Default `compliance_jurisdictions` per firm_type:
  - `law_firm` → populated per-state from `geographies_served`
  - `dental_practice` → per-state + `UK-GDC` where country = GB
  - `marketing_agency` → `US-FTC-AGENCY`
  - `other` → empty
**Why.** The original flat schema assumed legal/medical. Clixsy (marketing agency) as the P0 dogfood tenant exposed that agency fields (service offerings, team members, public client testimonials) don't fit that shape, and FTC rules — not bar rules — govern their ad copy. Discriminated union is the clean way to let one engine serve every firm type without conditional-field spaghetti in the editor or rulebook loader.

## ADR-0014: Fly.io + GitHub naming convention

**Status**: Accepted.
**Decision.** Fly apps are brand-prefixed: `clixsy-ai-edge-api`, `clixsy-ai-edge-worker`. GitHub repo lives at `JLcilliers/ai-edge` (private); transferable to a Clixsy/QRM org later without breaking Fly app names.
**Why.** Single Fly org will host more than one product (Clixsy Intercept, future QRM / Fresh / FSE / Globe Runner products). Unprefixed names collide at the first sibling deploy. GitHub org migration is easy; Fly app renames are not.

## ADR-0012: Scheduling cadence

**Status**: Accepted.
**Decision.** Weekly full audit per firm; daily on top 10–20 priority queries; Reddit poll every 24h; citation diff nightly. Monthly client report generated from archive (see ADR-0008).
**Why.** Signal-to-cost tradeoff. 15-min Reddit polling proposed initially was over-eager — 24h fits Reddit sentiment decay curve and LLM crawl cadence.
