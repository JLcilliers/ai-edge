# AI Edge™ — Research & Implementation Plan

**Date:** 2026-04-16
**Source of truth:** `AI_Edge_Technical_Framework_v2.docx` + manager's brief
**Status:** Draft for review (no code yet)

---

## 1. Product definition

AI Edge™ is a **vertical-agnostic AI Engine Optimization (AEO)** platform. The Trust Alignment methodology works anywhere a firm has declarative brand positioning and a defined competitive set. Two outcomes, one loop:

1. **Visibility** — the firm appears in LLM answers to high-intent queries in its vertical.
2. **Alignment** — when it appears, the narrative matches the firm's declared "Brand Truth."

The platform closes the *Alignment Gap* between **Brand Ground Truth** (declarative JSON supplied by the firm) and **Model Output** (what OpenAI, Anthropic, Google AIO/Gemini, Perplexity actually say).

**Pilot vertical: dental.** Dental is the strongest existing client base and has clean brand-positioning attributes (practice areas, insurance, geos) without the bar-ethics complexity of PI. PI is the v2 vertical — framework is agnostic so the same engine serves both. Build **multi-tenant from day 1**; seed one dogfood tenant + the first real dental pilot client.

---

## 2. Deliverables → framework mapping

The manager listed eight deliverables. Each maps to a concrete module in the framework:

| # | Manager's deliverable                      | Framework module                         | Primary signal                                    |
|---|--------------------------------------------|------------------------------------------|---------------------------------------------------|
| 1 | Trust Alignment Audit (Red/Yellow/Green)   | §2.1 Audit & Scoring                     | Multi-model narrative scored vs. Brand Truth JSON |
| 2 | Brand Visibility Tracking across LLMs      | §2.2 Visibility & Citation Mapping       | Mention rate, position, source-of-citation        |
| 3 | Legacy Content Suppression                 | §4.1 Legacy Content Suppression Engine   | Semantic distance from Brand Truth embedding      |
| 4 | Reddit Brand Sentiment Monitoring          | §3.2 Reddit API (PRAW)                   | Sentiment + thread topic + author karma           |
| 5 | Competitive LLM Monitoring                 | §2.1 extended with competitor roster     | Competitor mention share, co-citation, praise     |
| 6 | Entity Optimization & Structured Signals   | §4.2 Structured Signal & Entity Alignment| Schema coverage + third-party NAP/entity parity   |
| 7 | MarketBrew™ Search Engine Modeling         | §4.3 PSO-based algorithmic simulation    | Predicted rank Δ from content change              |
| 8 | (Implicit) Reporting / client dashboard    | §3.1 Streamlit in framework; see §5      | Rolled-up scores, trends, remediation queue       |

All eight are in-scope for v1. Modules 1, 2, 4 are the **diagnostic MVP**; 3, 5, 6 are **ongoing optimization**; 7 is **advanced/R&D**.

---

## 3. Architecture

The framework mandates a Python stack (LangGraph, Playwright, Pinecone, HuggingFace, PRAW). We keep that for the engine and layer a Next.js dashboard on Vercel for the client-facing portal — Python cannot run the browser-heavy scraping stack inside Vercel Functions (Playwright + stealth needs a long-running container).

```
┌─────────────────────────────────────────────────────────────────────┐
│  Client portal (Next.js 16 on Vercel)                               │
│  • Auth (Clerk) • Dashboards • Brand Truth editor • Remediation UI  │
└──────────────┬──────────────────────────────────────────────────────┘
               │ tRPC / REST
┌──────────────▼──────────────┐        ┌────────────────────────────┐
│  API gateway (FastAPI)      │◄───────┤  Vercel Cron / Queues      │
│  Python 3.12, pydantic v2   │        │  triggers scheduled audits │
└──────────────┬──────────────┘        └────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────────┐
│  Orchestration layer (LangGraph)                                    │
│  One graph per job type: audit, visibility, suppression, reddit,    │
│  competitive, entity, marketbrew-sim                                │
└──────┬────────────┬────────────┬───────────┬──────────────┬─────────┘
       │            │            │           │              │
┌──────▼──────┐ ┌───▼────┐ ┌─────▼─────┐ ┌───▼─────┐ ┌──────▼────────┐
│ LLM query   │ │ Web    │ │ Sentiment │ │ Schema  │ │ MarketBrew    │
│ pool        │ │ scraper│ │ (legal-   │ │ scanner │ │ PSO simulator │
│ (async      │ │ pool   │ │  BERT)    │ │         │ │ (NumPy/       │
│  asyncio    │ │ Playw- │ │           │ │         │ │  DEAP)        │
│  fan-out)   │ │ right  │ │           │ │         │ │               │
└──────┬──────┘ └───┬────┘ └─────┬─────┘ └───┬─────┘ └──────┬────────┘
       │            │            │           │              │
       └────────────┴────────────┴───────────┴──────────────┘
                                │
       ┌────────────────────────┴──────────────────────────┐
       │ Storage                                           │
       │ • Postgres (Neon via Vercel Marketplace): jobs,   │
       │   runs, scores, citations, remediation tickets    │
       │ • Pinecone: Brand Truth + page embeddings         │
       │ • Vercel Blob (private): HTML/AIO screenshots,    │
       │   raw LLM JSON responses                          │
       │ • Redis (Upstash): queue + rate-limit buckets     │
       └───────────────────────────────────────────────────┘
```

**Where Python runs.** Workers live in Docker on **Fly.io** (region control for residential-proxy egress > Railway DX). Vercel Functions host the API proxy + webhooks; heavy work is dispatched to workers via a queue.

**Why not all-Vercel.** Fluid Compute Python is capable, but community reports confirm it **breaks Playwright scraping** (image size, cold starts, proxy routing, job duration). Local HuggingFace models also prefer a stable container. Celery-style long jobs want a real worker.

**Marketplace consolidation.** Clerk (auth), Neon (Postgres), Upstash (Redis), Pinecone (vectors), Blob (storage) all provisioned **via Vercel Marketplace** so billing is one invoice. Fly.io is the only external invoice.

---

## 4. Data model (key tables)

```
firm                (id, name, brand_truth_json, competitors[], practice_areas[])
audit_run           (id, firm_id, kind, started_at, status, cost_usd)
query               (id, audit_run_id, text, practice_area, intent)
model_response      (id, query_id, provider, model, attempt, raw_json, latency_ms)
consensus_response  (id, query_id, self_consistency_k, majority_answer, variance)
citation            (id, consensus_response_id, url, domain, rank, type)
alignment_score     (id, consensus_response_id, mentioned, tone_1_10, rag_label,
                     gap_reasons[], remediation_priority)
page                (id, firm_id, url, title, fetched_at, embedding_id, hash)
legacy_finding      (id, page_id, semantic_distance, action, rationale)
remediation_ticket  (id, firm_id, source_type, source_id, status, owner,
                     playbook_step, due_at)
reddit_mention      (id, firm_id, subreddit, post_id, sentiment, karma, ts)
competitor_mention  (id, firm_id, competitor_id, query_id, share, praise_flag)
entity_signal       (id, firm_id, source, url, nap_hash, verified_at)
marketbrew_scenario (id, firm_id, baseline_serp_snapshot_id, proposed_change,
                     predicted_rank_delta, confidence)
```

---

## 5. Module-by-module design

### 5.1 Trust Alignment Audit

**Inputs.** Brand Truth JSON (schema below) + seed keyword set per practice area (e.g., "best cosmetic dentist Austin").

**Brand Truth schema (v1).**
```jsonc
{
  "firm_name": "Smile Studio Austin",
  "name_variants": ["Smile Studio", "Smile Studio ATX"],
  "common_misspellings": ["Smile Studios", "Smiles Studio"],
  "practice_areas": ["cosmetic dentistry", "Invisalign", "dental implants"],
  "geographies_served": [{"city":"Austin","state":"TX","radius_mi":25}],
  "unique_differentiators": ["same-day crowns", "sedation-trained DDS"],
  "required_positioning_phrases": ["family-owned since 2008"],
  "banned_claims": ["best dentist", "#1 rated", "painless"],   // per-state ad rules
  "attorney_bios": [],                                         // (n/a for dental)
  "provider_bios": [{"name":"Dr. Jane Doe DDS","credentials":["DDS, UT Austin"]}],
  "notable_cases": [],                                          // PI-specific; unused for dental
  "awards": [{"name":"Austin Monthly Top Dentist 2025",
              "source_url":"https://austinmonthly.com/..."}],  // drives schema verification
  "tone_guidelines": "warm, confident, plainspoken; never clinical jargon",
  "target_audience": ["families 30-55", "young professionals seeking cosmetic"],
  "compliance_jurisdictions": ["TX"]                            // drives banned-claim rules
}
```
`banned_claims` is critical — bar & dental-board ad rules vary by state ("best X," "#1," "painless" are prohibited in several). Validator runs against a per-jurisdiction rulebook before any remediation copy ships. Stored as a versioned record (every edit creates a new `brand_truth_version`) so audit runs tie to the exact truth in effect.

**Flow.**
1. Keyword expansion via People-Also-Ask + query templates (e.g., "who is the best {practice} lawyer in {city}", "should I hire {firm_name}", "{firm_name} reviews").
2. Fan-out to OpenAI, Anthropic, Gemini, Perplexity with `asyncio.gather`. Each query runs **k=3** times (self-consistency).
3. Per response: (a) mentioned? (b) tone score 1–10 vs. Brand Truth (LLM-as-judge with rubric), (c) citation list.
4. Consensus aggregation → majority vote on mention, average on score, union on citations.
5. RAG label: Red (no mention or factually wrong), Yellow (mentioned but off-brand), Green (brand-accurate & positive).
6. Remediation tickets auto-created for Red rows.

**Non-determinism mitigation.** k=3 self-consistency + temperature=0 where provider allows + cache on (model, prompt_hash, day).

### 5.2 Brand Visibility & Citation Mapping

Same pipeline as 5.1 but stores **citation URLs** with rank order. Aggregates into:
- **Share of Voice** per model per practice area.
- **Source-origin graph**: domains that LLMs cite when describing the firm. Prioritize those nodes for link/PR effort.
- **Citation drift** — weekly diff of cited sources.

### 5.3 Legacy Content Suppression

1. Crawl firm site (sitemap-first, fallback to BFS, respect robots).
2. Extract main content (readability-lxml) → embed with `text-embedding-3-large`.
3. Compute cosine distance from Brand Truth centroid.
4. Threshold rules:
   - d > 0.45 AND low traffic → **no-index**.
   - d > 0.45 AND has backlinks → **301 to closest aligned page**.
   - d in (0.30, 0.45] → **AI-assisted rewrite** (Claude long-context, keeps entities, fixes positioning).
5. Output a remediation PR spec (or WordPress-ready payload) per page.

### 5.4 Reddit Sentiment Monitor

1. PRAW pull (commercial tier) on: firm name variants, competitors, vertical subs (dental: r/Dentistry, r/askdentists, city subs; PI: r/legaladvice, r/personalinjury).
2. Sentiment classifier fine-tuned per vertical (distilbert base) — labels: praise / complaint / neutral / recommendation-request.
3. Flag: any negative thread > karma 10 or with LLM-indexable domain (old.reddit.com renders for crawlers); surface to dashboard with suggested reply guidance (firm-authored or digital-PR opportunity).
4. **Poll cadence: every 24h.** (Previously proposed 15 min; polling cost doesn't justify that for the signal value.)
5. Cross-feeds §5.2 — Reddit is a high-weight LLM citation source, so negative threads are a direct AEO risk.

### 5.5 Competitive LLM Monitoring

Reuses 5.1/5.2 infra with competitor roster. Extra metrics:
- **Share-of-mention** vs. each competitor per query cluster.
- **Praise asymmetry** — when LLMs describe competitor X as "aggressive trial attorney" vs. our firm as generic.
- **Citation gap** — sources LLMs use for competitors but not for us → target those sources for guest content / directory placement.

### 5.6 Entity & Structured Signals

1. Schema scanner (static + JS-rendered) for every key page. Check `LegalService`, `Organization`, `Person` (attorneys), `Review`, `FAQPage`, `ImageObject` (with `creditText`/`creator`).
2. Third-party parity scan: BBB, Super Lawyers, Avvo, Justia, Martindale, state bar directory. Pull firm record, hash NAP + description, flag divergence.
3. Trust-badge verification metadata — where the firm claims "Super Lawyers 2025," ensure the badge image has `creator`/`acquireLicensePage` schema tying back to the authoritative source.
4. Output: schema patch set (JSON-LD blocks to deploy) + a list of external records that need updating.

### 5.7 Scenario Lab (renamed from MarketBrew™)

MarketBrew is a real commercial product (marketbrew.ai); using the name for our own module is a trademark problem. **Proposed rename: "Scenario Lab"** (alt: "Rank Simulator", "PreFlight Ranker" — pick one).

**Scope: post-MVP R&D track, not v1.** Cut from the critical path to first billable client. Builds only after Phases 1–4 are live and producing revenue.

When we do build it:
1. **Feature layer.** For each candidate URL, extract ~80 features (on-page: title/H1 alignment, entity density, internal-link authority; off-page: ref-domains count, anchor diversity; user: CTR proxy; AI: cited-by-LLM count).
2. **Calibration corpus.** Pull top-20 SERPs for 200 seed queries in the target geo/practice mix; label with observed ranks. No existing calibration data — clean build.
3. **Model.** Gradient-boosted ranker (LightGBM `lambdarank`) trained on calibration corpus produces a baseline ranking function.
4. **PSO layer.** Treat the ranker's feature weights as particles; run PSO to find weight vectors that *best reproduce observed SERPs*. Ensemble the top-N swarms to approximate Google's implicit weighting.
5. **Scenario simulator.** Given a proposed content change, recompute features, re-score with the ensemble, report predicted rank Δ + 90% CI.
6. **Validation.** Hold-out SERPs; track simulator's hit-rate over time; only surface predictions above a calibrated confidence threshold.

Honest caveat for client messaging: we are not replicating Google. We are building a **calibrated proxy** good enough to rank-order proposed changes.

### 5.8 Client dashboard (Next.js on Vercel)

Pages: Overview (RAG mix over time), Audits (per-run drilldown), Citations (source graph), Reddit, Competitors, Suppression queue, Entity health, MarketBrew scenarios, Brand Truth editor. Auth via Clerk (Vercel Marketplace integration); multi-tenant from day one.

---

## 6. Non-functional design

- **Scheduling.** Weekly full audit per firm; **daily audit on top 10–20 priority queries** per firm; Reddit polled **every 24h**; citation diff nightly. Vercel Cron → API → job queue. Monthly client-facing report generated from the audit archive and handed to the **existing N8N monthly SEO reporting pipeline** for delivery — not a second report pipeline.
- **Cost control.** Per-firm monthly LLM budget cap; queries cached 24h; k=3 only on high-priority queries, k=1 elsewhere.
- **Observability.** OpenTelemetry traces from worker into Vercel's observability; structured run logs per job; alerting on Alignment Gap regressions.
- **Security / compliance.** Brand Truth JSON + raw LLM outputs are firm-confidential — stored in private Blob + row-level Postgres policies per firm. Legal-review the TOS for Reddit, Perplexity scraping. Use Perplexity's Sonar API where possible (official, avoids scraping).
- **Rate-limit & scraping.** Residential proxy pool (Bright Data); per-provider API rate limiters; exponential backoff; per-target fingerprint rotation for Playwright.
- **Determinism.** temperature=0 when available, store model version in every response row, re-query if model version changes mid-run.

---

## 7. Phased roadmap

| Phase | Duration | Scope | Exit criteria |
|-------|----------|-------|---------------|
| **0. Scaffolding** | 1 wk | Monorepo, CI, infra (Fly + Vercel Marketplace: Clerk/Neon/Upstash/Pinecone/Blob), Brand Truth schema + form editor, procurement checklist complete | `npm run dev` + worker Docker boots; firm + Brand Truth can be created end-to-end |
| **1. Diagnostic MVP** | 2–3 wk | §5.1 Audit + §5.2 Visibility (OpenAI + Anthropic via direct APIs; Gemini + Claude via Vertex Model Garden), CSV export per framework §5.1 | Dental pilot firm run end-to-end, RAG scores + citations visible |
| **2. Monitoring** | 2 wk | Add Perplexity Sonar + Google AIO capture (SerpAPI/DataForSEO primary, Playwright fallback) + Reddit + scheduling | Weekly auto-run + daily top-20; Reddit mentions streaming |
| **3. Optimization** | 2–3 wk | §5.3 Suppression + §5.6 Entity + **monthly client report generation into existing N8N pipeline** + designer pass on dashboard + bar/dental-board ethics counsel review | Remediation queue actionable; schema patches exported; first client-facing report delivered |
| **4. Competitive** | 1 wk | §5.5 — reuse pipeline with competitor roster | Share-of-voice + praise asymmetry report |
| **5. Hardening** | ongoing | Cost caps per firm, SLOs, audit logs, self-serve onboarding, compliance posture | Client-self-serve onboarding flow live |
| **Post-v1 R&D: Scenario Lab** | 3–4 wk | §5.7 end-to-end; validation dashboard | Scenario sim w/ documented hit-rate vs. hold-out — gated on Phase 1–4 revenue |

**Total to first billable client: ~6–8 weeks** through Phase 3. (MarketBrew/Scenario Lab no longer on the critical path.)

---

## 8. Risks & open questions

**Risks**
- LLM provider TOS on programmatic querying — especially Perplexity web UI; stick to **Sonar API** (~$3/$15 per 1M in/out tokens + request fees).
- Google AI Overviews capture is fragile; primary = **SerpAPI or DataForSEO** (licensed SERP capture), fallback = Playwright. Gap-fill narrative from Vertex Gemini 3.1 Pro directly where AIO capture fails.
- Scenario Lab (ex-MarketBrew) is the highest-variance deliverable; off the critical path; ships only after revenue is in.
- Reddit API post-2023 commercial tier is required — budget for that or go vendor route.
- Self-consistency × multi-provider = meaningful monthly LLM spend; per-firm budget caps from day 1.
- **Bar/dental-board ad compliance varies by state.** `banned_claims` enforcement is a gate on *every* piece of remediation copy. Ethics counsel review required before first client ships.
- Residential-proxy egress from Fly.io region must match target SERP geo or AIO results skew.

**Decisions locked (2026-04-16)**
1. **Tenancy.** Multi-tenant from day 1; dogfood tenant + one named dental pilot as first real client. PI is v2.
2. **APIs — have:** OpenAI, Anthropic. **Procure in Phase 0:** GCP project + Vertex AI billing (Gemini 3.1 Pro + Claude Sonnet 4.6 consolidated through Vertex Model Garden), Perplexity Sonar, Reddit commercial tier, Bright Data or Oxylabs residential proxies, SerpAPI *or* DataForSEO, per-client GSC service accounts (reuse existing N8N workflow).
3. **Infra.** Fly.io Python workers + Vercel Next.js + Marketplace (Clerk/Neon/Upstash/Pinecone/Blob).
4. **Frontend.** Next.js 16.2.3 LTS (current stable as of 2026-04-08; Next.js 14 EOL Oct 2025). Streamlit internal-only if needed.
5. **MarketBrew.** Renamed **Scenario Lab**; descoped to post-v1 R&D. No existing code.
6. **Brand Truth.** Schema defined above (§5.1). JSON + form-based editor in dashboard; versioned.
7. **Cadence.** Weekly full audit; daily top 10–20 priority queries; Reddit 24h; monthly client report via existing N8N pipeline.
8. **Team.** Solo + Claude Code. Designer pass at Phase 3. Ethics counsel review before client launch.

**Still-open items**
- Which name for Scenario Lab (vs. "Rank Simulator" / "PreFlight Ranker")?
- Which dental pilot client is the P0 tenant — name + website + current Brand Truth draft?
- SerpAPI vs. DataForSEO preference (cost/coverage tradeoff — DFS cheaper at volume, SerpAPI simpler).
- Bright Data vs. Oxylabs for residential proxies (same tradeoff pattern).

---

## 9. What I'll do next (once you confirm)

**Phase 0 scaffolding (week 1):**
1. Init monorepo: `apps/web` (Next.js 16.2.3 LTS), `apps/api` (FastAPI), `apps/worker` (Python 3.12 + LangGraph + Playwright-Docker), `packages/shared` (TS types with pydantic mirroring via codegen).
2. Provision via Vercel Marketplace: Clerk, Neon, Upstash, Pinecone, Blob. Wire Clerk to Next.js; wire Neon to both `apps/web` and `apps/worker` via connection pooler.
3. Stand up Fly.io app for the Python worker with a Playwright-Chromium base image + residential-proxy env wiring.
4. Ship the **Brand Truth editor** (form UI + JSON-schema validation + version history) — this unblocks every downstream module.
5. Procurement checklist: open GCP + Vertex, Perplexity Sonar, Reddit commercial tier applications, proxy vendor, SERP API.

Before I write any scaffold code I'll invoke the Vercel `knowledge-update` and `nextjs` skills to pull current Next.js 16 App Router + Vercel platform docs — not relying on memorized APIs.

**Decision I need from you to start Phase 0:**
- Green light the plan.
- Name the dental pilot client (or confirm "dogfood-only until identified").
- Pick: Scenario Lab name / SerpAPI vs. DataForSEO / Bright Data vs. Oxylabs (or defer and I'll pick defaults).

— end of plan —
