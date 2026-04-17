# AI Edge — Phase 1 Verification Report
Generated: 2026-04-17T18:30:00Z
Commit: e1d59e3

## Executive Summary
- Total checks: 42
- PASS: 28
- FAIL: 6
- PARTIAL: 5
- SKIPPED: 3 (API keys not in .env.local — end-to-end test deferred)

## Critical Issues (must fix before Phase 2)

1. **FAIL: Remediation tickets not created for Red results.** `run-audit.ts` scores responses and stores alignment_scores with `remediation_priority` but never writes to the `remediation_tickets` table. Spec §5.1 step 6: "Remediation tickets auto-created for Red rows." Quick fix — add ticket insert after Red scoring.

2. **FAIL: `factual_accuracy.errors` silently dropped.** The alignment scorer returns `factual_accuracy: { has_errors, errors[] }` from the judge but `run-audit.ts` never persists the errors array. The CSV export's `factual_errors` column is always blank. Fix: store factual errors in alignment_scores (add a JSONB column or use the existing gap_reasons).

3. **FAIL: `validateClaims()` never called.** `packages/shared/src/compliance.ts` exports a fully functional banned-claim scanner with FTC/bar/dental/GDC rules, but it is not imported or invoked anywhere — not during Brand Truth save, not during audit scoring, not during remediation. The compliance rulebook is completely disconnected.

4. **PARTIAL: Provider matching in `getAuditDetail` is fragile.** Line 187 of `audit-actions.ts` uses index-based matching: `allMr[results.filter(r => r.queryText === q.text).length]` to guess which model_response belongs to which consensus_response. This will mislabel providers if any call fails or rows are inserted out of order. Fix: store `provider` on `consensus_responses` or `alignment_scores` directly, or match by model_response_id.

5. **FAIL: Brand Truth editor missing key_clients_public section.** The editor has sections for core identity, HQ, service offerings, positioning, banned claims, tone, audience, competitors, service areas — but does NOT render `key_clients_public` or `awards` array editing. These are in the seed data and Zod schema but invisible in the UI.

6. **FAIL: Brand Truth editor does not support viewing past versions in read-only mode.** The version history sidebar shows version numbers + timestamps but clicking does nothing — there is no version-load action or read-only viewer. Spec requires "click to view (read-only) any past version."

## Gaps vs Specification (known scope for Phase 2+)

| Gap | Phase | Severity |
|-----|-------|----------|
| Self-consistency k=3 (currently k=1) | Phase 2 | Low — triples API cost, correctness improvement only |
| Gemini + Perplexity providers | Phase 2 | Expected deferral |
| Share of Voice computation | Phase 2 | Requires multiple runs over time |
| Consensus aggregation (majority vote + average) | Phase 2 | Meaningless without k=3 |
| Web-grounded citations (providers use plain chat, not web search tools) | Phase 2 | Citations are judge-hallucinated, not live URLs |
| Legacy Content Suppression | Phase 3 | Tables exist, no logic |
| Reddit Sentiment Monitoring | Phase 2 | Tables exist, no logic |
| Competitive LLM Monitoring | Phase 4 | Tables exist, no logic |
| Entity Optimization | Phase 3 | Tables exist, no logic |
| PreFlight Ranker / Scenario Lab | Post-v1 R&D | Tables exist, no logic |

---

## Section 1: Specification Conformance

### Deliverable 1: Trust Alignment Audit (Red/Yellow/Green)
**STATUS: Implemented in Phase 1**
EVIDENCE: `run-audit.ts`, `alignment-scorer.ts`, `audit-actions.ts`, dashboard pages
GAPS:
- k=1 not k=3 (expected deferral)
- No remediation ticket creation for Red results (CRITICAL)
- `factual_accuracy.errors` not persisted (CRITICAL)
- `validateClaims()` not wired (CRITICAL)

### Deliverable 2: Brand Visibility Tracking
**STATUS: Partially scaffolded**
EVIDENCE: Citations are stored in `citations` table during audit. `citation.domain` + `citation.rank` populated.
GAPS: No Share of Voice computation. No citation drift tracking. Citations are judge-hallucinated (providers don't use web search).

### Deliverable 3: Legacy Content Suppression
**STATUS: Not started (deferred to Phase 3)**
EVIDENCE: `pages`, `legacy_findings` tables exist.

### Deliverable 4: Reddit Brand Sentiment Monitoring
**STATUS: Not started (deferred to Phase 2)**
EVIDENCE: `reddit_mentions` table exists.

### Deliverable 5: Competitive LLM Monitoring
**STATUS: Not started (deferred to Phase 4)**
EVIDENCE: `competitors`, `competitor_mentions` tables exist.

### Deliverable 6: Entity Optimization & Structured Signals
**STATUS: Not started (deferred to Phase 3)**
EVIDENCE: `entity_signals` table exists.

### Deliverable 7: PreFlight Ranker
**STATUS: Not started (deferred to post-v1 R&D)**
EVIDENCE: `scenario_runs` table exists.

### Deliverable 8: Client Dashboard
**STATUS: Implemented in Phase 1 (MVP)**
EVIDENCE: `/dashboard`, `/dashboard/brand-truth`, `/dashboard/audits`, `/dashboard/audits/[auditId]`
GAPS: No trends over time. No Citation source graph page. No Reddit/Competitors/Suppression/Entity pages.

---

## Section 2: Database Schema

| # | Check | Result |
|---|-------|--------|
| 1 | `firms.firm_type` column exists | PASS — `text` type, value 'marketing_agency' confirmed for Clixsy |
| 2 | `brand_truth_versions.version` + `payload` JSONB | PASS — `version(integer)`, `payload(jsonb)` |
| 3 | `alignment_scores` columns | PASS — `mentioned(boolean)`, `tone_1_10(real)`, `rag_label(text)`, `gap_reasons(jsonb)`, `remediation_priority(integer)` |
| 4 | `citations` table exists | PASS — `url(text)`, `domain(text)`, `rank(integer)`, `type(text)` |
| 5 | `consensus_responses` exists | PASS — `self_consistency_k(integer)`, `majority_answer(text)`, `variance(real)` |
| 6 | `remediation_tickets` exists | PASS — `status(text)`, `owner(text)`, `playbook_step(text)`, `due_at(timestamptz)` |
| 7 | `reddit_mentions` exists | PASS — `subreddit(text)`, `post_id(text)`, `sentiment(text)`, `karma(integer)` |
| 8 | `competitor_mentions` exists | PASS — `share(real)`, `praise_flag(boolean)` |
| 9 | `entity_signals` exists | PASS — `source(text)`, `url(text)`, `nap_hash(text)`, `verified_at(timestamptz)` |
| 10 | `scenario_runs` exists | PASS |
| 11 | FK chain correct | PASS — model_responses → queries → audit_runs → firms |
| 12 | Clixsy firm row seeded | PASS — id=4297c2d4, slug='clixsy', firm_type='marketing_agency' |

**All 16 tables exist with correct schemas. Total: 12/12 PASS.**

---

## Section 3: Auth Flow

| # | Check | Result |
|---|-------|--------|
| 1 | Uses `clerkMiddleware()` | PASS |
| 2 | Protects `/dashboard/*` | PASS — `auth.protect()` for non-public routes |
| 3 | `/`, `/sign-in`, `/sign-up` excluded | PASS — `isPublicRoute` matcher |
| 4 | Root layout has `<ClerkProvider>` | PASS |
| 5 | Sign-in page at `[[...sign-in]]` | PASS |
| 6 | Sign-up page at `[[...sign-up]]` | PASS |
| 7 | `<UserButton />` in dashboard header | PASS |
| 8 | Build compiles | PASS — zero errors |

**Auth: 8/8 PASS.**

---

## Section 4: Brand Truth Editor

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1 | Loads existing versions | PASS | Falls back to seed if none saved |
| 2 | All Zod fields displayed | PARTIAL | Missing `key_clients_public` and `awards` sections |
| 3 | Array field add/remove | PASS | service_offerings, banned_claims, competitors, seed_queries all have +Add/-Remove |
| 4 | Zod validation on save | PASS | `brandTruthSchema.safeParse()` server-side |
| 5 | New version row on save | PASS | Increments `max(version) + 1` per firm |
| 6 | Version history visible | PASS | Sidebar with version + timestamp |
| 7 | Click past version (read-only) | FAIL | Sidebar shows versions but they are not clickable/loadable |
| 8 | Clixsy seed: firm_name | PASS |
| 9 | Clixsy seed: HQ Layton UT | PASS |
| 10 | Clixsy seed: 3 service offerings | PASS |
| 11 | Clixsy seed: 4 banned claims | PASS |
| 12 | Clixsy seed: 7 competitors | PASS |
| 13 | Clixsy seed: 8 seed queries | PASS |
| 14 | Clixsy seed: tone_guidelines | PASS |
| 15 | Clixsy seed: target_audience | PASS |

**Brand Truth Editor: 13 PASS, 1 PARTIAL, 1 FAIL.**

Missing from editor UI:
- `key_clients_public` (array of objects with name, vertical, location, testimonial, source_url, ftc_disclosure)
- `awards` (array of objects with name, source_url, verification_status, notes)
- Past version read-only viewer

---

## Section 5: Audit Engine

### 5A: Provider Configuration
| Check | Result | Notes |
|-------|--------|-------|
| OpenAI temperature=0 | PASS | |
| OpenAI model | PASS | `gpt-4.1` |
| Anthropic temperature=0 | PASS | |
| Anthropic model | PASS | `claude-sonnet-4-20250514` |
| Promise.allSettled (not .all) | PASS | Providers fan out safely |
| Error handling per-provider | PASS | Failed provider stores error in model_responses, doesn't kill run |
| Raw JSON stored verbatim | PASS | `raw_response: result.raw as any` |
| Latency measured | PASS | `Date.now()` delta |

### 5B: Alignment Scorer
| Check | Result | Notes |
|-------|--------|-------|
| LLM-as-judge pattern | PASS | GPT-4.1 with Brand Truth + query + response |
| Judge model | PASS | `gpt-4.1` with `response_format: json_object` |
| MENTIONED evaluated | PASS | |
| TONE_SCORE evaluated | PASS | |
| FACTUAL_ACCURACY evaluated | PASS | But errors not persisted (FAIL upstream) |
| CITATIONS evaluated | PASS | |
| GAP_REASONS evaluated | PASS | |
| REMEDIATION_PRIORITY evaluated | PASS | red/yellow/green |
| RAG logic correct | PASS | Red=not mentioned OR errors, Yellow=mentioned+tone<7, Green=mentioned+tone≥7+no errors |
| JSON parse failure handling | PASS | Retry once, then fallback red |
| Results stored in alignment_scores | PASS | |

### 5C: Self-Consistency
| Check | Result | Notes |
|-------|--------|-------|
| k=3 per provider | FAIL (expected) | k=1 hardcoded. Known Phase 2 deferral. |
| Majority vote | N/A | No aggregation needed with k=1 |
| Consensus rows created | PASS | One per provider call, `self_consistency_k: 1` |

### 5D: Citation Pipeline
| Check | Result | Notes |
|-------|--------|-------|
| Citations in `citations` table | PASS | `run-audit.ts` lines 118-125 write url, domain, rank |
| Citations from real web sources | FAIL (expected) | Providers don't use web search — citations are judge-hallucinated. Phase 2 fix. |

### 5E: Remediation Tickets
| Check | Result | Notes |
|-------|--------|-------|
| Tickets created for Red | **FAIL** | No code writes to `remediation_tickets` anywhere. **Critical fix needed.** |

---

## Section 6: Dashboard & CSV

### 6A: Audit List Page
| Check | Result |
|-------|--------|
| All runs sorted newest first | PASS |
| Row shows date + status | PASS |
| Row shows Red/Yellow/Green counts | PARTIAL — counts not shown on list view, only on detail |
| "Run New Audit" button | PASS |
| Progress while running | PASS — polls every 5s with animated indicator |

### 6B: Audit Detail Page
| Check | Result |
|-------|--------|
| RAG distribution bar | PASS — horizontal stacked bar with proportional widths |
| Filterable table | PASS — All/Red/Yellow/Green filter buttons |
| Columns: Query, Provider, Mentioned, Tone, RAG, Citations | PASS |
| Expandable rows | PASS — full response + gap reasons + citation links |

### 6C: CSV Export
| Check | Result |
|-------|--------|
| Correct columns | PARTIAL — `factual_errors` always blank |
| response_preview truncated to 200 chars | PASS |
| Array fields pipe-delimited | PASS |
| Download triggers | PASS — Blob + programmatic click |

---

## Section 7: End-to-End Test

**SKIPPED** — `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` not present in `.env.local`.

To run the end-to-end test:
1. Add both keys to `.env.local`
2. Also add them to Vercel env vars: `vercel env add OPENAI_API_KEY production preview development`
3. Run `pnpm dev` and navigate to `/dashboard/brand-truth` → save the seed data
4. Navigate to `/dashboard/audits` → "Run New Audit"
5. Wait ~60-90s for completion
6. Check results + CSV export

### Build Test
| Check | Result |
|-------|--------|
| `pnpm build` zero errors | PASS |

---

## Recommended Fixes Before Moving to Phase 2

### Priority 1 (Critical — fix now)

1. **Add remediation ticket creation for Red results.** In `run-audit.ts`, after storing an alignment score with `rag_label === 'red'`, insert a row into `remediation_tickets` with `source_type: 'alignment'`, `source_id: alignmentScoreId`, `status: 'open'`.

2. **Persist `factual_accuracy.errors`.** Either add a `factual_errors` JSONB column to `alignment_scores`, or store them inside the existing `gap_reasons` array (prefix with "FACTUAL: "). Update CSV export to read from whichever column.

3. **Wire `validateClaims()` into Brand Truth save.** In `brand-truth-actions.ts saveBrandTruth()`, after Zod validation, call `validateClaims(JSON.stringify(parsed.data), parsed.data.compliance_jurisdictions)`. If any hits, return them as warnings (not blocking saves — they're informational for the user about their own copy).

4. **Add `key_clients_public` and `awards` sections to the editor.** Both are in the Zod schema and seed data but have no UI. Needs array-of-object editing similar to `banned_claims`.

5. **Fix provider matching in `getAuditDetail`.** The index-based matching is fragile. Store `provider` on `consensus_responses` or match via a join on `model_responses`.

### Priority 2 (Should fix — not blocking)

6. **Add past-version viewer to Brand Truth sidebar.** Make version rows clickable, load that version's payload via `getBrandTruthVersion(id)`, render in read-only mode.

7. **Show Red/Yellow/Green counts on audit list rows** (currently only shown on detail page).

8. **Add `CRON_SECRET` check to cron route handlers** (currently public, only protected by obscure path).

### Priority 3 (Can defer to Phase 2)

9. Enable web search on OpenAI provider (use Responses API with `web_search_preview` tool) for real citations.
10. Implement k=3 self-consistency with consensus aggregation.
11. Add active-route highlighting to sidebar nav.
12. Add client-side Zod validation preview before server save.
