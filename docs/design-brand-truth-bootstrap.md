# Design: Brand Truth Bootstrap

**Date:** 2026-05-11
**Status:** Ready to implement
**Owner:** Operator efficiency

## Problem

Authoring a Brand Truth payload by hand for a new client takes 30-60 minutes
(field-by-field interview, copy-pasting from the firm's website, looking up
their state's banned-claims rulebook). Every field is recoverable from public
sources — the firm's website, GBP, BBB profile, press mentions — but the
operator has to manually collate it.

This bottlenecks new-client onboarding. The first 30 seconds of an audit run
are the most valuable demo moment; the 30 minutes of Brand Truth authoring
that precede it are the most painful.

## Goal

Operator pastes a firm name + URL + firm_type → 30 seconds later, a Brand
Truth v1 lands in the editor pre-populated with everything the tool could
extract from public sources. Operator reviews, corrects 3-5 fields the LLM
got wrong or didn't know, hits Save. Done.

## Non-goals (v1)

- Auto-publishing the bootstrapped Brand Truth without operator review
- Bootstrapping from sources other than the firm's primary website
  (GBP, LinkedIn, press mentions are v2)
- Re-bootstrapping an existing firm's Brand Truth (replacing v3 with v4 from
  a fresh scan — v2 feature, requires diff UI)
- Inventing `banned_claims` from the rulebook (jurisdiction-driven defaults
  are v2; for now banned_claims stays empty for the operator to fill in)

## Pipeline

```
  primaryUrl + firmType + firmName
            │
            ├─ crawlViaSitemap (existing) → URL list
            │       ↓
            │  rank by path: '/'/about/services/team/locations/contact
            │       ↓
            │  top 5-8 URLs
            │
            ├─ fetchAndExtract per URL (existing) → main-content text per page
            │
            ├─ scanJsonLd on homepage (existing) → JSON-LD blocks
            │
            ↓
       Claude Sonnet 4.5 long-context call
            • System: "synthesize a Brand Truth payload"
            • User: firm details + JSON-LD blocks + scraped page contents
            • Output: JSON conforming to brandTruthSchema[firm_type] variant
            ↓
       JSON parse + Zod validate against brandTruthSchema
            ↓
       Return { ok: true, payload, provenance, costUsd, latencyMs }
```

## Trust model

The bootstrapped payload is a **draft**. It's not auto-saved as a
brand_truth_version row. The flow is:

1. Bootstrap call returns the payload to the calling context (server action).
2. The server action saves the payload as `brand_truth_version` v1 only if
   it passes Zod validation AND the firm has no prior version.
3. Operator lands on the editor with the v1 pre-filled. Every field is
   editable. Operator's first Save creates v2 with their corrections.

Why not return as a "draft, not yet saved" payload that the operator
explicitly accepts? Because:
- The BT editor already supports versioning — every save creates a new
  version anyway, so the v1-as-bootstrap doesn't lose history.
- The operator's first action is "review and correct", which they have to
  do regardless of whether v1 is on disk or in a draft state. Persisting
  v1 means we don't lose the bootstrap if the operator's session times out.
- Versions are cheap (one DB row, no extra cost).

## What's reliable vs unreliable

Fields the bootstrap will get **right** most of the time:
- `firm_name`, `primary_url` (input)
- `headquarters` from `LocalBusiness` / `Organization` JSON-LD
- `service_offerings` / `practice_areas` from /services or /practice-areas page
- `service_areas` / `geographies_served` from /locations or footer
- `unique_differentiators` from hero copy + "why us" pages
- `required_positioning_phrases` from headline / value-prop copy
- `tone_guidelines.voice` from sample copy across pages
- `seed_query_intents` (model synthesizes mix of brand + intent queries)

Fields the operator will need to **correct or add**:
- `banned_claims` — jurisdiction-specific, defaulted to empty (v2: pull from
  rulebook by compliance_jurisdictions)
- `compliance_jurisdictions` — operator picks
- `attorney_bios` / `provider_bios` / `team_members` — site may have a
  team page but model may miss credentials, bar numbers, license numbers
- `awards` — only the ones visible on the site; many awards live elsewhere
- `notable_cases` — typically not on the public site
- `competitors_for_llm_monitoring` — operator's call; model can suggest
  competitors based on the firm's geography + space, but the operator
  decides who to actually track

## Provenance

Each bootstrap call returns a `BootstrapProvenance` object captured into
the editor footer so the operator can see what the model was working
from:
- `pagesScanned: number`
- `pagesUsed: string[]` — URLs we fed the model
- `jsonLdTypesDetected: string[]` — `LegalService`, `LocalBusiness`, etc.
- `modelUsed: string` — exact model id
- `costUsd: number`
- `latencyMs: number`

(Stored on the brand_truth_version row in a new optional `bootstrap_meta`
JSONB column, behind a small migration.)

## Cost

Per bootstrap call (one Claude Sonnet 4.5 invocation with ~20k input
tokens of scraped content + JSON-LD + ~5k output tokens of structured
JSON): **~$0.20 to $0.40**.

This is a one-time onboarding cost per firm — negligible vs the recurring
monthly audit budget.

## Failure modes + handling

| Failure | Cause | Handling |
|---|---|---|
| `Brand Truth missing primary URL` | Operator skipped the URL field | UI required field, no API call without URL |
| Sitemap fetch 403 | WAF (Cloudflare etc.) | Fall back to scraping homepage only |
| 0 pages with extractable content | Pure JS-rendered site | Return `{ ok: false, reason: 'no_extractable_content' }`, surface a UI message: "We couldn't read this site. Author Brand Truth manually." |
| Claude returns non-JSON | Prompt-following failure | Return ok:false with model output as reason. UI offers retry. |
| Claude returns JSON that fails Zod | Schema mismatch (LLM hallucinated extra fields, wrong types) | Return ok:false with Zod error. UI offers retry; logs the diff for prompt tuning. |
| Cost cap exceeded | DEFAULT_FIRM_MONTHLY_CAP_USD reached pre-bootstrap | Bootstrap doesn't charge against firm budget (bootstrap is operator-config, not audit). Tracked separately. |

## Integration points

1. **New module:** `apps/web/app/lib/brand-truth/bootstrap.ts`
   - Exports `bootstrapBrandTruthFromUrl(args): Promise<BootstrapResult>`
   - No DB writes — pure synthesis.

2. **New server action:** `bootstrapBrandTruthForFirm(firmSlug, primaryUrl)`
   in `apps/web/app/actions/brand-truth-actions.ts`
   - Runs bootstrap, persists as `brand_truth_version` v1 if firm has no
     versions yet.
   - Returns the saved version or an error.

3. **UI: new-client form** — add an optional "Primary URL" field. If
   provided, after `createFirm` succeeds:
     a. Call `bootstrapBrandTruthForFirm(slug, url)`.
     b. Redirect to `/dashboard/{slug}/brand-truth` with `?bootstrap=ok|failed`.
   - If empty, behave as today (redirect to BT editor, no bootstrap).

4. **UI: BT editor** — when `?bootstrap=ok`, show a one-time banner:
   "Brand Truth bootstrapped from {primaryUrl}. Review and correct, then
   save to create v2."

5. **Migration:** add `bootstrap_meta` jsonb column to
   `brand_truth_version` (optional, nullable).

## Prompt design

The Claude prompt:
1. States the task ("synthesize a Brand Truth payload").
2. Inlines the Zod schema as TypeScript types (just the firm-type variant
   the operator picked, not the full union — keeps the prompt focused).
3. Inlines the JSON-LD blocks we scraped (raw JSON, not summarized).
4. Inlines the page contents (5-8 pages × ~3000 chars each).
5. Spells out the output format: JSON object, no prose, no preamble,
   inside a single ```json fence.
6. Explicit "leave fields empty / null if you can't tell from the source
   material" — no hallucination.
7. Explicit "banned_claims: return as empty array" — operator owns this.

Output parsing:
- Extract JSON between first ```json fence (preferred) or first {...} block.
- `JSON.parse` → Zod validate against the discriminated-union variant for
  `firm_type`.

## Testing plan

- **Unit:** prompt builder produces deterministic output given fixture pages
- **Unit:** response parser handles fenced and unfenced JSON
- **Integration:** end-to-end against `reimerhvac.com` — payload validates,
  populates ≥80% of optional fields
- **Manual:** rerun against `cellinolaw.com` (law_firm variant) — payload
  validates with `practice_areas` + `geographies_served` populated

## What we ship in this PR

- `apps/web/app/lib/brand-truth/bootstrap.ts` (the function)
- `apps/web/app/actions/brand-truth-actions.ts` (the action)
- Drizzle migration: `brand_truth_version.bootstrap_meta` jsonb null
- `apps/web/app/dashboard/new-client/new-client-form.tsx` (URL field +
  trigger)
- `apps/web/app/dashboard/[firmSlug]/brand-truth/page.tsx` (banner on
  `?bootstrap=ok`)
- This design doc

## What's deferred to v2

- "Re-bootstrap" button on existing firms with a diff/merge UI
- GBP enrichment (Place API)
- LinkedIn / press-mention enrichment
- Jurisdiction-defaulted banned_claims population
- Provenance per-field tagging in the editor
