# Operator Experience Research — pre-PR scope discovery

Scope: read-only DB queries + dashboard code walkthrough. No code changes.
Backing script: `apps/web/scripts/research-operator-experience.ts` +
`apps/web/scripts/research-q2-fixup.ts`. Run against the demo Neon
instance (the `.env.local` pointed at the worktree).

> **Headline reality check before reading further:** the database currently
> contains **one** firm — Andrew Pickett Law. The "130+ clients" target is
> the agency's roster, not the workspace. All cross-firm queries that follow
> return single-row results. APL's 158 open tickets are the only empirical
> data point we have on what a single firm produces. Most of the questions
> in this brief had to be answered by reading the code path that will fire
> at 130-firm scale rather than by joining across firms in the data.

---

## Q1 — Ticket volume reality

### Q1.1 — Open tickets per firm (descending)

```
slug                                   n      name
andrew-pickett-law                    158     Andrew Pickett Law
```

Single firm. 158 open tickets. Bucket counts:

```
firms_total      1
firms_>50        1
firms_>100       1
firms_>200       0
firms_=0         0
```

**Code-path projection at 130-firm scale (no extrapolation, just the scanner emit math):**
APL's 158 came from a single end-to-end pass (audit + suppression + entity +
SOP step factories). The scanner emit rates that fed APL's number:

- **brand_visibility_audit:** 43 tickets (one per Red consensus row across the audit's query set × 4 providers)
- **legacy_content_suppression:** 10 tickets (no-index from the 75-page Suppression crawl, no-GSC mode)
- **content_repositioning:** 60 tickets (the `rewrite` bucket — same Suppression scan, distance band 0.40 ≤ d ≤ 0.55)
- **content_freshness_audit:** 14 tickets
- **llm_friendly_content_checklist:** 3 tickets
- **semantic_html_optimization:** 15 tickets
- **entity_optimization:** 6 tickets
- Other Phase 2/4/5/7 SOP step factories: 7 tickets

The 60+10+14+15 = 99 page-level tickets (Suppression-ish + content/HTML
scanners) scale with the firm's sitemap size. APL is a small site (75
pages with main_content ≥150 words). A larger site would push proportionally
more.

### Q1.2 — Automation_tier × firm

```
slug                                   auto  assist  manual  null
andrew-pickett-law                       0     154       4     0
```

- **0 auto-tier** tickets. The current scanner emit code paths only ever
  set tier = `assist` or `manual`. No path in the codebase that lands on
  Andrew Pickett Law currently emits an `auto` ticket.
- **97% assist** — operators or clients have to take an action through a
  CMS / platform admin UI.
- **3% manual** — the four are likely the Wikidata-create kind (no public
  write API) and the gsc_setup config-gate ticket I shipped in C1.
- **0 null** — all C1+C2 tickets carry a tier (after PR #93 backfill).

### Q1.3 — Top firms × phase distribution

```
slug                                   phase  sop_key                                n
andrew-pickett-law                         1  brand_visibility_audit                  43
andrew-pickett-law                         1  legacy_content_suppression              10
andrew-pickett-law                         1  gsc_setup                                1
andrew-pickett-law                         2  ga4_llm_traffic_setup                    1
andrew-pickett-law                         2  ai_bot_log_file_analysis                 1
andrew-pickett-law                         3  content_repositioning                   60
andrew-pickett-law                         3  content_freshness_audit                 14
andrew-pickett-law                         3  llm_friendly_content_checklist           3
andrew-pickett-law                         4  entity_optimization                      6
andrew-pickett-law                         4  golden_links_opportunity_analysis        1
andrew-pickett-law                         5  semantic_html_optimization              15
andrew-pickett-law                         5  ai_info_page_creation                    1
andrew-pickett-law                         5  schema_markup_deployment                 1
andrew-pickett-law                         7  weekly_aeo_reporting                     1
```

Phase concentration:

```
Phase 1:  54 tickets  (34%)
Phase 2:   2 tickets  ( 1%)
Phase 3:  77 tickets  (49%)
Phase 4:   7 tickets  ( 4%)
Phase 5:  17 tickets  (11%)
Phase 6:   0 tickets  ( 0%)
Phase 7:   1 ticket   ( 1%)
```

Half the queue is Phase 3 (Content Optimization). Roughly a third is Phase
1 (Brand Audit + Suppression). Phases 2/4/6/7 are essentially empty.

### Q1.4 — Ticket age distribution

```
>7d         0
>30d        0
>90d        0
total_open  158
```

```
status           n
open           158        ← every single ticket
(none in:  in_progress, completed, closed, done, resolved)
```

```
Closed-ticket throughput last 30d:
  (no closed tickets in last 30d)

Closed APL tickets last 90d:
  (no closed APL tickets in last 90d)
```

**Every ticket in the database has status='open'.** Nothing has ever been
moved to `in_progress`, marked done, or closed. The queue has never been
drained, even partially. All 158 rows were created during recent scanner
runs (created_at within the last 7 days, otherwise the `>7d` count would
be positive). This is a demo-data environment, not a worked queue.

### Q1 observations

- **There is no cross-firm volume data.** Everything below is APL projected.
- One end-to-end scanner pass on a 75-page law-firm site produces ~160
  open tickets. That's the unit cost per firm per scan cycle.
- 97% assist / 3% manual / 0% auto is structural, not data-dependent. No
  scanner code path currently emits auto-tier tickets at all — the
  `'auto'` tier exists in the type system but every prescription helper
  (`prescribeAuditTicket`, `prescribeLegacyTicket`, etc.) hard-codes
  `automationTier: 'assist'`.
- Phase distribution is unbalanced: Phase 3 + Phase 1 are 83% of the queue;
  Phases 2/4/6/7 are nearly empty. Operator sees big numbers on two phase
  tabs and zeros on others.
- There is no signal in the database that tickets are being closed,
  paused, or worked on. We have no "drain rate" data because we have no
  state transitions.

---

## Q2 — Prioritization signal (APL, 158 tickets)

### Q2.1 — priority_rank presence + distribution

```
priority_rank by source_type:
  source_type    rank_set  rank_null  rank_max
  audit          43        0          2          ← only ranks 1 and 2
  entity         0         3          ∅          ← nothing ranked
  legacy         60        10         60         ← ranks 1..60, each ticket unique
  sop            42        0          15         ← ranks 1..15
```

Aggregate distribution (truncated):

```
null     13           ← entity (3) + Suppression noindex (10) carry no rank
rank_1   21           ← 21 different tickets ALL claim rank 1
rank_2   39           ← 39 tickets at rank 2
rank_3   5
rank_4   3
rank_5   3
rank_6   3
... (long tail of rank 7..60, each with 1-3 tickets)
```

**Ranks are not comparable across the queue.** Three different scanners
hand out their own rank scale:

- `audit` uses rank 1 / 2 / 3 as severity (factual error / non-mention /
  generic positioning) — only 1 and 2 currently in use.
- `legacy` uses rank N where N is "ordinal position in the Repositioning
  candidate list, sorted by clicks DESC" — each ticket gets a unique rank,
  and "rank 1" means "the highest-traffic drifted page" only within the
  legacy bucket.
- `sop` uses rank 1..15 from the Semantic HTML scanner's per-page score
  ordering.

If an operator sorts the 158 tickets by priority_rank ASC, the 21 "rank 1"
tickets all surface together with no defined order between them, and a
"rank 2 audit ticket" (LLM didn't mention the firm) is presented as a peer
of a "rank 2 legacy ticket" (some specific page d=0.41) — which is not a
meaningful comparison.

### Q2.2 — Click / GSC / traffic data on the ticket row

```
desc_mentions_clicks     71   ← (45% of tickets)
desc_mentions_gsc        71   ← (same 71 — both came from C1's wording)
remed_mentions_clicks    10   ← only the noindex/redirect/delete remediations
has_evidence_links      127   ← (80% of tickets)
total                   158
```

The 71 tickets that mention clicks are the 60 Repositioning + 10 Suppression
+ 1 gsc_setup config-gate from the C1 PR. They all carry the
"GSC not connected — bucket may shift" provenance line. **None of them carry
an actual click count** — APL has no GSC connection, so there are no
numeric clicks in evidence anywhere. The `desc_mentions_clicks` count is
artifacts of the descriptive wording, not real data.

The 43 audit tickets and 14 freshness tickets and 15 semantic-HTML tickets
contain zero traffic data — none of those scanners ingest GSC.

### Q2.3 — Failure-shape distribution (audit tickets)

```
title_factual_or_incorrect     13
title_didnt_mention            36
title_positioning_off           0
title_reposition               60   ← legacy/repositioning
title_no_index                 10   ← legacy/suppression
title_redirect_or_delete        0   ← no-GSC mode, no clicks-driven buckets emit

source_type:audit              43
source_type:legacy             70
source_type:entity              3
source_type:reddit              0
source_type:sop                42
total                         158
```

Of the 43 audit tickets:

- **13 (30%) are "factual error" / "wrong info" markers** — these are the
  highest-value signal in the queue (an LLM is saying something demonstrably
  wrong about the firm). They are scattered through the audit's rank-1
  bucket but not separated as a distinguished class anywhere in the UI.
- **36 (84%) are non-mention** — different signal (LLM doesn't know the
  firm exists for that query). Some queries may have BOTH a non-mention
  and a factual error across providers; the regex counts overlap.

### Q2.4 — Sub-distinguishers within the 60 Repositioning tickets

```
action         n    d∈[min, max]      avg d    avg word_count
rewrite        60   [0.41, 0.55]      0.48     1464
keep_update    0                                            ← none, GSC not connected
```

Distance histogram (bins width 0.05 across the 0.40-0.55 band):

```
bin 1 (0.40-0.45)   13 tickets
bin 2 (0.45-0.50)   38 tickets
bin 3 (0.50-0.55)    9 tickets
```

Without GSC, we have **two** sub-signals to discriminate the 60 tickets:

1. **Semantic distance** — bin 3 (0.50-0.55) is closer to the "should this
   be noindex'd?" boundary; bin 1 (0.40-0.45) is the smallest drift. The
   scanner already preserves this in `legacy_finding.semantic_distance`.
2. **Word count** — pages are 1464 words on average. Variance not measured
   above but visible in samples (sampled tickets ranged from short blog
   posts to long pillar pages).

Neither of these is currently surfaced in the ticket list. Bin 3 high-drift
pages aren't visually distinguished from bin 1 low-drift pages — they
all look like "Reposition X (drift d=0.4X)" in the list.

### Q2 observations

- **`priority_rank` cannot rank the queue as it stands.** Per-scanner scales
  collide. "Rank 1" is ambiguous.
- **There is no impact data on 87 of the 158 tickets** (the 14 freshness,
  15 semantic-HTML, 3 LLM-friendly, 6 entity, 42 SOP step, 7 misc) — these
  are page-level recommendations with no traffic, no revenue impact, no
  competitor delta. Just "this page scored 53/100 on the Semantic HTML
  rubric."
- **The 13 factual-error audit tickets are the strongest "act now" signal
  in the queue** by Toth-methodology reasoning (LLMs misrepresenting facts
  is the worst outcome). They aren't tagged or separated in any current
  surface.
- **C1's 60 newly-Repositioning-routed tickets are functionally
  indistinguishable from each other** in no-GSC mode — same scanner,
  same rank-by-clicks logic that has no clicks to read, same template
  remediation copy. The only signal between them is the distance band,
  which is shown only in the title.

---

## Q3 — Dashboard surfaces today

Routes inventoried:

- **`/dashboard`** — workspace client list. File: `apps/web/app/dashboard/page.tsx`.
- **`/dashboard/admin`** — operator cockpit. File: `apps/web/app/dashboard/admin/page.tsx`.
- **`/dashboard/[firmSlug]`** — firm overview. File: `apps/web/app/dashboard/[firmSlug]/page.tsx`.
- **`/dashboard/[firmSlug]/tickets`** — unified ticket queue + Action Items sidebar entry. File: `apps/web/app/dashboard/[firmSlug]/tickets/page.tsx`.
- **`/dashboard/[firmSlug]/{phase-key}`** — per-phase page. File: `apps/web/app/dashboard/[firmSlug]/_phase/phase-page-shell.tsx`.

### Q3.1 — Per-phase page (`PhasePageShell`)

`apps/web/app/dashboard/[firmSlug]/_phase/phase-page-shell.tsx:54-126`

- Pulls every remediation_ticket whose `sop_run_id` is in the firm's
  sop_runs for that phase (`getPhaseExecutionTasks` in
  `apps/web/app/actions/sop-actions.ts:867-985`).
- **Filtered by:** firm + phase (joined through `sop_run.phase`).
- **Sorted by:**
  1. `priority_rank` ASC (NULLs last → rank 1,000,000)
  2. then tier order: auto=0, assist=1, manual=2
  3. then `created_at` DESC
- **Limit:** none (full firm's phase tickets returned).
- **Grouped by:** automation_tier into four sections — auto / assist / manual / untagged.

For APL Phase 3: 77 tickets returned, no cap, all assist tier ⇒ collapses
into one section of 77 items. The grouping doesn't reduce list length
when all tickets are the same tier.

### Q3.2 — `/tickets` page

`apps/web/app/dashboard/[firmSlug]/tickets/page.tsx`:

- Pulls remediation_tickets via `listRemediationTickets`
  (`apps/web/app/actions/remediation-actions.ts:225-304`).
- **Filtered by:** querystring `?status=` + `?source=`.
- **Sorted by:** `created_at` DESC. (No priority_rank sorting, no tier sorting.)
- **Limit:** 300.
- **Grouped by:** nothing — flat list with filter pills above.

For APL: all 158 tickets visible, capped at 300, sorted purely by recency.

### Q3.3 — Action Items in the sidebar

`apps/web/app/dashboard/[firmSlug]/firm-sidebar-nav.tsx:28-32`:

```
{
  label: 'Action Items',
  href: (slug) => `/dashboard/${slug}/tickets`,
  icon: Inbox,
  match: 'prefix',
  badge: { kind: 'openTicketCount' },
},
```

**"Action Items" is just a link to `/tickets`** with a count badge of
`openTicketCount` (all status='open' for the firm). No curation, no
sub-selection, no "today's recommended". The badge currently displays
"158" for APL.

The seven phase tabs each carry their own `phaseTicketCount` badge —
counts of open tickets whose `sop_run.phase` matches.

### Q3.4 — Cross-firm aggregation

`apps/web/app/dashboard/page.tsx:202-219` (`computeAggregate`):

The workspace `/dashboard` page sums per-firm stats into five **scalars**:

- `openTickets`
- `openMentions`
- `overBudgetCount`
- `auditErrors30d`
- `missingBt`

Each renders as a single chip at the top of the client list. **There is
no cross-firm ticket list** — no surface that says "across all 130 firms,
here are the top 20 things to do." Only the per-firm card with a "158
open tickets" badge that links into `/dashboard/{slug}/tickets`.

### Q3.5 — "This week" / "today" surface

Grep `this[- ]?week|today|due.?today|recommended` across the dashboard
directory: only one hit, in `_phase/scan-controls-client.tsx:158`,
formatting a weekly-report header label ("Weekly report start → end").

**No surface curates the queue.** No "your 5 tickets for today." No
"three highest-impact this week." No filter by `due_at`. The dashboard
treats the queue as a flat list of 158 items the operator scrolls.

### Q3 observations

- **The only operator surfaces for ticket triage are full-firm lists** —
  /tickets (158 items, recency-sorted) and per-phase pages (43-77 items
  per phase, priority-sorted within phase only).
- **The cross-firm view is a single number** (`openTickets`). At 130 firms
  with ~160 tickets each ≈ ~20,000 tickets workspace-wide, the chip just
  reads "20,000" with no drill-in surface.
- **"Action Items" in the sidebar is a misnomer** — it's the queue, not
  curated actions. The operator who clicks it from Monday-9am looking for
  "what should I do today" gets a 158-line list of items in arbitrary
  recency order.
- **Per-phase priority sort is plausibly useful only within a phase.**
  The cross-source `priority_rank` collision (Q2.1) means even per-phase
  ranks are noisy.

---

## Q4 — Operator / firm / auto split (APL)

### Q4.1 — APL automation_tier breakdown

```
tier        n
assist     154
manual       4
```

No auto. 97% / 3% / 0%.

### Q4.2 — 10 randomly-sampled assist/manual tickets, classified by executor

| # | Title (truncated) | Tier | Phase / SOP | Rank | Who actually executes |
|---|---|---|---|---|---|
| 1 | Create Wikidata entry for the firm | assist | 4 / entity_optimization | ∅ | **Firm** (needs Wikipedia account + firm's authoritative sources). Validation: "Sign in to wikidata.org" — operator cannot do this for the client. |
| 2 | Reposition Documents You Will Need for a Personal Injury Claim (drift d=0.45) | assist | 3 / content_repositioning | 45 | **Firm** (copy rewrite is in the firm's CMS, with the firm's voice). Operator can draft, firm publishes. |
| 3 | Reposition Personal Injury Attorney Blog (drift d=0.41) | assist | 3 / content_repositioning | 1 | **Firm** (same). |
| 4 | No-index: Can You Ride in the Bed of a Truck in Florida? | assist | 1 / legacy_content_suppression | ∅ | **Firm** (CMS edit — Yoast / RankMath / direct HTML). |
| 5 | Semantic HTML: Medium priority (53/100) — https://…/how-long-do-i… | assist | 5 / semantic_html_optimization | 4 | **Firm** (template / theme edit; usually a dev task on the client side). |
| 6 | Reposition Who Insures Golf Carts in Florida? (drift d=0.54) | assist | 3 / content_repositioning | 17 | **Firm** (content rewrite). |
| 7 | Reposition What Is the Florida Good Samaritan Act? (drift d=0.52) | assist | 3 / content_repositioning | 20 | **Firm** (content rewrite). |
| 8 | LLM didn't mention firm: "car accident attorney Brevard County" (openai) | assist | 1 / brand_visibility_audit | 2 | **Operator + Firm** (operator edits Brand Truth → firm propagates to pages). |
| 9 | No-index: Defining Institutional Sexual Assault & Abuse | assist | 1 / legacy_content_suppression | ∅ | **Firm** (CMS edit). |
| 10 | Reposition Can You Sue for Emotional Distress in Florida? (drift d=0.48) | assist | 3 / content_repositioning | 40 | **Firm** (content rewrite). |

**Classification summary of the 10:**

- **Firm-executed:** 8 (Wikidata create, 5 content rewrites, 2 CMS noindex applications, 1 template/dev semantic-HTML fix)
- **Operator + Firm collaboration:** 1 (audit non-mention — operator owns Brand Truth, firm owns site propagation)
- **Operator-only:** 0

The validation_steps on every "Reposition X" ticket are: "Diff current page
copy against Brand Truth | Rewrite intro + H1 + meta to match Brand Truth |
Restructure body with scannable headings + definitions". All four of those
are firm-side actions (the firm owns the CMS).

### Q4.3 — Surface for distinguishing operator-tasks from firm-tasks

Grep across the dashboard for any UI that separates operator-tasks from
firm-tasks: **none exists.** Every ticket renders the same way (title +
tier badge + execute_url + remediation_copy block). The phase page groups
by `automation_tier`, but every assist ticket lands in one bucket
regardless of who actually does the assist work.

The ExportToolbar exists on `/tickets` and `/client-services` (file:
`apps/web/app/dashboard/[firmSlug]/_exports/export-toolbar.tsx`) with two
buttons:

- **Download tickets (.xlsx)** → `exportTicketsXlsx` server action
- **Build audit delivery deck** → `exportAuditDelivery`

This IS the handoff mechanism today — operator clicks Download, sends
the xlsx to the client by some out-of-tool channel (Slack, email).

### Q4.4 — Export module invocation telemetry

```
sop_deliverable rows by kind:
  priority_actions_list    n=2   latest=2026-05-12 13:44:48
  weekly_report_md         n=1   latest=2026-05-12 13:59:07
```

Both rows are from today (the day this research was conducted) — likely
generated during recent scanner verifications, not by the operator
exporting on behalf of the client.

**No audit / event / activity / log table** exists in the schema (checked
`information_schema.tables`). There is no record of how often the
ExportToolbar buttons have been clicked. We have no telemetry on the
operator's actual export cadence.

**No closed-ticket clustering** to infer post-export action — zero APL
tickets have been closed in the last 90 days (Q1.4).

### Q4 observations

- **Effectively 0 of APL's 158 tickets are operator-executable.** Every
  ticket is something the firm has to do (CMS edits, content rewrites,
  Wikidata entries, semantic-HTML refactors, GSC OAuth). The operator's
  job is to surface the work, draft the content, hand it off, and verify
  follow-through.
- **The dashboard does not represent that handoff.** Tickets render the
  same way regardless of who owns the action. There is no "operator
  draft" → "ready for client" → "client applied" state pipeline.
- **Export module is the de-facto handoff channel,** but we have no
  telemetry on its use, and the artifact is a flat xlsx — not an
  ordered, prioritized, client-readable plan.
- The 4 manual-tier tickets are the only tier-distinguished class. They
  carry a `manual_reason` and are presumably operator-personally-owned
  (SME interviews, GSC OAuth, Wikipedia COI prohibitions, etc.).

---

## Synthesis

**The bottleneck is not scanner correctness. It is twofold:
(a) the queue has no operator-readable priority across the cross-scanner
collision, and (b) the dashboard has no surface for the operator-to-firm
handoff that 154/158 of these tickets actually require.**

### Where each Q lands

- **Q1 (volume):** 158 tickets per firm per scanner pass. At 130 firms
  this is ~20k workspace-wide. The single cross-firm aggregation point
  is one scalar. Volume is real but secondary to the surfacing problem —
  even at 158 for one firm, the operator has no path through the list.
- **Q2 (signal):** `priority_rank` is broken as a cross-source signal —
  three scanners hand out ranks on incompatible scales and 21 tickets
  collide at "rank 1". The strongest available signal (13 factual-error
  audit tickets that LLMs are demonstrably wrong about the firm) is not
  separated as a class anywhere. The 60 Repositioning tickets are
  functionally indistinguishable from each other in no-GSC mode.
- **Q3 (surfacing):** Three places to find tickets — /tickets (flat by
  recency, 300 cap), per-phase pages (43-77 each, sorted by colliding
  priority_rank), sidebar "Action Items" (= /tickets). No curated
  "today's actions". No cross-firm operator list. The phase pages are
  the only place tier groups exist, and at 97% assist they collapse.
- **Q4 (operator/firm split):** Essentially every ticket is firm-executed.
  The operator's actual job is drafting + handoff + verification — none
  of which the tool represents. The export module is the handoff but
  there's no signal on whether it's used, and the artifact is a flat xlsx.

### Specific things the data shows that the brief didn't ask about (flagging per the instructions)

1. **Zero state transitions ever.** No ticket has ever moved from `open` to
   any other status. Either (a) the demo data is fresh and untouched, or
   (b) operators have no muscle memory / surface for closing tickets
   from the dashboard. Either way the queue accumulation model
   `>7d / >30d / >90d` returns all zeros today, but that flips the
   moment anyone uses the tool — at which point we need close-out UX
   that doesn't exist yet.

2. **Almost-zero export telemetry.** The handoff workflow this whole
   tool's operator value depends on is currently invisible. No metric,
   no event log, no signal of "operator delivered N tickets to client
   on date D". This blocks any future "what's the agency actually
   doing" analytics.

3. **The 4 manual-tier tickets are the only ones the operator personally
   does, by design.** That number being small is correct — but it means
   the operator's true work surface is "everything I had to chase a
   client to apply," which is not the same axis as automation_tier. The
   tier system distinguishes "we know how to do this automatically" from
   "we don't," not "who executes."

4. **Repositioning vs Suppression routing (just shipped in C1) means
   the same firm's tickets now span Phase 1 + Phase 3.** The operator's
   "what's drifted on this site?" mental query no longer maps to a single
   phase tab. Phase 1 has 10 noindex, Phase 3 has 60 rewrite — same
   underlying scanner, two tabs. C1 is methodology-correct but increases
   surface fragmentation for the operator.

5. **`getPhaseExecutionTasks` has no cap.** /tickets caps at 300 but the
   phase pages return everything. For a larger firm that's plausibly a
   payload + rendering issue, separate from the UX question of whether
   any human reads a 200-row page.

### Where the brief framed this and where the data points

The brief frames the question as "the math at 130 firms doesn't work."
The data shows two distinct flavors of "doesn't work":

- **Per-firm:** an operator handed 158 tickets for one firm has no
  surface that compresses them into a Monday-morning plan. The list is
  flat, sorted ambiguously, untagged by who executes, and not handed off.
- **Across-firm:** there is literally no UI surface that aggregates
  ticket-level work across the 130 firms. The workspace page sums to a
  number; that's it.

If forced to pick one of those two as the binding constraint to address
next, it's the **per-firm Monday-morning surface** — because (a) we have
one firm's data to design against, (b) the cross-firm surface needs the
per-firm signal to be meaningful first, and (c) the current per-firm
surface is what blocks the operator from actually working any client at
all, which has to happen before the agency can run 130 of them in parallel.

The "PR scope" question that follows from this isn't "which scanner to
fix next" — it's "what does the operator see when they want to do work
on Andrew Pickett Law for an hour this morning." The data says: today,
nothing useful.
