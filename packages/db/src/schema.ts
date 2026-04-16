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
  embedding_id: text('embedding_id'), // Pinecone vector id
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
  source_type: text('source_type').notNull(), // 'alignment' | 'legacy' | 'entity' | 'reddit'
  source_id: uuid('source_id').notNull(),
  status: text('status').notNull().default('open'),
  owner: text('owner'),
  playbook_step: text('playbook_step'),
  due_at: timestamp('due_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Reddit ──────────────────────────────────────────────────
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
}, (t) => ({
  firmPostIdx: uniqueIndex('reddit_firm_post')
    .on(t.firm_id, t.post_id, t.comment_id),
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
