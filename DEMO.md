# Manager Demo — Cellino Law end-to-end

This runbook gets a fully working demo on screen in ~15 minutes from cold.
The seed firm is **Cellino Law** (NY personal-injury). The flow is identical
for any other firm — change the seed JSON.

---

## 1. One-time setup (5 min)

```bash
# pnpm via corepack (already installed in this worktree)
corepack pnpm install
```

## 2. Provision the must-have services (5 min)

You need three credentials. The demo gracefully skips modules whose keys are
missing — so even partial provisioning produces a working demo.

| Service | Purpose | Where | Time |
|---|---|---|---|
| **Neon Postgres** | DB | https://console.neon.tech → New Project, free tier | 2 min |
| **OpenAI** | embeddings + alignment scorer + audit provider | https://platform.openai.com/api-keys | already have? |
| **Anthropic** | second audit provider | https://console.anthropic.com/settings/keys | already have? |

Copy `.env.local.example` to `.env.local` and fill in:

```
DATABASE_URL=...                   # Neon pooled connection string
DATABASE_URL_UNPOOLED=...          # Neon direct (for migrations)
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-...
DEFAULT_FIRM_MONTHLY_CAP_USD=50
```

**Optional adds** (each unlocks one more demo module):
- `OPENROUTER_API_KEY` — Gemini in the audit consensus
- `PERPLEXITY_API_KEY` — Perplexity Sonar in the audit consensus
- `RAPIDAPI_REDDIT_KEY` — Reddit sentiment stage
- `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` — AI Overview capture stage

## 3. Run migrations (1 min)

Migrations use the unpooled connection (DDL can't go through pgbouncer):

```bash
corepack pnpm --filter @ai-edge/db migrate:demo
```

Verify in Neon's Tables view — you should see 30+ tables including `firm`,
`brand_truth_version`, `audit_run`, `alignment_score`, `aio_capture`.

## 4. Seed Cellino Law (10 sec)

```bash
corepack pnpm --filter @ai-edge/web demo:seed
```

Expected output:

```
[seed] created firm "cellino-law" → <uuid>
[seed] wrote brand_truth_version v1
[seed]   + competitor "William Mattar"
[seed]   + competitor "Jed Dietrich Law"
[seed]   + competitor "The Barnes Firm"
[seed]   + competitor "Andrews Bernstein Maranto & Nicotra"
[seed]   + competitor "Lipsitz & Ponterio"
[seed] done.
```

## 5. Run the demo orchestrator (3–8 min, ~$1–3 of LLM spend)

```bash
corepack pnpm --filter @ai-edge/web demo:run
```

What you'll see on screen, stage by stage:

```
╔══════════════════════════════════════════════════════════════════════╗
║         Clixsy Intercept — Cellino Law end-to-end demo              ║
╚══════════════════════════════════════════════════════════════════════╝
firm: Cellino Law (...)  brand_truth: v1

────────────────────────────────────────────────────────────────────────
  STAGE 1/5: Trust Alignment Audit (limit=3)
────────────────────────────────────────────────────────────────────────
  → run <uuid>: status=completed, cost=$0.4231, 38.4s
  → RAG mix: green=2  yellow=1  red=0
  → model_responses persisted: 18
  → citations: 12
  → competitor mentions detected: 4

────────────────────────────────────────────────────────────────────────
  STAGE 2/5: Legacy Suppression scan against cellinolaw.com (maxUrls=15)
────────────────────────────────────────────────────────────────────────
  → run <uuid>: status=completed, 22.1s
  → findings by action: { rewrite: 3, noindex: 1 }
  → pages embedded: 12

────────────────────────────────────────────────────────────────────────
  STAGE 3/5: Entity / schema / Knowledge Graph probe
────────────────────────────────────────────────────────────────────────
  → run <uuid>: status=completed, 3.2s
  → website      flags=missing_required_Person, missing_required_Review
  → wikidata     flags=no_wikidata_entity
  → google-kg    flags=no_api_key_configured

────────────────────────────────────────────────────────────────────────
  STAGE 4/5: Reddit sentiment scan
────────────────────────────────────────────────────────────────────────
  → RAPIDAPI_REDDIT_KEY not set — skipping (or full mention table on success)

────────────────────────────────────────────────────────────────────────
  STAGE 5/5: AI Overview capture (Google AIO)
────────────────────────────────────────────────────────────────────────
  → DATAFORSEO_* not set — skipping (or live AIO capture on success)

────────────────────────────────────────────────────────────────────────
  STAGE Σ: Summary for Cellino Law
────────────────────────────────────────────────────────────────────────
  runs:
    entity         completed                     $  0.0000
    suppression    completed                     $  0.0000
    daily-priority completed                     $  0.4231

  open remediation tickets: 4

  → Dashboard: http://localhost:3000/dashboard/cellino-law
```

The numbers above are realistic ranges — actual cost depends on which
providers you enabled and how many tokens each query consumes.

## 6. Show the live dashboard (the manager-facing part)

```bash
corepack pnpm --filter @ai-edge/web demo:dev
```

Wait for `Ready in ...ms`, then open **http://localhost:3000/dashboard**.

### The 90-second walkthrough

1. **`/dashboard`** — workspace home. The Cellino Law card shows up with
   firm-type icon, last-audit timestamp, open-tickets count.

2. **`/dashboard/cellino-law`** — firm overview. Headline tiles:
   *Brand Truth v1*, last audit, Reddit scan status, **Alignment Trend**
   sparkline (one bar so far), **LLM Budget** tile (~$0.40 of $50 cap).

3. **`/dashboard/cellino-law/brand-truth`** — versioned editor with
   the full schema rendered as forms. Walk the practice areas, banned
   claims, seed query intents.

4. **`/dashboard/cellino-law/audits`** — the run from Stage 1 is here.
   Click in → per-query drilldown showing **what each model said**
   about Cellino vs the firm's Brand Truth, side-by-side with the
   RAG label + gap reasons + factual errors.

5. **`/dashboard/cellino-law/visibility`** — share of voice per
   model + the citation source graph. For Cellino expect heavy
   `cellinolaw.com`, `avvo.com`, `superlawyers.com`, `nypost.com`,
   `buffalonews.com`, possibly `reddit.com`.

6. **`/dashboard/cellino-law/suppression`** — table of pages from
   cellinolaw.com with semantic distance + recommended action. Click
   one for the **AI-rewrite draft** view (proposed title/body + the
   list of entities the model preserved as a fabrication canary).

7. **`/dashboard/cellino-law/entity`** — JSON-LD scan results +
   copy-paste JSON-LD patches for the gaps (LegalService, Attorney
   Person blocks, etc.).

8. **`/dashboard/cellino-law/compliance`** — paste-and-check tool.
   Try pasting `"the best personal injury lawyer in Buffalo — guaranteed
   results"` — both phrases flagged with rule citations.

9. **`/dashboard/cellino-law/competitors`** — share of mention across
   the audit, praise asymmetry, citation gap.

10. **`/dashboard/cellino-law/reports`** — monthly-report card. Click
    "Generate now" to build the May 2026 roll-up payload.

## Cost summary

With OpenAI + Anthropic and the default `DEMO_QUERY_LIMIT=3`:

- Trust Alignment Audit: ~$0.50–$2.00
- Suppression embeddings: ~$0.001 (15 × text-embedding-3-large)
- Entity scan: $0 (HTTP fetches + Wikidata)
- Reddit (if enabled): ~$0.01 (RapidAPI request cost)
- AIO (if enabled): ~$0.01 (DataForSEO)

**Total demo cost: under $3.**

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `DATABASE_URL is not set` | dotenv path wrong | confirm `.env.local` at repo root |
| migrate: `permission denied` | using pooled URL | swap to `DATABASE_URL_UNPOOLED` |
| audit completes with zero responses | no provider keys set | add `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` |
| `Brand Truth missing a primary URL` | seed not loaded | re-run `seed-cellino.ts` |
| suppression: `No pages with enough content` | site blocked the crawler | retry, then check whether cellinolaw.com is gating |
| `firm not found` | seed never ran or DB swapped | run seed |

## If you only have 5 minutes

Run only Stage 1 (the audit). Skip the dashboard walkthrough — show the
script output. The RAG mix + competitor mentions + cost-per-run is the
single most compelling output of the whole product.
