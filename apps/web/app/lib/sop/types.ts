/**
 * SOP Engine — type definitions.
 *
 * The registry (registry.ts) builds 24 SopDefinition values that drive the
 * entire engine. These types are the contract between the registry, the
 * server actions, and the workflow UI.
 *
 * Source: docs/design-sop-engine.md
 */

// ───────────────────────────────────────────────────────────────
// SOP keys — stable identifiers for every SOP in the catalog.
// Adding a SOP means adding a key here AND registering its
// definition in registry.ts. Renaming a key is a migration.
// ───────────────────────────────────────────────────────────────
export type SopKey =
  // Phase 1: Brand Audit & Analysis
  | 'brand_visibility_audit'
  | 'legacy_content_suppression'
  | 'brand_messaging_standardization'
  // Phase 2: Measurement & Monitoring
  | 'ga4_llm_traffic_setup'
  | 'ai_bot_log_file_analysis'
  | 'bi_weekly_llm_monitoring'
  // Phase 3: Content Optimization
  | 'deep_research_content_audit'
  | 'comparison_page_creation'
  | 'content_repositioning'
  | 'llm_friendly_content_checklist'
  | 'content_freshness_audit'
  // Phase 4: Third-Party Optimization
  | 'golden_links_opportunity_analysis'
  | 'entity_optimization'
  | 'reddit_brand_sentiment_monitoring'
  // Phase 5: Technical Implementation
  | 'ai_info_page_creation'
  | 'schema_markup_deployment'
  | 'semantic_html_optimization'
  // Phase 6: Content Generation
  | 'sme_content_generation'
  | 'trust_alignment_audit'
  // Phase 7: Client Services
  | 'weekly_aeo_reporting'
  | 'aeo_discovery_call'
  | 'aeo_audit_delivery'
  | 'competitive_llm_monitoring';

export type SopPhase = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type SopRunStatus =
  | 'not_started'
  | 'in_progress'
  | 'awaiting_input'
  | 'completed'
  | 'paused'
  | 'cancelled';

export type SopStepStatus =
  | 'not_started'
  | 'in_progress'
  | 'awaiting_input'
  | 'completed'
  | 'skipped';

// ───────────────────────────────────────────────────────────────
// Data inputs — what the engine auto-populates for each step
// from existing scanners (audit, suppression, GSC, AIO, etc.).
// The UI uses the `kind` to render the right "data card" in
// the step view; the server uses it to know which table to
// query.
// ───────────────────────────────────────────────────────────────
export type SopDataInputKind =
  | 'audit_run'             // alignment scores across providers
  | 'audit_citations'       // citation sources from latest audit
  | 'brand_truth'           // current Brand Truth payload
  | 'legacy_findings'       // suppression-scan findings table
  | 'pages'                 // crawled page corpus with main_content
  | 'gsc_metrics'           // per-URL clicks/impressions/ctr/position
  | 'gsc_top_pages'         // pages sorted by clicks (last 12 months)
  | 'aio_captures'          // DataForSEO AIO capture rows
  | 'entity_signals'        // schema.org + Wikidata + KG checks
  | 'third_party_listings'  // G2/LinkedIn/Wikipedia descriptions
  | 'competitors'           // competitor roster
  | 'reddit_mentions'       // triaged mentions
  | 'previous_sop_output'   // output_summary from a prior SOP step
  | 'manual_paste'          // operator pastes data (interim until automated)
  | 'external_url_fetch';   // tool fetches a URL and parses (for third-party listings)

export interface SopDataInput {
  kind: SopDataInputKind;
  label: string;             // user-facing label on the data card
  required: boolean;         // if true, step can't advance without this populated
  /**
   * Optional anchor — for kind:'previous_sop_output', which SOP+step to read
   * from. For kind:'external_url_fetch', the URL pattern (resolved at runtime).
   */
  anchor?: {
    sopKey?: SopKey;
    stepNumber?: number;
    urlField?: string;       // path into Brand Truth or sop_run.meta
  };
}

// ───────────────────────────────────────────────────────────────
// Gates — what the operator must confirm before advancing a step.
// Renders as a checklist in the step view; advanceStep() refuses
// to advance until every `required: true` gate is checked.
// ───────────────────────────────────────────────────────────────
export type SopGateKind = 'checkbox' | 'free_text' | 'attestation';

export interface SopGate {
  key: string;               // stable identifier, stored in operator_confirmations
  label: string;
  kind: SopGateKind;
  required: boolean;
  /**
   * For kind:'free_text', a hint / placeholder. For kind:'attestation', the
   * full statement the operator is affirming.
   */
  hint?: string;
}

// ───────────────────────────────────────────────────────────────
// Generators — what a step produces when completed.
// Deliverables are persisted into sop_deliverable; tickets into
// remediation_ticket with sop_run_id + sop_step_number set.
// ───────────────────────────────────────────────────────────────
export type DeliverableKind =
  | 'comparison_matrix_xlsx'
  | 'priority_actions_list'
  | 'decision_matrix_csv'
  | 'redirect_map_csv'
  | 'phased_implementation_plan_md'
  | 'messaging_framework_md'
  | 'schema_bundle_jsonld'
  | 'messaging_guide_md'
  | 'monitoring_log_md'
  | 'weekly_report_md'
  | 'audit_delivery_pdf';

/**
 * Ticket factory keys map to functions in lib/sop/ticket-factories.ts.
 * Each factory takes the step state + raw data inputs and emits a
 * RemediationTicket bundle with title/description/priority_rank/
 * remediation_copy/validation_steps/evidence_links pre-populated.
 */
export type TicketFactoryKey =
  | 'priority_actions_from_visibility_audit'    // ranks LLM-affected × ease × impact
  | 'suppression_decisions_to_tickets'          // one ticket per Delete/301/No-Index page
  | 'third_party_listing_updates'               // one per platform that needs updated copy
  | 'schema_patches_per_page'                   // one per missing schema type
  | 'reddit_escalations'                        // one per escalated mention
  | 'citation_diff_alerts';                     // one per lost-citation event

// ───────────────────────────────────────────────────────────────
// Step + SOP definition
// ───────────────────────────────────────────────────────────────
export interface SopStep {
  number: number;            // 1-based, must be sequential
  key: string;               // stable identifier (e.g. 'audit_spreadsheet_setup')
  title: string;
  /**
   * The "Process" bullets verbatim (or near-verbatim) from the SOP doc.
   * Renders as a numbered checklist in the step view. Operator can tick
   * items off but these are informational — gates is the enforcement.
   */
  process: string[];
  /**
   * What the engine pulls in automatically. The step view renders one
   * "data card" per input showing the live value.
   */
  dataInputs: SopDataInput[];
  /**
   * What the operator must do manually (alongside any data the engine
   * surfaced). Renders as a separate "your job" panel below the data
   * cards. Distinct from gates because not everything needs an
   * explicit gate — sometimes the doc just describes manual work.
   */
  operatorActions: string[];
  /**
   * Must-confirm before advancing. Hard enforcement.
   */
  gates: SopGate[];
  /**
   * The Output: line from the SOP doc — what this step is supposed to
   * have produced when complete. Renders in the step header.
   */
  output: string;
  /**
   * Optional deliverable + ticket factories the engine fires on
   * completion of this step.
   */
  generates?: {
    deliverableKinds?: DeliverableKind[];
    ticketsFromFactory?: TicketFactoryKey;
  };
}

export interface SopDefinition {
  key: SopKey;
  phase: SopPhase;
  name: string;
  /** One-paragraph purpose verbatim from the SOP doc. */
  purpose: string;
  /** "30-45 minutes per audit" — for the operator's planning. */
  timeRequired: string;
  /** "When to use" bullets from the SOP doc. */
  scope: string[];
  prerequisites: {
    tools: string[];
    access: string[];
    data: string[];
  };
  /**
   * Soft sequence — Suppression depends on Brand Visibility Audit, etc.
   * Server actions warn but allow override with a logged reason.
   */
  dependsOnSops: SopKey[];
  /**
   * 'one-time' for SOPs run once per major event (brand repositioning).
   * { intervalDays } for recurring ones (Brand Visibility every 4-6 weeks,
   * Bi-Weekly LLM Monitoring every 14, Weekly AEO Reporting every 7).
   */
  cadence: 'one-time' | { intervalDays: number; reason: string };
  steps: SopStep[];
  troubleshooting: { issue: string; cause: string; solution: string }[];
  /**
   * Cross-references back to other SOPs the doc explicitly calls out
   * ("Next SOP in series: ..." / "Related: ..."). Renders as a footer
   * on the SOP detail page.
   */
  relatedSops: SopKey[];
}

// ───────────────────────────────────────────────────────────────
// Convenience: SOPs grouped by phase, for the /sops page grid.
// ───────────────────────────────────────────────────────────────
export interface PhaseDefinition {
  phase: SopPhase;
  name: string;          // "Brand Audit & Analysis", etc.
  description: string;   // one-sentence phase summary
  sopKeys: SopKey[];     // in display order
}
