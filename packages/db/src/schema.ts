import type { BrandTruth } from '@ai-edge/shared';
import {
  pgTable, uuid, text, integer, boolean, timestamp, jsonb, real,
  index, uniqueIndex,
} from 'drizzle-orm/pg-core';

// ── Firms & tenancy ─────────────────────────────────────────
export const firms = pgTable('firm', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  // One of: 'law_firm' | 'dental_practice' | 'marketing_agency' | 'other'
  // Drives Brand Truth editor rendering + default compliance_jurisdictions.
  firm_type: text('firm_type').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const brandTruthVersions = pgTable('brand_truth_version', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  payload: jsonb('payload').$type<BrandTruth>().notNull(),
  created_by: text('created_by').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  firmVersionIdx: uniqueIndex('brand_truth_firm_version').on(t.firm_id, t.version),
}));

export const competitors = pgTable('competitor', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  website: text('website'),
  notes: text('notes'),
});

// ── Audit runs ──────────────────────────────────────────────
export const auditRuns = pgTable('audit_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  brand_truth_version_id: uuid('brand_truth_version_id').references(() => brandTruthVersions.id),
  kind: text('kind').notNull(), // 'full' | 'daily-priority' | 'competitive' | 'reddit'
  status: text('status').notNull().default('pending'),
  started_at: timestamp('started_at', { withTimezone: true }),
  finished_at: timestamp('finished_at', { withTimezone: true }),
  cost_usd: real('cost_usd').default(0),
  error: text('error'),
});

export const queries = pgTable('query', {
  id: uuid('id').primaryKey().defaultRandom(),
  audit_run_id: uuid('audit_run_id').notNull().references(() => auditRuns.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  practice_area: text('practice_area'),
  intent: text('intent'),
  priority: text('priority').default('standard'), // 'standard' | 'top20'
});

export const modelResponses = pgTable('model_response', {
  id: uuid('id').primaryKey().defaultRandom(),
  query_id: uuid('query_id').notNull().references(() => queries.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  attempt: integer('attempt').notNull(),
  raw_response: jsonb('raw_response').notNull(),
  latency_ms: integer('latency_ms'),
  cost_usd: real('cost_usd'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const consensusResponses = pgTable('consensus_response', {
  id: uuid('id').primaryKey().defaultRandom(),
  query_id: uuid('query_id').notNull().references(() => queries.id, { onDelete: 'cascade' }),
  self_consistency_k: integer('self_consistency_k').notNull(),
  majority_answer: text('majority_answer'),
  variance: real('variance'),
  mentioned: boolean('mentioned').notNull(),
});

export const alignmentScores = pgTable('alignment_score', {
  id: uuid('id').primaryKey().defaultRandom(),
  consensus_response_id: uuid('consensus_response_id').notNull()
    .references(() => consensusResponses.id, { onDelete: 'cascade' }),
  mentioned: boolean('mentioned').notNull(),
  tone_1_10: real('tone_1_10'),
  rag_label: text('rag_label').notNull(), // 'red' | 'yellow' | 'green'
  gap_reasons: jsonb('gap_reasons').$type<string[]>().default([]),
  factual_errors: jsonb('factual_errors').$type<string[]>().default([]),
  remediation_priority: integer('remediation_priority').default(3),
});

export const citations = pgTable('citation', {
  id: uuid('id').primaryKey().defaultRandom(),
  consensus_response_id: uuid('consensus_response_id').notNull()
    .references(() => consensusResponses.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  domain: text('domain').notNull(),
  rank: integer('rank'),
  type: text('type'),
}, (t) => ({
  domainIdx: index('citation_domain_idx').on(t.domain),
}));

// ── Legacy content suppression ──────────────────────────────
export const pages = pgTable('page', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  title: text('title'),
  content_hash: text('content_hash'),
  // Extracted main content (readability-style). Stored inline so we can
  // re-score without re-crawling; truncated at ~20k chars before insert
  // to keep rows bounded.
  main_content: text('main_content'),
  // Word count on the extracted content — used to decide whether a page
  // has enough signal to be worth scoring.
  word_count: integer('word_count'),
  // Embedding vector as jsonb array — keeps infra simple (no pgvector,
  // no separate Pinecone round-trip for V1). text-embedding-3-large
  // output is 3072 floats ≈ 25KB per row, acceptable for sub-1000-page
  // firms. Swap to Pinecone when a firm grows past that bound.
  embedding: jsonb('embedding').$type<number[]>(),
  embedding_model: text('embedding_model'),
  embedding_id: text('embedding_id'), // Pinecone vector id (future)
  fetched_at: timestamp('fetched_at', { withTimezone: true }),
}, (t) => ({
  firmUrlIdx: uniqueIndex('page_firm_url').on(t.firm_id, t.url),
}));

export const legacyFindings = pgTable('legacy_finding', {
  id: uuid('id').primaryKey().defaultRandom(),
  page_id: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  semantic_distance: real('semantic_distance').notNull(),
  action: text('action').notNull(), // 'rewrite' | 'redirect' | 'noindex'
  rationale: text('rationale'),
  detected_at: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Remediation queue ───────────────────────────────────────
export const remediationTickets = pgTable('remediation_ticket', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  // 'audit' | 'legacy' | 'entity' | 'reddit' — matches what each scanner
  // actually writes. `run-audit.ts` uses 'audit' (source_id = alignment_score
  // id) for Red consensus rows; the earlier spec said 'alignment' but that
  // label was never emitted. The tickets UI resolves context off this tag.
  source_type: text('source_type').notNull(),
  source_id: uuid('source_id').notNull(),
  status: text('status').notNull().default('open'),
  owner: text('owner'),
  playbook_step: text('playbook_step'),
  due_at: timestamp('due_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Reddit ──────────────────────────────────────────────────
// `triage_status` turns the raw mention feed into an operator queue:
//   - `open`          = untouched, still needs a look
//   - `acknowledged`  = operator saw it, watching but no action
//   - `dismissed`     = false positive / off-brand / wrong firm / resolved
//   - `escalated`     = a real problem; also opens/keeps a remediation ticket
//
// Default `open` means a fresh scan drops new mentions straight into the
// operator queue. The admin dashboard's "open complaints" count is driven
// by `sentiment='complaint' AND triage_status='open'`, so triaging a row
// removes it from the "needs attention" signal without mutating the
// sentiment field (which is model output, not operator intent).
export const redditMentions = pgTable('reddit_mention', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  subreddit: text('subreddit').notNull(),
  post_id: text('post_id').notNull(),
  comment_id: text('comment_id'),
  author: text('author'),
  karma: integer('karma'),
  sentiment: text('sentiment'),
  text: text('text'),
  url: text('url').notNull(),
  posted_at: timestamp('posted_at', { withTimezone: true }),
  ingested_at: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
  triage_status: text('triage_status').notNull().default('open'),
  triage_note: text('triage_note'),
  triaged_at: timestamp('triaged_at', { withTimezone: true }),
}, (t) => ({
  firmPostIdx: uniqueIndex('reddit_firm_post')
    .on(t.firm_id, t.post_id, t.comment_id),
  firmTriageIdx: index('reddit_firm_triage_idx')
    .on(t.firm_id, t.triage_status),
}));

// ── Competitive ─────────────────────────────────────────────
export const competitorMentions = pgTable('competitor_mention', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  competitor_id: uuid('competitor_id').notNull()
    .references(() => competitors.id, { onDelete: 'cascade' }),
  query_id: uuid('query_id').notNull().references(() => queries.id, { onDelete: 'cascade' }),
  share: real('share'),
  praise_flag: boolean('praise_flag').default(false),
  detected_at: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Entity signals ──────────────────────────────────────────
export const entitySignals = pgTable('entity_signal', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  source: text('source').notNull(), // 'bbb' | 'superlawyers' | 'avvo' | 'gbp' | 'website'
  url: text('url'),
  nap_hash: text('nap_hash'),
  description_hash: text('description_hash'),
  verified_at: timestamp('verified_at', { withTimezone: true }),
  divergence_flags: jsonb('divergence_flags').$type<string[]>().default([]),
});

// ── Cost control ────────────────────────────────────────────
// Per-firm monthly LLM budget ceiling. Set by an operator on the firm
// settings page; checked before every audit run (and again mid-run once
// costs cross the cap). If a firm doesn't have a row here, the default
// cap from env (`DEFAULT_FIRM_MONTHLY_CAP_USD`) applies — keeping "no
// configuration" as a safe default rather than "unlimited spend."
export const firmBudgets = pgTable('firm_budget', {
  firm_id: uuid('firm_id').primaryKey()
    .references(() => firms.id, { onDelete: 'cascade' }),
  monthly_cap_usd: real('monthly_cap_usd').notNull(),
  // Optional operator note — who set the cap and why.
  note: text('note'),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Cron observability ──────────────────────────────────────
// One row per cron execution. Populated by the `recordCronRun` wrapper
// around every route in `/api/cron/*`. Lets the admin page show cron
// health (last N executions per cron, duration, success counts, error
// strings) without having to dig through platform logs.
//
// `summary` is freeform JSON — each cron shapes it differently (weekly
// audit reports `{ ran, ok, skipped, errored }`; reddit-poll reports
// `{ firmsScanned, mentionsFound }`). The admin page renders it as
// pretty JSON when the user expands a row.
//
// Housekeeping: rows are retained forever for now. If the table grows
// unwieldy we'll TRUNCATE WHERE started_at < now() - interval '180d'
// from a separate cleanup cron; 5 crons × 1/day × 180d ≈ 900 rows, well
// under anything worth paging.
export const cronRuns = pgTable('cron_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  cron_name: text('cron_name').notNull(), // 'audit-weekly' | 'audit-daily' | 'reddit-poll' | 'citation-diff' | 'report-monthly'
  started_at: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  finished_at: timestamp('finished_at', { withTimezone: true }),
  // 'running' → 'ok' | 'error'. Runs that never finish (process kill) stay 'running' forever;
  // the admin UI surfaces them as "stalled" based on started_at age.
  status: text('status').notNull().default('running'),
  duration_ms: integer('duration_ms'),
  summary: jsonb('summary'),
  error: text('error'),
}, (t) => ({
  nameStartedIdx: index('cron_run_name_started_idx').on(t.cron_name, t.started_at),
}));

// 24h response cache keyed by (provider, model, system_prompt, user_prompt).
// Cache keys are sha256 hex digests so the lookup column is a fixed-length
// text. We keep the response text inline for zero-copy reuse; the raw
// payload is retained for audit trail but is not required on the hit path.
// Expired rows are left in place — the query filters on `expires_at` and a
// nightly cleanup can TRUNCATE WHERE expires_at < now() - interval '7d'.
export const queryResponseCache = pgTable('query_response_cache', {
  cache_key: text('cache_key').primaryKey(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  response_text: text('response_text').notNull(),
  raw_response: jsonb('raw_response'),
  latency_ms: integer('latency_ms'),
  cost_usd: real('cost_usd'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  expiresIdx: index('query_cache_expires_idx').on(t.expires_at),
}));

// ── Scenario Lab (post-v1 R&D; schema reserved) ─────────────
export const scenarioRuns = pgTable('scenario_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  baseline_serp_snapshot_id: uuid('baseline_serp_snapshot_id'),
  proposed_change: jsonb('proposed_change').notNull(),
  predicted_rank_delta: real('predicted_rank_delta'),
  confidence: real('confidence'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Citation drift (§5.2) ───────────────────────────────────
// One row per pair of consecutive audit runs for a firm — records which
// cited domains were newly gained (in latest, not in previous) and which
// were lost (in previous, not in latest). Populated by the nightly
// citation-diff cron; read by the visibility dashboard.
//
// `latest_run_id` is unique per firm because every nightly run re-diffs
// against whatever "the most recent completed run" is — the cron is
// idempotent by that pair, so we upsert if it already exists.
export const citationDiffs = pgTable('citation_diff', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  latest_run_id: uuid('latest_run_id').notNull()
    .references(() => auditRuns.id, { onDelete: 'cascade' }),
  previous_run_id: uuid('previous_run_id').notNull()
    .references(() => auditRuns.id, { onDelete: 'cascade' }),
  // Arrays of lowercased domains. Bounded — top-N only would be fine but
  // citation corpora are small (dozens of domains per run) so we store
  // them whole for UI display.
  gained: jsonb('gained').$type<string[]>().notNull().default([]),
  lost: jsonb('lost').$type<string[]>().notNull().default([]),
  gained_count: integer('gained_count').notNull().default(0),
  lost_count: integer('lost_count').notNull().default(0),
  detected_at: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  firmLatestIdx: uniqueIndex('citation_diff_firm_latest').on(t.firm_id, t.latest_run_id),
  firmDetectedIdx: index('citation_diff_firm_detected').on(t.firm_id, t.detected_at),
}));

// ── Monthly reports ─────────────────────────────────────────
// One row per firm per calendar month. The JSON payload is generated
// from audit-runs, reddit mentions, competitor mentions, suppression
// findings, and entity signals. The payload is also mirrored as a JSON
// file in Vercel Blob so reviewers can download the raw artifact.
//
// Uniqueness: (firm_id, month_key) — `month_key` is a YYYY-MM string
// keyed off UTC. A re-run in the same month overwrites the existing row
// (upsert by unique index) so the dashboard always shows the freshest
// snapshot.
export const monthlyReports = pgTable('monthly_report', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  month_key: text('month_key').notNull(), // 'YYYY-MM' UTC
  payload: jsonb('payload').notNull(),
  blob_url: text('blob_url'), // Vercel Blob download URL (public)
  generated_at: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  firmMonthIdx: uniqueIndex('monthly_report_firm_month').on(t.firm_id, t.month_key),
}));

// ── Legacy rewrite drafts ──────────────────────────────────
// PLAN §5.3: for borderline-drift pages (semantic_distance ∈ (0.30, 0.45]),
// generate an AI-assisted rewrite that:
//   • preserves named entities (people, places, awards)
//   • matches Brand Truth tone_guidelines
//   • weaves in required_positioning_phrases where natural
//   • never uses banned_claims
//
// Shape:
//   One draft per finding — regeneration replaces the current draft in place
//   via the unique index on legacy_finding_id. Historic drafts are not
//   retained; if that becomes a review requirement we'll flip the schema to
//   append-only with a latest-flag.
//
// brand_truth_version_id ties the draft to the exact Brand Truth in force at
// generation time. If the operator later edits Brand Truth and re-reviews a
// draft, the UI can surface "this draft was aligned to v3; you're now on v5".
export const legacyRewriteDrafts = pgTable('legacy_rewrite_draft', {
  id: uuid('id').primaryKey().defaultRandom(),
  legacy_finding_id: uuid('legacy_finding_id').notNull()
    .references(() => legacyFindings.id, { onDelete: 'cascade' }),
  brand_truth_version_id: uuid('brand_truth_version_id')
    .references(() => brandTruthVersions.id, { onDelete: 'set null' }),
  // Snapshot of the current on-page content at generation time — lets the UI
  // render a stable diff even if the crawler re-fetches the page and mutates
  // `pages.main_content`.
  current_title: text('current_title'),
  current_excerpt: text('current_excerpt'),
  // Generated copy.
  proposed_title: text('proposed_title').notNull(),
  proposed_body: text('proposed_body').notNull(),
  // Plain-English summary of what changed and why.
  change_summary: text('change_summary'),
  // Review aids — arrays of strings the model reports back in its JSON
  // response. `entities_preserved` is the canary for fabrication regressions.
  entities_preserved: jsonb('entities_preserved').$type<string[]>().notNull().default([]),
  positioning_fixes: jsonb('positioning_fixes').$type<string[]>().notNull().default([]),
  banned_claims_avoided: jsonb('banned_claims_avoided').$type<string[]>().notNull().default([]),
  // Generation provenance.
  generated_by_model: text('generated_by_model').notNull(),
  cost_usd: real('cost_usd'),
  // Workflow: 'draft' → 'accepted' (operator endorses) | 'rejected' (regenerate)
  status: text('status').notNull().default('draft'),
  generated_at: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
  reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
}, (t) => ({
  findingIdx: uniqueIndex('legacy_rewrite_draft_finding').on(t.legacy_finding_id),
}));
