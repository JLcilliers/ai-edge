# SOP Execution Engine — Design Doc

**Author:** Claude (per Johan's directive after the manager-review pivot)
**Status:** In progress — Day 1 of 3
**Source material:** `C:\Users\johan\Desktop\SEO Info\Steve Toth Info.docx` (Steve Toth AEO Coaching SOPs) + `Brand Optimization Playbook.pdf`

## The problem we're fixing

Today the dashboard is a **reporting tool**: every tab tells the operator what's wrong, but stops short of telling them what to fix, in what order, by whom, by when, with what exact remediation copy. Steve Toth's SOPs are explicit — every step ends in a concrete deliverable, every audit ends in a **Priority Actions list**, every action has an owner and a validation gate.

The fix is structural, not cosmetic. We're rebuilding the dashboard around the SOP catalog as the primary navigation, with every existing data view (audits, suppression, entity, etc.) becoming a *data feed* into the SOP that consumes it rather than a top-level tab.

## Non-goals

- **Don't rewrite the audit pipeline, suppression scanner, or entity scanner.** They produce the right raw data. The job is to wrap them in an SOP-execution layer that turns findings into assignable, validated, deliverable work.
- **Don't build a generic project-management tool.** This is SOP-specific. Each SOP has a fixed step graph; this isn't Asana.
- **Don't gate Phase N data behind Phase N-1 completion in a way that blocks demos.** Sequencing is enforced but operators can override with a logged reason.

## The 24 SOPs

| Phase | SOPs | LOE per SOP |
|---|---|---|
| 1. Brand Audit & Analysis | Brand Visibility Audit · Legacy Content Suppression · Brand Messaging Standardization | 30 min – 5 hr |
| 2. Measurement & Monitoring | GA4 LLM Traffic Setup · AI Bot Log File Analysis · Bi-Weekly LLM Monitoring | 45 min – 2 hr |
| 3. Content Optimization | Deep Research Content Audit · Comparison Page Creation · Content Repositioning · LLM-Friendly Content Checklist · Content Freshness Audit | 15 min – 4 hr per page |
| 4. Third-Party Optimization | Golden Links Opportunity Analysis · Entity Optimization · Reddit Brand Sentiment Monitoring | 1 – 6 hr |
| 5. Technical Implementation | AI Info Page Creation · Schema Markup Deployment · Semantic HTML Optimization | 30 min – 2 hr |
| 6. Content Generation | SME Content Generation · Trust Alignment Audit | 30 min – 4 hr |
| 7. Client Services | Weekly AEO Reporting · AEO Discovery Call · AEO Audit Delivery · Competitive LLM Monitoring | 30 min – 2 hr |

## Data model

### New tables

**`sop_run`** — one row per (firm × SOP instance)
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| firm_id | uuid fk firm | cascade delete |
| sop_key | text | e.g. `brand_visibility_audit` — stable identifier mapped to registry |
| phase | int 1-7 | denormalized for fast Phase grids |
| status | text | `not_started` · `in_progress` · `awaiting_input` · `completed` · `paused` · `cancelled` |
| current_step | int | 1..N where N is registry's step count |
| started_at | timestamptz | null until first step starts |
| completed_at | timestamptz | null until all required steps done |
| paused_at | timestamptz | null unless paused |
| next_review_at | timestamptz | for recurring SOPs (Brand Visibility every 4-6 weeks); null = one-time |
| depends_on_sop_run_id | uuid fk sop_run | null when no dependency; soft-enforced |
| meta | jsonb | SOP-specific anchors: e.g. `{ audit_run_id, brand_truth_version_id }` |
| created_by | text | operator email |
| created_at | timestamptz | |

Indexed on `(firm_id, sop_key, status)` for the Phase grid query.

**`sop_step_state`** — one row per (sop_run × step)
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| sop_run_id | uuid fk sop_run | cascade delete |
| step_number | int | 1-N |
| step_key | text | stable identifier from registry |
| status | text | `not_started` · `in_progress` · `awaiting_input` · `completed` · `skipped` |
| started_at, completed_at | timestamptz | |
| operator_confirmations | jsonb | `[{ key, label, confirmed_at, confirmed_by }]` — gate evidence |
| output_summary | jsonb | structured summary of what the step produced |
| notes | text | free-form operator notes for this step |

Unique on `(sop_run_id, step_number)`.

**`sop_deliverable`** — terminal artifacts each SOP must produce
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| sop_run_id | uuid fk sop_run | cascade delete |
| kind | text | `comparison_matrix_xlsx` · `redirect_map_csv` · `messaging_guide_md` · `schema_bundle_jsonld` · `priority_actions_list` · `phased_implementation_plan_md` |
| name | text | display name |
| payload | jsonb | structured representation (rendered server-side) |
| blob_url | text | optional download link (Vercel Blob) |
| generated_at | timestamptz | |

### Modifications to `remediation_ticket`

The current table is the closest existing thing to an action item but it's missing the prescription layer. Adds:

| Column | Type | Notes |
|---|---|---|
| sop_run_id | uuid fk sop_run | NULL allowed for legacy tickets |
| sop_step_number | int | which step generated this ticket |
| title | text | human-readable, e.g. "Update G2 category from Community Platform to AI Pipeline Tool" |
| description | text | longer explanation of why |
| priority_rank | int | 1=highest; per Brand Visibility SOP Step 7 ranking formula |
| remediation_copy | text | exact text to paste / replace (e.g. the new one-liner) |
| validation_steps | jsonb | `[{ description, completed_at }]` — what to verify after the fix |
| evidence_links | jsonb | `[{ kind, url, description }]` — which LLM cited what |

Keep existing fields: `firm_id`, `source_type`, `source_id`, `status`, `owner`, `playbook_step`, `due_at`, `created_at`.

## SOP registry (TypeScript)

Single source of truth: `apps/web/app/lib/sop/registry.ts`. Every SOP is a typed object:

```ts
export interface SopDefinition {
  key: SopKey;                              // 'brand_visibility_audit', etc.
  phase: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  name: string;
  purpose: string;                          // one-paragraph from the doc
  timeRequired: string;                     // "30-45 min per audit"
  scope: string[];                          // when to use
  prerequisites: {
    tools: string[];
    access: string[];
    data: string[];
  };
  dependsOnSops: SopKey[];                  // soft sequence
  cadence: 'one-time' | { intervalDays: number; reason: string };
  steps: SopStep[];
  troubleshooting: { issue: string; cause: string; solution: string }[];
}

export interface SopStep {
  number: number;
  key: string;
  title: string;
  process: string[];                        // bullet steps from the SOP doc
  dataInputs: SopDataInput[];               // what the tool auto-populates
  operatorActions: string[];                // what the human confirms / decides
  gates: SopGate[];                         // must-confirm before advance
  output: string;                           // what this step produces (verbatim from SOP doc)
  generates?: {
    deliverableKinds?: DeliverableKind[];
    ticketsFromFactory?: TicketFactoryKey;
  };
}

export interface SopDataInput {
  kind: 'audit_run' | 'legacy_findings' | 'citation_sources' | 'gsc_clicks' | 'aio_captures' | 'entity_signals' | 'third_party_listings' | 'brand_truth';
  label: string;
  required: boolean;
}

export interface SopGate {
  key: string;                              // 'positioning_statement_confirmed', etc.
  label: string;                            // "Confirm current brand positioning matches Brand Truth v1"
  kind: 'checkbox' | 'free_text' | 'attestation';
}
```

## State machine

```
not_started
   ↓ startSopRun()
in_progress (step 1)
   ↓ completeStep(1)         ↺ pauseSopRun() → paused
in_progress (step 2)
   ↓ ...
in_progress (step N)
   ↓ completeStep(N) + all gates passed + all deliverables generated
completed
   ↓ scheduleFollowUp() if cadence.intervalDays
next_review_at = now + intervalDays → cron auto-creates new sop_run
```

`awaiting_input` is a sub-state used when the SOP is blocked on operator action (e.g. "approve the one-line definition" in Brand Messaging Standardization Step 2).

## Routes

| Route | Purpose |
|---|---|
| `/dashboard/[firmSlug]/sops` | Phase grid — all 7 phases, each showing their SOPs with status pills + progress bars |
| `/dashboard/[firmSlug]/sop/[sopKey]` | SOP workflow shell — left rail = N steps, main area = current step |
| `/dashboard/[firmSlug]/sop/[sopKey]/step/[stepNumber]` | Deep link to a specific step |
| `/dashboard/[firmSlug]/sop/[sopKey]/deliverable/[id]` | View / download a generated deliverable |
| `/dashboard/[firmSlug]/action-items` | Renamed from `/tickets` — grouped by SOP, with owner/due/priority |

The existing tab routes (`/audits`, `/visibility`, `/suppression`, `/entity`, etc.) remain as **data views** but become surfaced from inside their consuming SOP. Top-level nav reorganizes:

```
Overview | SOPs | Action Items | Brand Truth | Settings
```

…and the old tabs become anchored links from inside the relevant SOP step.

## Migration of existing data

For Andrew Pickett Law (the demo firm):

1. Auto-create 3 Phase 1 `sop_run` rows on first hit of the new SOPs page:
   - **Brand Visibility Audit** → state: `in_progress`, current_step: 4, meta: `{ audit_run_id: <latest completed audit> }`
   - **Legacy Content Suppression** → state: `in_progress`, current_step: 3, meta: `{ legacy_findings_count: 15 }`
   - **Brand Messaging Standardization** → state: `in_progress`, current_step: 1, meta: `{ brand_truth_version_id: <v1> }`
2. Backfill `sop_step_state` rows for completed steps so the UI shows the right progress.
3. Leave existing `remediation_ticket` rows untouched; their `sop_run_id` stays NULL. New tickets generated post-migration carry the FK.

## Deliverables produced by Phase 1 SOPs

| SOP | Deliverable kind(s) |
|---|---|
| Brand Visibility Audit | `comparison_matrix_xlsx` (5 LLMs × 7 columns), `priority_actions_list` (markdown + ticket bundle) |
| Legacy Content Suppression | `decision_matrix_csv` (per-page Delete/301/No-Index/Keep), `redirect_map_csv` (source URL → target URL), `phased_implementation_plan_md` (Phase A/B/C with timeline estimates) |
| Brand Messaging Standardization | `messaging_framework_md` (one-liner 60/140/250 + elevator pitch + use cases + competitor angles), `schema_bundle_jsonld` (Organization + SoftwareApplication + FAQPage validated), `messaging_guide_md` (internal team doc) |

## Server actions (apps/web/app/actions/sop-actions.ts)

```ts
startSopRun({ firmSlug, sopKey, anchors? }) → SopRun
advanceStep({ runId, fromStep, toStep, confirmations? }) → SopStepState[]
completeStep({ runId, stepNumber, output? }) → SopRun        // auto-advances current_step
pauseSopRun({ runId, reason }) → SopRun
cancelSopRun({ runId, reason }) → SopRun
generateDeliverable({ runId, kind }) → SopDeliverable        // dispatches to per-kind builder
createTicketFromStep({ runId, stepNumber, title, ... }) → RemediationTicket
assignTicket({ ticketId, owner, dueAt, priorityRank }) → RemediationTicket
listSopRunsForFirm(firmSlug) → SopRun[]                       // with progress aggregation
getSopRun(runId) → SopRun + steps + deliverables + tickets
```

## Cadence & follow-up scheduler

Daily cron `sop-followup-scheduler`:
1. Find `sop_run` rows with `completed_at IS NOT NULL` AND `next_review_at < NOW()` AND no successor run.
2. For each, create a new `sop_run` row (`status: not_started`) with `depends_on_sop_run_id` set to the previous run's id and `meta.is_followup: true`.
3. Surface in the operator's dashboard: "Follow-up Brand Visibility Audit scheduled for [firm] — last completed N days ago."

Per the SOPs:
- Brand Visibility Audit: 4-6 weeks → `intervalDays: 35`
- Brand Messaging Standardization: quarterly → `intervalDays: 90`
- Bi-Weekly LLM Monitoring: 14 days
- Weekly AEO Reporting: 7 days
- Entity Optimization: quarterly → `intervalDays: 90`

## What stays the same

- Brand Truth (the source-of-truth payload that Brand Visibility Audit scores against)
- All scanners (audit, suppression, entity, AIO, citation-diff, GSC sync, Reddit, scenarios)
- All cron jobs that produce raw data
- DataForSEO, Anthropic, OpenAI, Google KG, GSC OAuth integrations
- The firm/tenancy model

## What changes for the operator

Before:
> "Open the dashboard, scan 13 tabs, mentally synthesize where the gaps are, manually decide what to assign to whom."

After:
> "Open the firm's SOPs page. See 3 Phase 1 SOPs in progress. Click Brand Visibility Audit — you're at Step 4 of 7. The tool has auto-populated Steps 1-4 from the last audit run; just review the alignment scores, confirm the gate, click Advance. Step 7 generates a ranked Priority Actions list as 12 tickets, each one with an owner field. Assign them. Move on to the next SOP."

## Day plan recap

- **Day 1** (today): design doc · DB migration · TypeScript registry with all 24 SOPs · server actions · /sops + /sop/[key] routes scaffolded
- **Day 2**: Phase 1 SOPs fully wired (data feeds + deliverable generators + ticket factories)
- **Day 3**: Phases 2-7 step lists rendered (data wiring placeholders), cross-SOP dependency enforcement, follow-up scheduler cron, data migration script, deploy

---

*Updates land in this doc as decisions get made.*
