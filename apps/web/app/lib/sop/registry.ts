/**
 * SOP Registry — the single source of truth for all 24 SOPs.
 *
 * Phase 1 SOPs (Brand Visibility Audit, Legacy Content Suppression,
 * Brand Messaging Standardization) are fully specified per the Steve
 * Toth AEO Coaching SOP doc — every step's data inputs, operator
 * actions, gates, and generators are wired.
 *
 * Phases 2-7 SOPs are registered with their identity (key, phase,
 * name, purpose, time required, cadence, related SOPs) plus step
 * skeletons (number + title + one-line process). Step bodies, data
 * inputs, gates, and generators get filled in on Day 3 of the build.
 * The UI renders these SOPs with a `comingSoon: true` indicator on
 * each step that has an empty `process` array.
 *
 * Source: docs/design-sop-engine.md
 */

import type {
  SopDefinition,
  SopKey,
  PhaseDefinition,
} from './types';

// ═══════════════════════════════════════════════════════════════
// PHASE 1 — Brand Audit & Analysis (3 SOPs, fully specified)
// ═══════════════════════════════════════════════════════════════

const BRAND_VISIBILITY_AUDIT: SopDefinition = {
  key: 'brand_visibility_audit',
  phase: 1,
  name: 'Brand Visibility Audit',
  purpose:
    'Systematically evaluate how your brand appears across major AI platforms (LLMs), identify gaps in brand positioning, and create actionable documentation to guide optimization efforts. You query 5 major LLMs to understand how they define your brand, identify messaging inconsistencies, and document findings in a comparison matrix for strategic decision-making.',
  timeRequired: '30-45 minutes per brand audit',
  scope: [
    'Client is launching or has recently completed a brand repositioning',
    'Brand messaging appears inconsistent or outdated across AI search results',
    'Client asks "How does AI describe our brand?" or "What does ChatGPT say about us?"',
    'Before starting any AEO optimization work (this is Step 1 of the full AEO audit)',
    'Quarterly brand visibility monitoring for active AEO clients',
    'Competitive analysis to compare how LLMs describe your brand vs competitors',
  ],
  prerequisites: {
    tools: [
      'ChatGPT (free or paid account)',
      'Perplexity (free or paid account)',
      'Claude (free or paid account)',
      'Gemini (free or paid account)',
      'Bing Copilot (free, requires Microsoft account)',
      'Google Sheets or Excel for comparison matrix',
      'Screenshot tool',
    ],
    access: [
      'Active accounts for all 5 LLM platforms',
      'Permission to share findings with client (if applicable)',
    ],
    data: [
      'Brand name (exact spelling and variations if applicable)',
      'Current brand positioning statement (for comparison)',
      'Previous audit results (optional, if conducting follow-up audit)',
    ],
  },
  dependsOnSops: [],
  cadence: { intervalDays: 35, reason: 'Re-run every 4-6 weeks to track LLM perception drift after optimization work' },
  steps: [
    {
      number: 1,
      key: 'audit_spreadsheet_setup',
      title: 'Prepare Your Audit Spreadsheet',
      process: [
        'Open Google Sheets or Excel',
        'Create a new sheet titled "Brand Visibility Audit - [Brand Name] - [Date]"',
        'Set up columns: LLM Name · Query Used · Full Response · Key Description · Sources Cited · Alignment Score (R/Y/G) · Notes/Flags',
        'Add a second tab titled "Inconsistencies & Recommendations"',
      ],
      dataInputs: [
        { kind: 'brand_truth', label: 'Brand Truth v1 — anchors the alignment scoring', required: true },
      ],
      operatorActions: [
        'Confirm the brand name + any variations (legal name, DBA, abbreviation) are captured',
        'Verify the positioning statement in Brand Truth matches what marketing leadership currently approves',
      ],
      gates: [
        {
          key: 'positioning_statement_confirmed',
          label: 'Brand Truth positioning statement reviewed and matches current marketing-approved messaging',
          kind: 'checkbox',
          required: true,
        },
      ],
      output: 'Structured spreadsheet ready for data collection',
      generates: { deliverableKinds: ['comparison_matrix_xlsx'] },
    },
    {
      number: 2,
      key: 'query_each_llm',
      title: 'Query Each LLM with Standardized Questions',
      process: [
        'Open ChatGPT, Perplexity, Claude, Gemini, Bing Copilot in separate sessions',
        'Use the exact query "What is [Brand Name]?" on each platform',
        'Capture verbatim full response + screenshot',
        'Extract core definition (first 1-2 sentences) into Column D',
        'Document cited sources in Column E (especially for Perplexity)',
      ],
      dataInputs: [
        {
          kind: 'audit_run',
          label: 'Latest audit run — provides verbatim model responses across GPT/Claude/Gemini for the brand-name queries',
          required: true,
        },
      ],
      operatorActions: [
        'Verify the audit ran on `"What is [Brand Name]?"` (or equivalent brand-anchored queries from seed_query_intents)',
        'If queries were not brand-anchored, swap them in Brand Truth and re-run the audit',
      ],
      gates: [
        {
          key: 'audit_covers_brand_query',
          label: 'Audit corpus includes at least one "What is [Brand]?" style query for each provider',
          kind: 'checkbox',
          required: true,
        },
      ],
      output: '5 screenshots and complete text responses from all major LLMs',
    },
    {
      number: 3,
      key: 'test_browse_modes',
      title: 'Test Browse/Search Modes (Optional but Recommended)',
      process: [
        'In ChatGPT with Plus, enable Browse with Bing and re-run',
        'Document if response differs from standard ChatGPT',
        'In Perplexity, note which sources the default web mode prioritizes',
        'Create additional rows for browse-enabled responses if they differ substantially',
      ],
      dataInputs: [
        {
          kind: 'aio_captures',
          label: 'AI Overview captures from DataForSEO — equivalent to Bing-with-browse for the same brand queries',
          required: false,
        },
        {
          kind: 'audit_citations',
          label: 'Source citations the audit recorded across providers',
          required: false,
        },
      ],
      operatorActions: [
        'Compare AIO sources to the audit citations — note which third-party sites recur',
      ],
      gates: [],
      output: 'Additional data points showing how web search affects LLM responses',
    },
    {
      number: 4,
      key: 'analyze_alignment',
      title: 'Analyze and Score Alignment',
      process: [
        'Review client positioning statement (from Brand Truth)',
        'For each LLM response, assign R/Y/G alignment',
        '🔴 Red: outdated, incorrect, or completely misaligned',
        '🟡 Yellow: partially accurate, missing key messaging, or old terminology',
        '🟢 Green: accurate and aligned with current positioning',
        'In Notes/Flags, document specific issues (old category, missing product, competitor language)',
      ],
      dataInputs: [
        {
          kind: 'audit_run',
          label: 'Latest audit alignment scores — pre-computed RYG counts per provider/query',
          required: true,
        },
      ],
      operatorActions: [
        'Spot-check at least 3 alignment scores against the verbatim response — calibrate against Brand Truth',
        'Override any scores you disagree with via the audit detail page',
      ],
      gates: [
        {
          key: 'spot_checked_three',
          label: 'Spot-checked at least 3 alignment scores manually against the verbatim response',
          kind: 'checkbox',
          required: true,
        },
      ],
      output: 'Color-coded alignment assessment showing where brand messaging is strongest and weakest',
    },
    {
      number: 5,
      key: 'identify_patterns_and_sources',
      title: 'Identify Common Patterns and Sources',
      process: [
        'Document Consistent Themes (what all/most LLMs agree on)',
        'Document Conflicting Descriptions (where LLMs contradict)',
        'Document Cited Sources (which third-party sites are referenced)',
        'Look for outdated sources cited by multiple LLMs (e.g. old G2 listing)',
        'List specific third-party sources: G2, Crunchbase, Wikipedia, review sites, blog posts',
      ],
      dataInputs: [
        {
          kind: 'audit_citations',
          label: 'Domain frequency from audit citations — which sites the models reach for',
          required: true,
        },
        {
          kind: 'aio_captures',
          label: 'AIO sources — Google AIO citation set vs audit citation set',
          required: false,
        },
      ],
      operatorActions: [
        'Confirm the top 3-5 source domains the engine surfaced match what you see in raw responses',
        'Note any sources that look "outdated" (old G2 category, defunct blog post)',
      ],
      gates: [],
      output: 'Synthesized analysis showing root causes of messaging inconsistencies',
    },
    {
      number: 6,
      key: 'visual_comparison_matrix',
      title: 'Create Visual Comparison Matrix',
      process: [
        'Conditional formatting: Red/Yellow/Green cells',
        'Summary row: count platforms with outdated messaging, count platforms citing specific old source, % overall alignment',
        'Screenshot for client presentations',
      ],
      dataInputs: [
        {
          kind: 'previous_sop_output',
          label: 'Alignment scores from Step 4 + source patterns from Step 5',
          required: true,
          anchor: { sopKey: 'brand_visibility_audit', stepNumber: 4 },
        },
      ],
      operatorActions: [],
      gates: [],
      output: 'Client-ready visual showing brand visibility across AI platforms',
      generates: { deliverableKinds: ['comparison_matrix_xlsx'] },
    },
    {
      number: 7,
      key: 'document_priority_actions',
      title: 'Document Priority Actions',
      process: [
        'In Inconsistencies tab, create Priority Actions section',
        'List highest-impact fixes, each tied to a finding',
        'Examples: "Update G2 category from [old] to [new] (cited by 3/5 LLMs)" · "Purge blog posts containing old positioning language" · "Update Wikipedia first sentence" · "Create FAQ page with current positioning"',
        'Rank by: (number of LLMs affected) × (ease of implementation) × (impact on brand perception)',
      ],
      dataInputs: [
        {
          kind: 'previous_sop_output',
          label: 'All findings from Steps 4 and 5 — alignment scores and source patterns',
          required: true,
          anchor: { sopKey: 'brand_visibility_audit', stepNumber: 5 },
        },
      ],
      operatorActions: [
        'Review the auto-generated Priority Actions list',
        'Adjust priority ranks if the formula misranked anything',
        'Assign owners + due dates before clicking "Complete SOP"',
      ],
      gates: [
        {
          key: 'priority_actions_reviewed',
          label: 'Priority Actions list reviewed and ranking adjusted if needed',
          kind: 'checkbox',
          required: true,
        },
        {
          key: 'owners_assigned',
          label: 'All priority actions have an owner assigned',
          kind: 'checkbox',
          required: false,
          hint: 'Recommended but not blocking — you can assign later from /action-items',
        },
      ],
      output: 'Prioritized action plan for brand optimization work',
      generates: {
        deliverableKinds: ['priority_actions_list', 'comparison_matrix_xlsx'],
        ticketsFromFactory: 'priority_actions_from_visibility_audit',
      },
    },
  ],
  troubleshooting: [
    {
      issue: 'LLM returns "I don\'t have information about this brand"',
      cause: 'Brand is very new, has minimal web presence, or name is ambiguous',
      solution: 'Try adding context like "What is [Brand Name], the [category] company?" or verify web presence via domain search',
    },
    {
      issue: 'Responses vary drastically between multiple queries on same LLM',
      cause: 'LLMs use non-deterministic generation; results can vary slightly',
      solution: 'Run the query 2-3 times and document variations or use the most comprehensive response',
    },
    {
      issue: 'LLM cites sources but won\'t show full URLs',
      cause: 'Some platforms (Claude) reference sources without clickable links',
      solution: 'Use web search to find the likely source based on quoted text, or prioritize findings from Perplexity which shows explicit citations',
    },
    {
      issue: 'Client disagrees with your Red scoring on certain responses',
      cause: 'Client may have unrealistic expectations or not understand how old content affects LLMs',
      solution: 'Use the Sources Cited column to show them which outdated third-party listing is being referenced, making the issue concrete rather than subjective',
    },
  ],
  relatedSops: ['legacy_content_suppression', 'ga4_llm_traffic_setup'],
};

const LEGACY_CONTENT_SUPPRESSION: SopDefinition = {
  key: 'legacy_content_suppression',
  phase: 1,
  name: 'Legacy Content Suppression',
  purpose:
    'Systematically clean up content portfolios that confuse LLMs, improve brand messaging consistency, and prevent outdated information from appearing in AI-generated answers. Identify pages with outdated positioning, apply a decision framework (Delete vs 301 vs No-Index vs Keep), and implement technical changes to suppress content that no longer aligns with your brand.',
  timeRequired: '2-4 hours for initial audit + implementation time (varies by page count)',
  scope: [
    'After completing a Brand Visibility Audit that revealed outdated content issues',
    'Following a brand repositioning or product pivot',
    'When LLMs cite old blog posts, product pages, or terminology that no longer applies',
    'Client has legacy content from previous business models or strategies',
    'Preparing for major AEO optimization work (this is Step 2 after Brand Visibility Audit)',
    'Content portfolio has grown organically over years without strategic pruning',
  ],
  prerequisites: {
    tools: [
      'Google Search Console (verified access to client property)',
      'Screaming Frog SEO Spider OR Ahrefs Site Audit',
      'Google Sheets or Excel',
      'CMS access with permissions to delete/redirect/no-index pages',
      '301 redirect implementation method (htaccess, Yoast, Redirection plugin, or platform-specific)',
    ],
    access: [
      'Admin access to Google Search Console',
      'CMS admin or editor permissions',
      'FTP/server access if using htaccess',
    ],
    data: [
      'Current brand positioning statement (from Brand Visibility Audit)',
      'Old positioning/product terminology to flag',
      'List of outdated product categories, features, or use cases',
      'Brand Visibility Audit results showing which old content LLMs are citing',
    ],
  },
  dependsOnSops: ['brand_visibility_audit'],
  cadence: 'one-time',
  steps: [
    {
      number: 1,
      key: 'export_gsc_data',
      title: 'Export GSC Data for Analysis',
      process: [
        'Log into Google Search Console',
        'Navigate to Performance → Search Results, last 12 months',
        'Export with brand-filtered queries and without filter',
        'Combine into spreadsheet: URL · Clicks · Impressions · Avg Position · Content Category · Decision · Redirect Target · Notes',
      ],
      dataInputs: [
        {
          kind: 'gsc_metrics',
          label: 'GSC per-URL metrics (last 12 months) — clicks/impressions/ctr/position for every indexed page',
          required: true,
        },
      ],
      operatorActions: [
        'Verify the GSC connection is healthy in firm Settings',
        'If the firm has no GSC connection yet, connect it before proceeding',
      ],
      gates: [
        {
          key: 'gsc_connected',
          label: 'Search Console is connected for this firm and last_synced_at is within 48 hours',
          kind: 'checkbox',
          required: true,
        },
      ],
      output: 'Clean spreadsheet with all pages receiving search traffic, sorted by performance',
    },
    {
      number: 2,
      key: 'identify_outdated_pages',
      title: 'Identify Outdated and Low-Traffic Pages',
      process: [
        'Review Brand Visibility Audit results — identify old positioning language, outdated categories, old company names',
        'Categorize each page (Blog · Product · Use case · Docs · Help · Landing)',
        'Search URL list for old terminology (e.g. /community/, /developer-relations/)',
        'Flag any matches in Notes',
        'Sort by Clicks (low → high)',
        'Flag pages with <10 clicks/month AND containing outdated messaging',
      ],
      dataInputs: [
        {
          kind: 'pages',
          label: 'Crawled page corpus — title + main_content + url for every page on the firm site',
          required: true,
        },
        {
          kind: 'legacy_findings',
          label: 'Suppression-scan findings — pre-computed semantic distance per page vs Brand Truth centroid',
          required: true,
        },
        {
          kind: 'previous_sop_output',
          label: 'Brand Visibility Audit Step 5 — list of outdated terminology + cited sources',
          required: true,
          anchor: { sopKey: 'brand_visibility_audit', stepNumber: 5 },
        },
      ],
      operatorActions: [
        'Review flagged pages and confirm the outdated terminology matches what the Brand Visibility Audit surfaced',
      ],
      gates: [],
      output: 'Spreadsheet with all pages categorized and flagged for outdated content',
    },
    {
      number: 3,
      key: 'apply_decision_framework',
      title: 'Apply Decision Framework (Delete vs 301 vs No-Index vs Keep)',
      process: [
        'DELETE if: <5 clicks/mo AND completely outdated AND no valuable backlinks AND topic no longer relevant',
        '301 REDIRECT if: ≥10 clicks/mo OR valuable backlinks, with a clear replacement page',
        'NO-INDEX if: 5-20 clicks/mo but page needs to exist (internal tool, temporary, being updated)',
        'KEEP (Update) if: 50+ clicks/mo AND content can be updated to reflect current positioning',
        'Document decision per page',
        'For 301s, identify redirect target',
      ],
      dataInputs: [
        {
          kind: 'gsc_top_pages',
          label: 'Per-URL clicks (last 12 months) — drives the threshold logic',
          required: true,
        },
        {
          kind: 'legacy_findings',
          label: 'Suppression-scan findings — semantic distance signals which pages drift from Brand Truth',
          required: true,
        },
      ],
      operatorActions: [
        'Review the engine-suggested action for each flagged page (Delete/301/No-Index/Keep)',
        'Override any suggestions you disagree with — log a reason',
        'For 301s, confirm or update the suggested redirect target',
      ],
      gates: [
        {
          key: 'decisions_reviewed',
          label: 'Every flagged page has a decision (Delete / 301 / No-Index / Keep) confirmed by the operator',
          kind: 'checkbox',
          required: true,
        },
      ],
      output: 'Complete decision matrix with clear actions for each flagged page',
      generates: { deliverableKinds: ['decision_matrix_csv'] },
    },
    {
      number: 4,
      key: 'validate_redirects_and_backlinks',
      title: 'Validate Redirect Targets and Backlink Impact',
      process: [
        'For all "301" pages: verify target exists, indexed, content related, reflects current positioning',
        'Check backlink profile for high-priority pages',
        'Flag pages with 100+ monthly clicks AND 10+ referring domains for content refresh instead of suppression',
      ],
      dataInputs: [
        {
          kind: 'pages',
          label: 'Crawled pages — used to verify redirect targets exist',
          required: true,
        },
        {
          kind: 'gsc_top_pages',
          label: 'High-traffic pages flagged for individual review',
          required: true,
        },
      ],
      operatorActions: [
        'Manually verify redirect targets in browser for top 10 highest-traffic 301s',
        'Use Ahrefs or GSC Links to check backlinks for any page with 5+ referring domains',
      ],
      gates: [
        {
          key: 'high_traffic_reviewed',
          label: 'All pages with 50+ monthly clicks have been individually reviewed',
          kind: 'checkbox',
          required: true,
        },
      ],
      output: 'Validated redirect targets and flagged high-value pages',
    },
    {
      number: 5,
      key: 'implementation_checklist',
      title: 'Create Implementation Checklist',
      process: [
        'Group pages by action type (Delete / 301 / No-Index)',
        'Per-section steps + timeline estimates',
        'Deletions: 30 min per batch of 50 · Redirects: 1-2 hr setup + testing · No-Index: 15-30 min per batch of 20',
      ],
      dataInputs: [
        {
          kind: 'previous_sop_output',
          label: 'Decisions from Step 3 + validated targets from Step 4',
          required: true,
          anchor: { sopKey: 'legacy_content_suppression', stepNumber: 4 },
        },
      ],
      operatorActions: [
        'Confirm timeline estimates against your team\'s availability',
      ],
      gates: [],
      output: 'Step-by-step implementation plan organized by action type',
      generates: { deliverableKinds: ['redirect_map_csv', 'phased_implementation_plan_md'] },
    },
    {
      number: 6,
      key: 'implement_technical_changes',
      title: 'Implement Technical Changes (Phased)',
      process: [
        'Phase A: No-Index Pages (lowest risk) — add noindex meta tag, verify in page source',
        'Phase B: 301 Redirects (medium risk) — back up .htaccess, implement via Redirection plugin / htaccess / Cloudflare, test each redirect',
        'Phase C: Deletions (highest risk) — back up content, move to Trash, wait 2-4 weeks, monitor analytics, permanently delete',
      ],
      dataInputs: [
        {
          kind: 'previous_sop_output',
          label: 'Implementation checklist from Step 5',
          required: true,
          anchor: { sopKey: 'legacy_content_suppression', stepNumber: 5 },
        },
      ],
      operatorActions: [
        'Implement Phase A (No-Index) and verify each page in source',
        'Implement Phase B (301s) only after Phase A is stable',
        'Wait 2-4 weeks before Phase C (Deletions)',
        'Tick off each ticket in /action-items as you complete it',
      ],
      gates: [
        {
          key: 'phase_a_complete',
          label: 'Phase A (No-Index) implemented and verified',
          kind: 'attestation',
          required: false,
        },
        {
          key: 'phase_b_complete',
          label: 'Phase B (301 Redirects) implemented and tested',
          kind: 'attestation',
          required: false,
        },
        {
          key: 'phase_c_complete',
          label: 'Phase C (Deletions) implemented after the 2-4 week monitoring window',
          kind: 'attestation',
          required: false,
        },
      ],
      output: 'All technical changes implemented with verification completed',
      generates: { ticketsFromFactory: 'suppression_decisions_to_tickets' },
    },
    {
      number: 7,
      key: 'monitor_and_document',
      title: 'Monitor and Document Results',
      process: [
        'Track weekly for 4-6 weeks: total indexed pages, brand query traffic, 404 errors, redirect chains',
        'Re-run Brand Visibility Audit 4-6 weeks after implementation',
        'Compare LLM responses before/after',
        'Document changes in monitoring log',
      ],
      dataInputs: [
        {
          kind: 'gsc_metrics',
          label: 'GSC weekly snapshots — for the 4-6 week monitoring window',
          required: true,
        },
        {
          kind: 'previous_sop_output',
          label: 'Suppression actions taken in Step 6',
          required: true,
          anchor: { sopKey: 'legacy_content_suppression', stepNumber: 6 },
        },
      ],
      operatorActions: [
        'Schedule the follow-up Brand Visibility Audit (the engine auto-creates one when this SOP completes)',
      ],
      gates: [
        {
          key: 'monitoring_window_complete',
          label: 'At least 4 weeks of post-implementation monitoring complete',
          kind: 'attestation',
          required: true,
        },
      ],
      output: 'Complete implementation report with before/after metrics and LLM visibility improvements',
      generates: { deliverableKinds: ['monitoring_log_md'] },
    },
  ],
  troubleshooting: [
    { issue: 'CMS won\'t let you bulk delete pages', cause: 'Platform limitations or permission restrictions', solution: 'Use CSV export → bulk edit → re-import, or contact platform support for bulk operations API' },
    { issue: 'Redirects not working after implementation', cause: 'Cache issues, syntax errors in htaccess, or plugin conflicts', solution: 'Clear browser cache, test in incognito, validate htaccess syntax, disable conflicting plugins' },
    { issue: '404 errors in GSC after deletions', cause: 'Internal links still pointing to deleted pages', solution: 'Crawl with Screaming Frog, filter 404s, update internal links in CMS' },
    { issue: 'Traffic drops unexpectedly after implementation', cause: 'Accidentally deleted/redirected high-value page, or redirect target is irrelevant', solution: 'Check analytics for specific pages with drops, restore page if needed, fix redirect target' },
    { issue: 'LLMs still cite old content 4+ weeks after suppression', cause: 'LLMs have longer refresh cycles than Google; may take 2-3 months', solution: 'Focus on creating new authoritative content, update third-party listings, monitor bi-weekly' },
    { issue: 'Client wants to keep page "just in case" despite low traffic', cause: 'Emotional attachment or fear of losing historical content', solution: 'Offer no-index as compromise (keeps URL live but hidden), or suggest archiving in Help Center' },
  ],
  relatedSops: ['brand_visibility_audit', 'brand_messaging_standardization'],
};

const BRAND_MESSAGING_STANDARDIZATION: SopDefinition = {
  key: 'brand_messaging_standardization',
  phase: 1,
  name: 'Brand Messaging Standardization',
  purpose:
    'Establish consistent brand messaging across the web, ensuring LLMs present accurate and aligned information regardless of source. Extract existing brand definitions from multiple platforms, create standardized messaging templates, update third-party listings, and implement schema markup for consistent entity recognition by AI systems.',
  timeRequired: '3-5 hours for audit and template creation + 2-4 hours for implementation across platforms',
  scope: [
    'After completing Brand Visibility Audit and Legacy Content Suppression',
    'When LLMs describe your brand inconsistently across different platforms',
    'Following a brand repositioning or messaging refresh',
    'Before launching major AEO optimization campaigns',
    'When third-party listings contain outdated or inconsistent descriptions',
    'Quarterly review to ensure messaging stays aligned',
    'New product launches that require updated positioning language',
  ],
  prerequisites: {
    tools: [
      'Google Sheets or Excel',
      'Edit access: G2 admin · LinkedIn admin · Crunchbase · Wikipedia · Wikidata',
      'CMS access',
      'Schema markup tools (GTM, Yoast, or manual HTML)',
      "Google's Schema Markup Validator",
    ],
    access: [
      'Admin access to all company social media and listing profiles',
      'CMS admin permissions',
      'GTM access (if using for schema)',
      'Ability to edit meta descriptions and page titles',
    ],
    data: [
      'Current brand positioning statement',
      'Brand Visibility Audit results showing inconsistencies',
      'List of all third-party platforms where brand is listed',
      'Current website homepage, about page, and product page copy',
      'Target audience personas and use cases',
    ],
  },
  dependsOnSops: ['brand_visibility_audit', 'legacy_content_suppression'],
  cadence: { intervalDays: 90, reason: 'Quarterly review to catch messaging drift across platforms' },
  steps: [
    {
      number: 1,
      key: 'extract_existing_descriptions',
      title: 'Extract Existing Brand Definitions Across Platforms',
      process: [
        'Inventory first-party: website H1/hero, about page, product page, meta description, LinkedIn, Twitter, Facebook',
        'Inventory third-party: G2, Capterra, TrustRadius, Crunchbase, Wikipedia, Wikidata, Product Hunt, industry directories',
        'Capture description + char count + last-updated date per platform',
        'Score R/Y/G alignment for each',
      ],
      dataInputs: [
        { kind: 'brand_truth', label: 'Current Brand Truth — the source of truth to compare against', required: true },
        {
          kind: 'third_party_listings',
          label: 'Third-party listings — fetched from G2/LinkedIn/Wikipedia/etc URLs in Brand Truth',
          required: true,
        },
      ],
      operatorActions: [
        'Confirm the third-party URLs in Brand Truth are correct and complete',
        'Add missing platforms (e.g. Crunchbase profile URL) to Brand Truth before advancing',
      ],
      gates: [
        {
          key: 'third_party_urls_inventoried',
          label: 'All known third-party listing URLs are in Brand Truth third_party_listings',
          kind: 'checkbox',
          required: true,
        },
      ],
      output: 'Complete inventory of how your brand is described across all platforms',
    },
    {
      number: 2,
      key: 'one_line_definition',
      title: 'Create One-Line Definition Template',
      process: [
        'Review Green-scored descriptions from Step 1',
        'Optional competitor positioning analysis',
        'Draft using: "[Company Name] is [category] that [unique value prop] for [target audience]."',
        'Test: buzzword-free, clear, <140 chars, understandable to outsiders',
        'Get marketing leadership approval',
        'Create variations: Short (60 chars) · Standard (140) · Extended (250)',
      ],
      dataInputs: [
        {
          kind: 'previous_sop_output',
          label: 'Green-scored descriptions from Step 1 — patterns to draw from',
          required: true,
          anchor: { sopKey: 'brand_messaging_standardization', stepNumber: 1 },
        },
        { kind: 'competitors', label: 'Competitor roster — for differentiation framing', required: false },
      ],
      operatorActions: [
        'Draft the three character-count variations',
        'Get marketing leadership approval (the engine will block advance until you attest)',
      ],
      gates: [
        {
          key: 'one_liner_drafted',
          label: 'Three variations drafted (60 / 140 / 250 chars)',
          kind: 'checkbox',
          required: true,
        },
        {
          key: 'leadership_approved',
          label: 'Marketing leadership has approved the new one-liner',
          kind: 'attestation',
          required: true,
        },
      ],
      output: 'Approved one-line definition with character-count variations',
      generates: { deliverableKinds: ['messaging_framework_md'] },
    },
    {
      number: 3,
      key: 'extended_messaging_components',
      title: 'Create Extended Messaging Components',
      process: [
        'Write 2-3 sentence elevator pitch (250-300 chars)',
        'List 3-5 core use cases (parallel structure)',
        'Write 2-3 competitor comparison angles',
        'Define target audience (1-2 sentences)',
        'Review for consistency (terminology, category, differentiators)',
      ],
      dataInputs: [
        {
          kind: 'previous_sop_output',
          label: 'One-liner variations from Step 2',
          required: true,
          anchor: { sopKey: 'brand_messaging_standardization', stepNumber: 2 },
        },
      ],
      operatorActions: [
        'Draft each component (elevator pitch, use cases, comparison angles, audience)',
      ],
      gates: [
        {
          key: 'components_complete',
          label: 'All four messaging components drafted (pitch, use cases, comparisons, audience)',
          kind: 'checkbox',
          required: true,
        },
      ],
      output: 'Complete messaging framework with all components documented',
      generates: { deliverableKinds: ['messaging_framework_md'] },
    },
    {
      number: 4,
      key: 'update_third_party_listings',
      title: 'Update Third-Party Listings',
      process: [
        'Priority order: Wikipedia/Wikidata → LinkedIn → G2/Capterra/TrustRadius → Crunchbase → Product Hunt → industry directories',
        'For each: screenshot old version, paste new messaging, screenshot new version, log change',
      ],
      dataInputs: [
        {
          kind: 'third_party_listings',
          label: 'Current third-party descriptions (from Step 1)',
          required: true,
        },
        {
          kind: 'previous_sop_output',
          label: 'Approved messaging framework from Steps 2-3',
          required: true,
          anchor: { sopKey: 'brand_messaging_standardization', stepNumber: 3 },
        },
      ],
      operatorActions: [
        'Update each third-party listing manually (the engine cannot publish on your behalf)',
        'Tick off each ticket in /action-items as you update each platform',
      ],
      gates: [],
      output: 'All third-party listings updated with consistent messaging',
      generates: { ticketsFromFactory: 'third_party_listing_updates' },
    },
    {
      number: 5,
      key: 'update_first_party_website',
      title: 'Update First-Party Website Content',
      process: [
        'Homepage: H1 + hero subheading + meta title (60) + meta description (155)',
        'About: first paragraph + mission + product descriptions',
        'Product pages: extended version + benefit statements + comparison sections',
        'Pricing: top description + plan descriptions',
        'Footer: tagline',
        'Get copywriting/marketing approval, implement in CMS, verify via page source',
      ],
      dataInputs: [
        {
          kind: 'pages',
          label: 'Current first-party website pages — what needs updating',
          required: true,
        },
        {
          kind: 'previous_sop_output',
          label: 'Approved messaging framework',
          required: true,
          anchor: { sopKey: 'brand_messaging_standardization', stepNumber: 3 },
        },
      ],
      operatorActions: [
        'Implement homepage + about + product page copy changes in CMS',
        'Verify each change is live via page source',
      ],
      gates: [
        {
          key: 'website_changes_live',
          label: 'Homepage, About, and key product pages updated and verified live',
          kind: 'attestation',
          required: true,
        },
      ],
      output: 'Website updated with consistent brand messaging across all pages',
    },
    {
      number: 6,
      key: 'implement_schema_markup',
      title: 'Implement Schema Markup for Entity Recognition',
      process: [
        'Organization schema on homepage (name, url, logo, description, sameAs, foundingDate, address)',
        'SoftwareApplication / LegalService / etc on product pages',
        'FAQPage schema if FAQ section exists',
        'Implement via GTM, Yoast/RankMath, or manual HTML',
        'Validate with Google Rich Results Test',
      ],
      dataInputs: [
        {
          kind: 'entity_signals',
          label: 'Current schema coverage from the entity scanner — gaps + auto-generated JSON-LD patches',
          required: true,
        },
        {
          kind: 'brand_truth',
          label: 'Brand Truth — source for legal name, founding date, address, founders',
          required: true,
        },
      ],
      operatorActions: [
        'Apply the engine-generated JSON-LD patches (Entity tab → Copy)',
        'Validate each page with Google Rich Results Test',
      ],
      gates: [
        {
          key: 'schema_validated',
          label: 'All required schema types pass Google Rich Results Test with no errors',
          kind: 'attestation',
          required: true,
        },
      ],
      output: 'Schema markup implemented and validated across key pages',
      generates: { deliverableKinds: ['schema_bundle_jsonld'], ticketsFromFactory: 'schema_patches_per_page' },
    },
    {
      number: 7,
      key: 'internal_messaging_guide',
      title: 'Create Internal Messaging Guide',
      process: [
        'Section 1: Core messaging (one-liner variations, elevator pitch, do\'s and don\'ts)',
        'Section 2: Platform-specific templates (G2, LinkedIn, Wikipedia, etc.)',
        'Section 3: Boilerplate text (press release, email signature, slide deck, blog author bio)',
        'Section 4: Update schedule (quarterly review, who\'s responsible, how to request changes)',
        'Section 5: Third-party platform log',
        'Share with marketing/sales, store in company drive',
      ],
      dataInputs: [
        {
          kind: 'previous_sop_output',
          label: 'Everything from Steps 2-6 — assembled into a single guide',
          required: true,
          anchor: { sopKey: 'brand_messaging_standardization', stepNumber: 6 },
        },
      ],
      operatorActions: [
        'Share the generated guide with marketing + sales teams',
        'Confirm update-schedule owner',
      ],
      gates: [
        {
          key: 'guide_distributed',
          label: 'Internal messaging guide shared with marketing and sales',
          kind: 'attestation',
          required: true,
        },
      ],
      output: 'Comprehensive internal guide for maintaining consistent messaging',
      generates: { deliverableKinds: ['messaging_guide_md'] },
    },
  ],
  troubleshooting: [
    { issue: 'Wikipedia edit reverted within hours', cause: "Didn't follow neutral point of view policy, added promotional language, or didn't cite sources", solution: 'Review Wikipedia COI guidelines, make edits more neutral, add citations to third-party sources' },
    { issue: 'G2 won\'t let you change category', cause: 'Category changes require verification or minimum review threshold', solution: 'Contact G2 support directly with evidence of product capabilities; 2-4 week timeline' },
    { issue: 'Schema validation shows errors', cause: 'Missing required properties, incorrect JSON syntax, or invalid values', solution: 'Use a JSON validator, ensure all required properties are present, fix syntax errors' },
    { issue: 'LinkedIn description keeps reverting', cause: 'Multiple admins editing, or LinkedIn flagging content', solution: 'Coordinate with all page admins, avoid spammy keywords, keep description professional' },
    { issue: 'LLMs still use old messaging 6+ weeks after updates', cause: 'LLMs have 2-3 month refresh cycles for most content, longer for Wikipedia', solution: 'Continue monitoring bi-weekly; ensure ALL platforms are updated' },
    { issue: 'Team members keep using old terminology', cause: 'Internal guide not widely distributed or not enforced', solution: 'Add messaging guide to onboarding, create templates with correct language, quarterly team training' },
  ],
  relatedSops: ['brand_visibility_audit', 'legacy_content_suppression', 'ga4_llm_traffic_setup'],
};

// ═══════════════════════════════════════════════════════════════
// PHASES 2-7 — skeleton (step titles only; bodies on Day 3)
// ═══════════════════════════════════════════════════════════════

/**
 * stub(): build a placeholder step with title + an empty process array.
 * The UI treats `process.length === 0` as "coming soon" and disables
 * the Complete button until Day 3 fills in the body.
 */
function stub(number: number, key: string, title: string): SopDefinition['steps'][number] {
  return {
    number,
    key,
    title,
    process: [],
    dataInputs: [],
    operatorActions: [],
    gates: [],
    output: '(Step body authored on Day 3)',
  };
}

const GA4_LLM_TRAFFIC_SETUP: SopDefinition = {
  key: 'ga4_llm_traffic_setup',
  phase: 2,
  name: 'GA4 LLM Traffic Setup',
  purpose:
    'Measure the impact of AEO efforts, track traffic from AI platforms, and demonstrate ROI to stakeholders with concrete data. Create custom dimensions for LLM tracking, structure UTM parameters for LLM referrals, configure dashboards for visibility metrics, and set up alerts for traffic drops.',
  timeRequired: '1-2 hours for initial setup + 30 minutes for dashboard configuration',
  scope: [
    'After implementing brand messaging changes (to track impact)',
    'For any client running AEO optimization (this is the measurement layer)',
    'Following the launch of a /ai-info or /llm-info page',
  ],
  prerequisites: { tools: ['GA4 admin access'], access: ['GA4 admin'], data: ['Current GA4 property ID'] },
  dependsOnSops: ['brand_messaging_standardization'],
  cadence: 'one-time',
  steps: [
    stub(1, 'create_custom_dimensions', 'Create Custom Dimensions for LLM Tracking'),
    stub(2, 'utm_parameter_strategy', 'Define UTM Parameter Strategy for LLM Referrals'),
    stub(3, 'gtm_referrer_capture', 'Implement GTM Tag for Referrer Capture'),
    stub(4, 'configure_dashboard', 'Configure LLM Traffic Dashboard'),
    stub(5, 'setup_alerts', 'Set Up Traffic Drop Alerts'),
    stub(6, 'baseline_report', 'Generate Baseline Report'),
  ],
  troubleshooting: [],
  relatedSops: ['ai_bot_log_file_analysis', 'bi_weekly_llm_monitoring', 'weekly_aeo_reporting'],
};

const AI_BOT_LOG_FILE_ANALYSIS: SopDefinition = {
  key: 'ai_bot_log_file_analysis',
  phase: 2,
  name: 'AI Bot Log File Analysis',
  purpose:
    'Monitor how AI bots interact with your website using server log files, revealing visibility that traditional analytics tools cannot capture (GA4 filters or misattributes bot activity).',
  timeRequired: '1-2 hours per analysis',
  scope: ['Quarterly review of bot crawl behavior', 'After implementing schema changes (verify pickup)', 'When LLM citation rates change unexpectedly'],
  prerequisites: { tools: ['Server log access', 'Log analyzer (Screaming Frog Log File Analyser or Splunk)'], access: ['FTP/SSH to server'], data: ['Last 30 days of server logs'] },
  dependsOnSops: ['ga4_llm_traffic_setup'],
  cadence: { intervalDays: 90, reason: 'Quarterly bot-crawl audit' },
  steps: [
    stub(1, 'collect_log_files', 'Collect and Parse Log Files'),
    stub(2, 'identify_ai_bots', 'Identify AI Bot User-Agents'),
    stub(3, 'analyze_crawl_patterns', 'Analyze Crawl Patterns by Bot'),
    stub(4, 'identify_blocked_paths', 'Identify Blocked or Errored Paths'),
    stub(5, 'document_findings', 'Document Findings'),
  ],
  troubleshooting: [],
  relatedSops: ['ga4_llm_traffic_setup', 'bi_weekly_llm_monitoring'],
};

const BI_WEEKLY_LLM_MONITORING: SopDefinition = {
  key: 'bi_weekly_llm_monitoring',
  phase: 2,
  name: 'Bi-Weekly LLM Monitoring',
  purpose:
    'Maintain ongoing visibility into brand performance in AI search, catch negative shifts early, and measure improvement trends systematically.',
  timeRequired: '45-60 minutes per monitoring session (bi-weekly)',
  scope: ['Standing requirement for any active AEO client', 'After implementing initial AEO changes'],
  prerequisites: { tools: ['All 5 LLM platforms', 'Tracking spreadsheet'], access: ['Active LLM accounts'], data: ['Baseline from Brand Visibility Audit'] },
  dependsOnSops: ['brand_visibility_audit'],
  cadence: { intervalDays: 14, reason: 'Bi-weekly cadence per SOP' },
  steps: [
    stub(1, 'rerun_baseline_queries', 'Re-run Baseline Queries'),
    stub(2, 'score_changes', 'Score Changes vs Baseline'),
    stub(3, 'flag_regressions', 'Flag Regressions'),
    stub(4, 'update_monitoring_log', 'Update Monitoring Log'),
    stub(5, 'alert_stakeholders', 'Alert Stakeholders on Regressions'),
  ],
  troubleshooting: [],
  relatedSops: ['brand_visibility_audit', 'weekly_aeo_reporting'],
};

const DEEP_RESEARCH_CONTENT_AUDIT: SopDefinition = {
  key: 'deep_research_content_audit',
  phase: 3,
  name: 'Deep Research Content Audit',
  purpose:
    'Optimize content for Deep Research features, capture traffic from query refinements, and surface lower-ranking pages through multi-hop queries.',
  timeRequired: '2-3 hours for initial audit + ongoing optimization',
  scope: ['Pages with low traffic that match Deep Research query patterns', 'After Brand Visibility Audit reveals refinement-style query gaps'],
  prerequisites: { tools: ['ChatGPT Deep Research', 'GSC'], access: ['GSC admin'], data: ['Brand Truth seed queries', 'Top-20 ranking pages from GSC'] },
  dependsOnSops: ['brand_visibility_audit'],
  cadence: { intervalDays: 90, reason: 'Quarterly Deep Research audit' },
  steps: [
    stub(1, 'identify_refinement_queries', 'Identify Refinement-Style Queries'),
    stub(2, 'audit_existing_coverage', 'Audit Existing Page Coverage'),
    stub(3, 'identify_gaps', 'Identify Coverage Gaps'),
    stub(4, 'prioritize_pages', 'Prioritize Pages for Optimization'),
    stub(5, 'generate_recommendations', 'Generate Per-Page Recommendations'),
  ],
  troubleshooting: [],
  relatedSops: ['content_repositioning', 'llm_friendly_content_checklist'],
};

const COMPARISON_PAGE_CREATION: SopDefinition = {
  key: 'comparison_page_creation',
  phase: 3,
  name: 'Comparison Page Creation',
  purpose:
    'Create comparison content that LLMs cite frequently, position the brand favorably against competitors, and capture high-intent comparison queries.',
  timeRequired: '3-4 hours per comparison page',
  scope: ['When competitors dominate "X vs Y" queries in audit results', 'After identifying differentiation opportunities'],
  prerequisites: { tools: ['CMS access'], access: ['Marketing approval workflow'], data: ['Competitor roster', 'Differentiation angles from Brand Messaging Standardization'] },
  dependsOnSops: ['brand_messaging_standardization'],
  cadence: 'one-time',
  steps: [
    stub(1, 'select_comparison_target', 'Select Comparison Target'),
    stub(2, 'research_competitor_positioning', 'Research Competitor Positioning'),
    stub(3, 'draft_comparison_table', 'Draft Comparison Table'),
    stub(4, 'write_narrative', 'Write Narrative Sections'),
    stub(5, 'implement_schema', 'Implement Schema (FAQPage + Comparison)'),
    stub(6, 'publish_and_index', 'Publish and Submit for Indexing'),
  ],
  troubleshooting: [],
  relatedSops: ['competitive_llm_monitoring', 'content_repositioning'],
};

const CONTENT_REPOSITIONING: SopDefinition = {
  key: 'content_repositioning',
  phase: 3,
  name: 'Content Repositioning',
  purpose:
    'Refresh existing content for AEO without starting from scratch, maximize ROI from content investments, and improve rankings in AI-generated answers.',
  timeRequired: '2-3 hours per page for comprehensive repositioning',
  scope: ['Pages flagged "Keep + Update" in Legacy Content Suppression', 'Pages with strong backlinks but stale positioning'],
  prerequisites: { tools: ['CMS access', 'LLM-Friendly Content Checklist'], access: ['Editorial approval'], data: ['Brand Truth', 'Original page content + traffic data'] },
  dependsOnSops: ['legacy_content_suppression', 'brand_messaging_standardization'],
  cadence: 'one-time',
  steps: [
    stub(1, 'audit_existing_page', 'Audit Existing Page Against Brand Truth'),
    stub(2, 'identify_changes', 'Identify Required Changes'),
    stub(3, 'rewrite_intro', 'Rewrite Intro + H1 + Meta'),
    stub(4, 'restructure_body', 'Restructure Body for AEO'),
    stub(5, 'update_schema', 'Update Schema Markup'),
    stub(6, 'publish_and_verify', 'Publish and Verify'),
  ],
  troubleshooting: [],
  relatedSops: ['llm_friendly_content_checklist', 'content_freshness_audit'],
};

const LLM_FRIENDLY_CONTENT_CHECKLIST: SopDefinition = {
  key: 'llm_friendly_content_checklist',
  phase: 3,
  name: 'LLM-Friendly Content Checklist',
  purpose:
    'Quality-check content before publication, ensure it meets LLM optimization standards, and reduce revision cycles through consistent application of best practices.',
  timeRequired: '15-30 minutes per page (pre-publication review)',
  scope: ['Every new page or significant content update', 'Pre-publication QA gate'],
  prerequisites: { tools: ['Schema validator', 'Content scoring rubric'], access: ['CMS preview'], data: ['Brand Truth', 'LLM-friendliness checklist'] },
  dependsOnSops: ['brand_messaging_standardization'],
  cadence: 'one-time',
  steps: [
    stub(1, 'structure_check', 'Structure Check (H1, headings, intro)'),
    stub(2, 'positioning_alignment', 'Positioning Alignment Check'),
    stub(3, 'schema_check', 'Schema Markup Check'),
    stub(4, 'citation_readiness', 'Citation Readiness Check'),
    stub(5, 'final_approval', 'Final Approval + Publish'),
  ],
  troubleshooting: [],
  relatedSops: ['content_repositioning', 'content_freshness_audit'],
};

const CONTENT_FRESHNESS_AUDIT: SopDefinition = {
  key: 'content_freshness_audit',
  phase: 3,
  name: 'Content Freshness Audit',
  purpose:
    'Systematically identify and refresh outdated content to maximize LLM citations and maintain AI search visibility. Content less than 12 months old is favored by LLMs.',
  timeRequired: '2-3 hours for audit + 1-2 hours per page refreshed',
  scope: ['Quarterly content portfolio review', 'After major industry shift makes content obsolete'],
  prerequisites: { tools: ['CMS access', 'GSC'], access: ['CMS admin'], data: ['Page last-modified dates', 'GSC click trends'] },
  dependsOnSops: [],
  cadence: { intervalDays: 90, reason: 'Quarterly freshness audit' },
  steps: [
    stub(1, 'inventory_by_age', 'Inventory Content by Age'),
    stub(2, 'identify_decay_candidates', 'Identify Decay Candidates'),
    stub(3, 'prioritize_refresh', 'Prioritize for Refresh'),
    stub(4, 'refresh_and_republish', 'Refresh and Republish'),
    stub(5, 'verify_pickup', 'Verify LLM/Google Pickup'),
  ],
  troubleshooting: [],
  relatedSops: ['content_repositioning', 'llm_friendly_content_checklist'],
};

const GOLDEN_LINKS_OPPORTUNITY_ANALYSIS: SopDefinition = {
  key: 'golden_links_opportunity_analysis',
  phase: 4,
  name: 'Golden Links Opportunity Analysis',
  purpose:
    'Identify and secure high-authority third-party mentions that LLMs trust most, amplifying brand visibility without direct control of source content.',
  timeRequired: '2-3 hours for initial analysis + ongoing outreach',
  scope: ['After Brand Visibility Audit reveals citation gaps', 'Pre-launch of new product or repositioning'],
  prerequisites: { tools: ['Ahrefs or Moz', 'Outreach tool'], access: ['Email outreach permissions'], data: ['Competitor backlink profiles', 'Industry publication list'] },
  dependsOnSops: ['brand_visibility_audit', 'entity_optimization'],
  cadence: 'one-time',
  steps: [
    stub(1, 'identify_target_publications', 'Identify Target Publications'),
    stub(2, 'analyze_competitor_links', 'Analyze Competitor Link Profiles'),
    stub(3, 'rank_opportunities', 'Rank Opportunities by Authority + Relevance'),
    stub(4, 'craft_outreach', 'Craft Outreach Messages'),
    stub(5, 'execute_outreach', 'Execute Outreach Campaign'),
    stub(6, 'track_results', 'Track Results'),
  ],
  troubleshooting: [],
  relatedSops: ['entity_optimization', 'competitive_llm_monitoring'],
};

const ENTITY_OPTIMIZATION: SopDefinition = {
  key: 'entity_optimization',
  phase: 4,
  name: 'Entity Optimization',
  purpose:
    'Strengthen the brand\'s entity signals across platforms LLMs use for verification, improving overall trust and citation frequency.',
  timeRequired: '4-6 hours initial setup + quarterly maintenance',
  scope: ['After Brand Messaging Standardization', 'When Knowledge Graph presence is weak or missing'],
  prerequisites: { tools: ['Wikipedia/Wikidata editor access', 'Schema validator', 'Crunchbase admin'], access: ['All third-party platform admin'], data: ['Brand Truth', 'Existing entity signals from scanner'] },
  dependsOnSops: ['brand_messaging_standardization'],
  cadence: { intervalDays: 90, reason: 'Quarterly entity-signal review' },
  steps: [
    stub(1, 'audit_current_entity_presence', 'Audit Current Entity Presence (Wikidata, KG, schema)'),
    stub(2, 'identify_gaps', 'Identify Entity Gaps'),
    stub(3, 'create_wikidata_entry', 'Create or Update Wikidata Entry'),
    stub(4, 'enhance_schema', 'Enhance Schema Across Site'),
    stub(5, 'cross_link_platforms', 'Cross-Link Platforms (sameAs everywhere)'),
    stub(6, 'verify_kg_pickup', 'Verify Knowledge Graph Pickup'),
  ],
  troubleshooting: [],
  relatedSops: ['ai_info_page_creation', 'schema_markup_deployment'],
};

const REDDIT_BRAND_SENTIMENT_MONITORING: SopDefinition = {
  key: 'reddit_brand_sentiment_monitoring',
  phase: 4,
  name: 'Reddit Brand Sentiment Monitoring',
  purpose:
    "Systematically monitor and analyze Reddit discussions about the client's brand to understand public sentiment, identify recurring complaints, and surface high-citation-value threads.",
  timeRequired: '1-2 hours for initial scrape and analysis + 30 minutes monthly',
  scope: ['Brands with active Reddit presence', 'B2C or community-driven products'],
  prerequisites: { tools: ['Reddit scraper (RapidAPI)', 'Sentiment classifier'], access: ['Reddit API key (paid tier)'], data: ['Brand name + product names', 'Competitor names'] },
  dependsOnSops: [],
  cadence: { intervalDays: 30, reason: 'Monthly Reddit sentiment review' },
  steps: [
    stub(1, 'configure_search_terms', 'Configure Search Terms'),
    stub(2, 'scrape_recent_mentions', 'Scrape Recent Mentions'),
    stub(3, 'triage_mentions', 'Triage Mentions (open/escalate/dismiss)'),
    stub(4, 'identify_themes', 'Identify Recurring Themes'),
    stub(5, 'engage_or_escalate', 'Engage or Escalate'),
  ],
  troubleshooting: [],
  relatedSops: ['competitive_llm_monitoring'],
};

const AI_INFO_PAGE_CREATION: SopDefinition = {
  key: 'ai_info_page_creation',
  phase: 5,
  name: 'AI Info Page Creation',
  purpose:
    'Create a dedicated entity reference page (/ai-info or /llm-info) on the firm\'s website that serves as an authoritative source for LLM grounding queries.',
  timeRequired: '30-45 minutes initial creation + 15 minutes quarterly updates',
  scope: ['Every AEO client should have one', 'After Brand Messaging Standardization is approved'],
  prerequisites: { tools: ['CMS access', 'Schema validator'], access: ['CMS admin'], data: ['Approved messaging framework', 'Brand Truth'] },
  dependsOnSops: ['brand_messaging_standardization'],
  cadence: { intervalDays: 90, reason: 'Quarterly /ai-info page refresh' },
  steps: [
    stub(1, 'draft_page_structure', 'Draft Page Structure (H1 "What is [Brand]?")'),
    stub(2, 'write_canonical_definitions', 'Write Canonical Definitions Per Topic'),
    stub(3, 'add_faq_section', 'Add FAQ Section'),
    stub(4, 'implement_schema', 'Implement FAQPage + Organization Schema'),
    stub(5, 'publish_and_link', 'Publish and Link from Footer + sitemap'),
  ],
  troubleshooting: [],
  relatedSops: ['schema_markup_deployment', 'entity_optimization'],
};

const SCHEMA_MARKUP_DEPLOYMENT: SopDefinition = {
  key: 'schema_markup_deployment',
  phase: 5,
  name: 'Schema Markup Deployment',
  purpose:
    'Deploy structured data across the firm\'s website to give LLMs and search engines machine-readable signals about entities, products, and content.',
  timeRequired: '2-4 hours initial + ongoing per-page additions',
  scope: ['After Brand Messaging Standardization', 'For every published page going forward'],
  prerequisites: { tools: ['GTM or CMS', 'Schema validator'], access: ['Developer/CMS admin'], data: ['Brand Truth', 'Schema patches from entity scanner'] },
  dependsOnSops: ['entity_optimization'],
  cadence: 'one-time',
  steps: [
    stub(1, 'inventory_required_schemas', 'Inventory Required Schemas by Page Type'),
    stub(2, 'generate_schemas', 'Generate Schemas from Brand Truth'),
    stub(3, 'deploy_via_gtm_or_cms', 'Deploy via GTM or CMS'),
    stub(4, 'validate_each_page', 'Validate Each Page'),
    stub(5, 'monitor_pickup', 'Monitor Schema Pickup in GSC'),
  ],
  troubleshooting: [],
  relatedSops: ['ai_info_page_creation', 'entity_optimization'],
};

const SEMANTIC_HTML_OPTIMIZATION: SopDefinition = {
  key: 'semantic_html_optimization',
  phase: 5,
  name: 'Semantic HTML Optimization',
  purpose:
    'Ensure the firm\'s HTML uses semantic elements (article, section, nav, main, aside) that signal content hierarchy to LLM crawlers.',
  timeRequired: '1-2 hours per template',
  scope: ['When LLM crawls show poor content extraction', 'Site migration or major redesign'],
  prerequisites: { tools: ['HTML inspector', 'Lighthouse'], access: ['Theme/template editor'], data: ['Current template HTML'] },
  dependsOnSops: [],
  cadence: 'one-time',
  steps: [
    stub(1, 'audit_current_html', 'Audit Current HTML Semantics'),
    stub(2, 'identify_improvements', 'Identify Improvements'),
    stub(3, 'update_templates', 'Update Templates'),
    stub(4, 'verify_pickup', 'Verify Pickup via Crawl Test'),
  ],
  troubleshooting: [],
  relatedSops: ['schema_markup_deployment'],
};

const SME_CONTENT_GENERATION: SopDefinition = {
  key: 'sme_content_generation',
  phase: 6,
  name: 'SME Content Generation',
  purpose:
    'Scale expert-driven content production by systematically extracting Subject Matter Expert (SME) insights and creating unique content from interviews.',
  timeRequired: '2-4 hours initial setup, 30 minutes per content generation session',
  scope: ['Brands with internal SMEs', 'When original perspective is needed to differentiate'],
  prerequisites: { tools: ['Transcription tool', 'LLM with extended context'], access: ['SME availability'], data: ['Brand Truth', 'Content gaps from Deep Research audit'] },
  dependsOnSops: ['deep_research_content_audit'],
  cadence: 'one-time',
  steps: [
    stub(1, 'identify_sme', 'Identify SME and Topic'),
    stub(2, 'interview_sme', 'Interview SME (30-60 min)'),
    stub(3, 'transcribe_and_extract', 'Transcribe and Extract Insights'),
    stub(4, 'draft_content', 'Draft Content from Insights'),
    stub(5, 'sme_review', 'SME Review + Approval'),
    stub(6, 'publish', 'Publish with Author Attribution'),
  ],
  troubleshooting: [],
  relatedSops: ['llm_friendly_content_checklist', 'trust_alignment_audit'],
};

const TRUST_ALIGNMENT_AUDIT: SopDefinition = {
  key: 'trust_alignment_audit',
  phase: 6,
  name: 'Trust Alignment Audit',
  purpose:
    'Ensure content accuracy and alignment with consensus information that LLMs and Google use for verification. Validate claims and identify content that contradicts established facts.',
  timeRequired: '2-3 hours per audit',
  scope: ['Before major content launches', 'When LLM responses contradict client copy'],
  prerequisites: { tools: ['Fact-checking platforms', 'Wikipedia consensus check'], access: ['Editorial approval'], data: ['Page content to audit', 'Brand Truth claims'] },
  dependsOnSops: [],
  cadence: { intervalDays: 90, reason: 'Quarterly trust audit' },
  steps: [
    stub(1, 'extract_claims', 'Extract All Claims from Content'),
    stub(2, 'verify_claims_against_consensus', 'Verify Claims Against Consensus'),
    stub(3, 'flag_misalignments', 'Flag Misalignments'),
    stub(4, 'remediate', 'Remediate or Justify'),
    stub(5, 'document_authority_sources', 'Document Authority Sources'),
  ],
  troubleshooting: [],
  relatedSops: ['llm_friendly_content_checklist', 'sme_content_generation'],
};

const WEEKLY_AEO_REPORTING: SopDefinition = {
  key: 'weekly_aeo_reporting',
  phase: 7,
  name: 'Weekly AEO Reporting',
  purpose:
    'Demonstrate AEO value to clients or stakeholders, track progress systematically, and identify optimization opportunities through consistent weekly reporting.',
  timeRequired: '30-45 minutes per weekly report',
  scope: ['Standing requirement for every active AEO client'],
  prerequisites: { tools: ['Dashboard', 'Email delivery'], access: ['Client email list'], data: ['All scanner outputs from the week'] },
  dependsOnSops: ['brand_visibility_audit', 'ga4_llm_traffic_setup'],
  cadence: { intervalDays: 7, reason: 'Weekly client report' },
  steps: [
    stub(1, 'gather_week_data', 'Gather Week\'s Data'),
    stub(2, 'compute_deltas', 'Compute Deltas vs Last Week'),
    stub(3, 'identify_wins_and_issues', 'Identify Wins and Issues'),
    stub(4, 'draft_report', 'Draft Report'),
    stub(5, 'send_to_client', 'Send to Client'),
  ],
  troubleshooting: [],
  relatedSops: ['bi_weekly_llm_monitoring', 'aeo_audit_delivery'],
};

const AEO_DISCOVERY_CALL: SopDefinition = {
  key: 'aeo_discovery_call',
  phase: 7,
  name: 'AEO Discovery Call',
  purpose:
    'Confidently sell AEO services, qualify prospects effectively, and set clear expectations that lead to successful client engagements.',
  timeRequired: '45-60 minutes per call',
  scope: ['Every new prospect', 'Before any AEO proposal'],
  prerequisites: { tools: ['Call recording', 'Discovery questionnaire'], access: [], data: ['Prospect background research'] },
  dependsOnSops: [],
  cadence: 'one-time',
  steps: [
    stub(1, 'prep_research', 'Pre-Call Research'),
    stub(2, 'run_discovery_questions', 'Run Discovery Questions'),
    stub(3, 'demo_aeo_concept', 'Demo AEO Concept'),
    stub(4, 'qualify_fit', 'Qualify Fit'),
    stub(5, 'next_steps', 'Define Next Steps'),
  ],
  troubleshooting: [],
  relatedSops: ['aeo_audit_delivery'],
};

const AEO_AUDIT_DELIVERY: SopDefinition = {
  key: 'aeo_audit_delivery',
  phase: 7,
  name: 'AEO Audit Delivery',
  purpose:
    'Deliver the initial AEO audit findings to a new client in a structured presentation that builds confidence, surfaces priorities, and lands the engagement.',
  timeRequired: '1-2 hours per delivery + 30-minute call',
  scope: ['Initial client engagement after Brand Visibility Audit is complete'],
  prerequisites: { tools: ['Presentation tool', 'Brand Visibility Audit deliverables'], access: [], data: ['Completed Brand Visibility Audit', 'Suppression analysis if available'] },
  dependsOnSops: ['brand_visibility_audit'],
  cadence: 'one-time',
  steps: [
    stub(1, 'assemble_findings', 'Assemble Audit Findings'),
    stub(2, 'craft_narrative', 'Craft Client-Facing Narrative'),
    stub(3, 'build_slide_deck', 'Build Slide Deck'),
    stub(4, 'present_to_client', 'Present to Client'),
    stub(5, 'send_followup_doc', 'Send Follow-up Document'),
  ],
  troubleshooting: [],
  relatedSops: ['weekly_aeo_reporting', 'aeo_discovery_call'],
};

const COMPETITIVE_LLM_MONITORING: SopDefinition = {
  key: 'competitive_llm_monitoring',
  phase: 7,
  name: 'Competitive LLM Monitoring',
  purpose:
    'Stay ahead of competitive threats, identify successful strategies to emulate, and discover underserved opportunities where competitors are absent.',
  timeRequired: '1-2 hours per monitoring session',
  scope: ['Quarterly competitive review', 'When market share shifts'],
  prerequisites: { tools: ['All 5 LLMs', 'Competitor tracking spreadsheet'], access: [], data: ['Competitor roster', 'Brand Truth'] },
  dependsOnSops: ['brand_visibility_audit'],
  cadence: { intervalDays: 30, reason: 'Monthly competitive monitoring' },
  steps: [
    stub(1, 'query_per_competitor', 'Query LLMs for Each Competitor'),
    stub(2, 'compare_positioning', 'Compare Positioning vs Client'),
    stub(3, 'identify_threats', 'Identify Threats'),
    stub(4, 'identify_opportunities', 'Identify Opportunities'),
    stub(5, 'recommend_responses', 'Recommend Responses'),
  ],
  troubleshooting: [],
  relatedSops: ['comparison_page_creation', 'golden_links_opportunity_analysis'],
};

// ═══════════════════════════════════════════════════════════════
// Phase definitions + registry assembly
// ═══════════════════════════════════════════════════════════════

export const PHASES: PhaseDefinition[] = [
  {
    phase: 1,
    name: 'Brand Audit & Analysis',
    description: 'Establish baseline: how do LLMs describe the firm today, what legacy content confuses them, and what is the canonical messaging?',
    sopKeys: ['brand_visibility_audit', 'legacy_content_suppression', 'brand_messaging_standardization'],
  },
  {
    phase: 2,
    name: 'Measurement & Monitoring',
    description: 'Track AEO impact in analytics, server logs, and recurring LLM probes.',
    sopKeys: ['ga4_llm_traffic_setup', 'ai_bot_log_file_analysis', 'bi_weekly_llm_monitoring'],
  },
  {
    phase: 3,
    name: 'Content Optimization',
    description: 'Refresh and re-author content so it actually wins LLM citations.',
    sopKeys: ['deep_research_content_audit', 'comparison_page_creation', 'content_repositioning', 'llm_friendly_content_checklist', 'content_freshness_audit'],
  },
  {
    phase: 4,
    name: 'Third-Party Optimization',
    description: 'The third-party signals LLMs trust most: golden links, Wikidata/KG, Reddit.',
    sopKeys: ['golden_links_opportunity_analysis', 'entity_optimization', 'reddit_brand_sentiment_monitoring'],
  },
  {
    phase: 5,
    name: 'Technical Implementation',
    description: 'On-site infrastructure: dedicated AI info page, schema, semantic HTML.',
    sopKeys: ['ai_info_page_creation', 'schema_markup_deployment', 'semantic_html_optimization'],
  },
  {
    phase: 6,
    name: 'Content Generation',
    description: 'Net-new content from SMEs, validated against trust consensus.',
    sopKeys: ['sme_content_generation', 'trust_alignment_audit'],
  },
  {
    phase: 7,
    name: 'Client Services',
    description: 'Selling, delivering, and reporting AEO engagements.',
    sopKeys: ['weekly_aeo_reporting', 'aeo_discovery_call', 'aeo_audit_delivery', 'competitive_llm_monitoring'],
  },
];

const ALL_SOPS_LIST: SopDefinition[] = [
  // Phase 1 (fully specified)
  BRAND_VISIBILITY_AUDIT,
  LEGACY_CONTENT_SUPPRESSION,
  BRAND_MESSAGING_STANDARDIZATION,
  // Phase 2
  GA4_LLM_TRAFFIC_SETUP,
  AI_BOT_LOG_FILE_ANALYSIS,
  BI_WEEKLY_LLM_MONITORING,
  // Phase 3
  DEEP_RESEARCH_CONTENT_AUDIT,
  COMPARISON_PAGE_CREATION,
  CONTENT_REPOSITIONING,
  LLM_FRIENDLY_CONTENT_CHECKLIST,
  CONTENT_FRESHNESS_AUDIT,
  // Phase 4
  GOLDEN_LINKS_OPPORTUNITY_ANALYSIS,
  ENTITY_OPTIMIZATION,
  REDDIT_BRAND_SENTIMENT_MONITORING,
  // Phase 5
  AI_INFO_PAGE_CREATION,
  SCHEMA_MARKUP_DEPLOYMENT,
  SEMANTIC_HTML_OPTIMIZATION,
  // Phase 6
  SME_CONTENT_GENERATION,
  TRUST_ALIGNMENT_AUDIT,
  // Phase 7
  WEEKLY_AEO_REPORTING,
  AEO_DISCOVERY_CALL,
  AEO_AUDIT_DELIVERY,
  COMPETITIVE_LLM_MONITORING,
];

export const SOP_REGISTRY: Record<SopKey, SopDefinition> = Object.fromEntries(
  ALL_SOPS_LIST.map((s) => [s.key, s]),
) as Record<SopKey, SopDefinition>;

export function getSopDefinition(key: SopKey): SopDefinition {
  const def = SOP_REGISTRY[key];
  if (!def) throw new Error(`Unknown SOP key: ${key}`);
  return def;
}

export function getSopsForPhase(phase: 1 | 2 | 3 | 4 | 5 | 6 | 7): SopDefinition[] {
  const keys = PHASES.find((p) => p.phase === phase)?.sopKeys ?? [];
  return keys.map((k) => SOP_REGISTRY[k]);
}

/**
 * True if a SOP is "fully wired" — every step has a non-empty `process`
 * array. UI uses this to distinguish executable SOPs (Phase 1 today)
 * from skeleton SOPs (Phases 2-7 until Day 3).
 */
export function isSopExecutable(key: SopKey): boolean {
  const def = SOP_REGISTRY[key];
  return def.steps.every((s) => s.process.length > 0);
}
