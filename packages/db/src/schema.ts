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
  // Provenance metadata when this version was produced by the auto-bootstrap
  // (lib/brand-truth/bootstrap.ts). Null for manually authored versions —
  // including every operator-saved version after the bootstrap one, because
  // they reflect the operator's deliberate edits rather than an automated
  // synthesis pass.
  bootstrap_meta: jsonb('bootstrap_meta').$type<{
    pagesScanned: number;
    pagesUsed: string[];
    jsonLdTypesDetected: string[];
    modelUsed: string;
    costUsd: number;
    latencyMs: number;
  }>(),
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

// ── Scenario Lab (PreFlight Ranker) ─────────────────────────
// Per ADR-0006: a calibrated proxy ranker that lets operators rank-order
// proposed content changes BEFORE they ship. NOT a Google replica — a
// linear scoring function calibrated against observed SERPs via PSO.
// Honest claim: directional, not absolute rank prediction.
//
// Tables (all firm-scoped, cascade-on-delete):
//   serp_snapshot   — one observed SERP for a (firm, query) pair, any source
//   serp_result     — ranked rows inside a snapshot
//   page_features   — extracted feature vectors keyed by (firm, url)
//   ranker_weights  — calibrated weights per generation, with fitness
//   scenario        — operator-defined what-if (baseline → proposed change)

export const serpSnapshots = pgTable('serp_snapshot', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  query: text('query').notNull(),
  // 'manual' (paste-in) | 'bing-web-search' | 'serpapi' | 'dataforseo'
  // v1 ships only 'manual'; the others are the Phase B integrations.
  provider: text('provider').notNull().default('manual'),
  // Locale + geo so we can scope calibration corpus when a firm targets
  // multiple regions. ISO 3166-1 alpha-2 + IETF lang tag.
  country: text('country'),
  language: text('language'),
  fetched_at: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
  // Raw provider response for replay/debug. Manual paste-ins store the
  // original text in `notes` and leave this null.
  raw: jsonb('raw'),
  notes: text('notes'),
}, (t) => ({
  firmQueryIdx: index('serp_snapshot_firm_query_idx').on(t.firm_id, t.query),
}));

export const serpResults = pgTable('serp_result', {
  id: uuid('id').primaryKey().defaultRandom(),
  snapshot_id: uuid('snapshot_id').notNull()
    .references(() => serpSnapshots.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  url: text('url').notNull(),
  domain: text('domain').notNull(),
  title: text('title'),
  snippet: text('snippet'),
  // True when the result domain matches the firm's primary_url host.
  // Lets the calibration step weight the firm's own URLs higher and the
  // simulation step locate the baseline rank without re-running comparisons.
  is_target: boolean('is_target').notNull().default(false),
}, (t) => ({
  snapshotIdx: index('serp_result_snapshot_idx').on(t.snapshot_id),
}));

export const pageFeatures = pgTable('page_features', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  // Optional FK — features for hypothetical/external URLs (competitor pages
  // we want to compare against) won't have a `page` row.
  page_id: uuid('page_id').references(() => pages.id, { onDelete: 'set null' }),
  url: text('url').notNull(),
  // jsonb so the feature schema can grow without a migration each time.
  // The canonical list lives in lib/scenarios/ranker-feature-list.ts.
  features: jsonb('features').$type<Record<string, number>>().notNull(),
  extracted_at: timestamp('extracted_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  firmUrlIdx: uniqueIndex('page_features_firm_url').on(t.firm_id, t.url),
}));

export const rankerWeights = pgTable('ranker_weights', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  // Monotonically increasing per firm. Calibration writes generation+1 each
  // time, never overwrites. Old weights remain queryable for "did this
  // scenario use the latest model?" UX.
  generation: integer('generation').notNull(),
  weights: jsonb('weights').$type<Record<string, number>>().notNull(),
  // Mean Spearman ρ across calibration SERPs at the end of training.
  // Range [-1, 1]; negative means "worse than random" — we surface a
  // warning in the UI when fitness < 0.1.
  fitness: real('fitness').notNull(),
  observation_count: integer('observation_count').notNull(),
  // PSO hyperparameters used, for repro + debugging.
  pso_params: jsonb('pso_params'),
  trained_at: timestamp('trained_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  firmGenIdx: uniqueIndex('ranker_weights_firm_gen').on(t.firm_id, t.generation),
}));

export const scenarios = pgTable('scenario', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // The page being optimized (free-form URL — usually a `pages.url`).
  baseline_url: text('baseline_url').notNull(),
  // The query the scenario is targeting. Should match a serp_snapshot.query
  // for there to be a competitor set; otherwise simulation reports
  // Δscore-only with no Δrank.
  query: text('query').notNull(),
  description: text('description'),
  // Proposed delta on the feature vector. Values are JSON-encoded ops:
  //   numeric: { "word_count": "+200" }    → add 200
  //            { "word_count": "*1.5" }    → multiply by 1.5
  //            { "word_count": "= 1500" }  → set absolute
  //   boolean: { "has_jsonld_legalservice": true }
  // The simulator parses these and applies to the baseline FeatureVec.
  proposed_change: jsonb('proposed_change').$type<Record<string, string | number | boolean>>().notNull(),
  // Computed at scenario creation time and frozen in this row — re-run
  // updates the row in place. Surfaces in the list view without recompute.
  baseline_score: real('baseline_score'),
  proposed_score: real('proposed_score'),
  delta_score: real('delta_score'),
  baseline_rank: integer('baseline_rank'),
  proposed_rank: integer('proposed_rank'),
  delta_rank: integer('delta_rank'),
  competitor_count: integer('competitor_count'),
  weights_generation_used: integer('weights_generation_used'),
  // 'directional' | 'low_confidence' | 'no_calibration'. The UI maps this
  // to a coloured badge so operators don't over-interpret a Δrank=+1 result
  // when the calibration corpus is too thin to support it.
  confidence_label: text('confidence_label'),
  created_by: text('created_by'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  recomputed_at: timestamp('recomputed_at', { withTimezone: true }),
}, (t) => ({
  firmIdx: index('scenario_firm_idx').on(t.firm_id),
}));

// ── Search Console connection (Phase B #6) ──────────────────
// One row per firm linking it to a Google Search Console property.
// access_token + refresh_token are AES-256-GCM-encrypted with the
// OAUTH_TOKEN_ENCRYPTION_KEY env var; the columns store hex-encoded
// `iv:auth_tag:ciphertext` triples so a leaked DB dump alone doesn't
// give an attacker working tokens. The SearchAnalytics queries refresh
// the access token automatically when expires_at passes.
export const gscConnections = pgTable('gsc_connection', {
  firm_id: uuid('firm_id').primaryKey()
    .references(() => firms.id, { onDelete: 'cascade' }),
  // GSC property URL ('https://www.example.com/' or 'sc-domain:example.com').
  // The exact form must match what the operator selected in Search Console.
  site_url: text('site_url').notNull(),
  // Encrypted (AES-256-GCM, hex 'iv:tag:ciphertext'). Plain TEXT column —
  // database-level encryption only adds defense-in-depth here.
  access_token_enc: text('access_token_enc').notNull(),
  refresh_token_enc: text('refresh_token_enc').notNull(),
  // Granted scope (recorded so we can detect a re-auth requirement when
  // we add new query types in the future).
  scope: text('scope').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  connected_by: text('connected_by'),
  connected_at: timestamp('connected_at', { withTimezone: true }).defaultNow().notNull(),
  // Last-sync metadata so the UI can show 'updated 3h ago / never synced'.
  last_synced_at: timestamp('last_synced_at', { withTimezone: true }),
  last_sync_error: text('last_sync_error'),
});

// Daily Search Console rollups per firm. One row per (firm, date),
// populated by the nightly /api/cron/gsc-sync route. The visibility
// dashboard reads these alongside audit citation rates so an operator
// can see organic-clicks trend vs LLM-citation trend on the same chart.
export const gscDailyMetrics = pgTable('gsc_daily_metric', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  // YYYY-MM-DD — stored as TEXT not DATE because Postgres DATE adds
  // timezone surprises and we always treat GSC dates as UTC anyway.
  date: text('date').notNull(),
  clicks: integer('clicks').notNull(),
  impressions: integer('impressions').notNull(),
  ctr: real('ctr'),
  position: real('position'),
  fetched_at: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  firmDateIdx: uniqueIndex('gsc_daily_firm_date').on(t.firm_id, t.date),
}));

// ── AI Overview capture (Phase B #7) ────────────────────────
// One row per observed Google AI Overview panel for a (firm, query)
// pair at a point in time. The capture records both the AIO prose
// (what Google's AI summary actually said) and the sources Google
// listed below it. Visibility-tab consumers diff captures over time
// to surface "the AI Overview started/stopped citing us" alerts.
//
// Sources are stored as a JSON array of { url, title, domain } so
// the visibility-tab citation drift can compare them against the
// audit-driven citation set already tracked in `citation`.
//
// Provider discriminator:
//   'dataforseo' — DataForSEO Google AI Mode endpoint (primary;
//                  paid; ADR-0009 picked them as the licensed SERP
//                  capture vendor)
//   'serpapi'    — SerpAPI Google AI Overview (alt provider)
//   'playwright' — fallback for AIO pages no provider covers
//                  (requires Bright Data residential proxies per
//                  ADR-0010)
export const aioCaptures = pgTable('aio_capture', {
  id: uuid('id').primaryKey().defaultRandom(),
  firm_id: uuid('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  query: text('query').notNull(),
  provider: text('provider').notNull(),
  // Locale + geo for the capture — AIO content varies materially
  // across markets even for the same English query.
  country: text('country'),
  language: text('language'),
  fetched_at: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
  // True if Google rendered an AI Overview at all for this query.
  // False = "we asked, Google chose not to show one" (a useful
  // signal in itself: AIO triggers shrank for navigational vs.
  // research queries).
  has_aio: boolean('has_aio').notNull().default(false),
  // The visible AI Overview prose. NULL when has_aio = false.
  overview_text: text('overview_text'),
  // Sources Google cited as references for the overview. Each entry
  // is at minimum {url, title, domain}; provider may include extra
  // metadata that we preserve as-is.
  sources: jsonb('sources').$type<Array<{ url: string; title?: string; domain?: string }>>()
    .default([]),
  // Did the firm appear in the cited sources? We compute this once
  // at capture time so the visibility tab doesn't have to re-derive
  // from `sources` each render.
  firm_cited: boolean('firm_cited').notNull().default(false),
  // Full provider response for debugging + future re-analysis.
  raw: jsonb('raw'),
}, (t) => ({
  firmQueryIdx: index('aio_capture_firm_query').on(t.firm_id, t.query),
  firmFetchedIdx: index('aio_capture_firm_fetched').on(t.firm_id, t.fetched_at),
}));
