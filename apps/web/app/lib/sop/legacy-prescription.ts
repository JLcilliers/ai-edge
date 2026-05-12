/**
 * Prescription helpers for the four legacy scanner paths (audit /
 * suppression / entity / reddit). Each one derives the prescription-
 * layer fields (title, description, remediation_copy, automation_tier,
 * execute_url, evidence_links, validation_steps, priority_rank) from
 * the backing source row, so the ticket the operator sees actually
 * tells them what happened and what to do.
 *
 * Why this module exists separately:
 *   - The four legacy paths (run-audit.ts, suppression/scan.ts,
 *     entity/scan.ts, entity/cross-source-scan.ts, reddit/scan.ts)
 *     each insert tickets directly with no prescription. They have
 *     the source data in scope but were never wired to write it.
 *   - The backfill script
 *     (apps/web/scripts/backfill-legacy-ticket-prescription.ts) needs
 *     the same composition logic to retroactively populate the
 *     existing rows.
 *
 * Pulling the composition into pure functions means both consumers
 * call the same code path. Future scanner changes to ticket shape
 * happen in one place.
 *
 * All helpers return a partial-ticket payload ready to merge into the
 * `db.insert(remediationTickets).values({ ... })` or
 * `db.update(remediationTickets).set({ ... })` call.
 */

export interface TicketPrescription {
  title: string;
  description: string;
  priorityRank: number | null;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
  evidenceLinks: Array<{ kind: 'llm_citation' | 'page_url' | 'third_party_listing' | 'aio_source' | 'reddit_thread'; url: string; description?: string }>;
  automationTier: 'auto' | 'assist' | 'manual';
  executeUrl?: string;
  executeLabel?: string;
  manualReason?: string;
}

// ── Audit (run-audit.ts) ─────────────────────────────────────
// Source: alignment_score → consensus_response → query.
// The Red-rated rows are the operator-actionable issues — LLMs are
// either missing the firm entirely or actively misrepresenting them.

interface AuditPrescriptionInput {
  queryText: string;
  provider: string;
  ragLabel: 'red' | 'yellow' | 'green';
  gapReasons: string[] | null | undefined;
  factualErrors: string[] | null | undefined;
  citations: string[] | null | undefined;
  mentioned: boolean;
}

export function prescribeAuditTicket(input: AuditPrescriptionInput): TicketPrescription {
  const gapReasons = (input.gapReasons ?? []).filter((g) => typeof g === 'string' && g.trim());
  const factualErrors = (input.factualErrors ?? []).filter((e) => typeof e === 'string' && e.trim());
  const citations = (input.citations ?? []).filter((c) => typeof c === 'string' && c.startsWith('http'));

  // Factual errors are the higher-severity class — an LLM stating the
  // wrong bar number / wrong address / wrong specialty is worse than
  // an LLM with a generic tone-mismatch. Surface them in the title
  // when present.
  const hasErrors = factualErrors.length > 0;
  const titlePrefix = !input.mentioned
    ? 'LLM didn\'t mention firm'
    : hasErrors
      ? `LLM stated incorrect facts about firm`
      : `LLM positioning off-brand`;
  const title = `${titlePrefix}: "${truncate(input.queryText, 80)}" (${input.provider})`;

  const descLines: string[] = [];
  descLines.push(`Query: "${input.queryText}"`);
  descLines.push(`Provider: ${input.provider}`);
  descLines.push(`Alignment: ${input.ragLabel.toUpperCase()} — ${input.mentioned ? 'firm was mentioned' : 'firm was NOT mentioned'}`);
  if (factualErrors.length > 0) {
    descLines.push('');
    descLines.push('Factual errors the LLM made:');
    for (const e of factualErrors) descLines.push(`- ${e}`);
  }
  if (gapReasons.length > 0) {
    descLines.push('');
    descLines.push('Positioning gaps:');
    for (const g of gapReasons) descLines.push(`- ${g}`);
  }

  // Remediation copy: structured fix list specific to the failure shape.
  const remediationParts: string[] = [];
  remediationParts.push(`**Query:** "${input.queryText}"`);
  remediationParts.push(`**Provider:** ${input.provider}`);
  remediationParts.push('');
  if (factualErrors.length > 0) {
    remediationParts.push('**Factual corrections needed:**');
    for (const e of factualErrors) remediationParts.push(`- ${e}`);
    remediationParts.push('');
    remediationParts.push('**Action — fix the source.** LLMs invent facts when on-site facts are absent or contradictory. For each factual error:');
    remediationParts.push('1. Verify the correct value (cite an authoritative source — bar lookup, Wikidata, official page).');
    remediationParts.push('2. Update Brand Truth to carry the canonical value.');
    remediationParts.push('3. Surface that fact on the firm\'s homepage / About page / `/ai-info` page in the firm\'s own copy.');
    remediationParts.push('4. Re-run the audit after 2-4 weeks; confirm the LLM now states the correct value.');
  }
  if (gapReasons.length > 0) {
    remediationParts.push('');
    remediationParts.push('**Positioning corrections:**');
    for (const g of gapReasons) remediationParts.push(`- ${g}`);
    remediationParts.push('');
    remediationParts.push('**Action — strengthen Brand Truth + propagate.** For each gap:');
    remediationParts.push('1. Confirm the missing positioning element is in Brand Truth (differentiators, required positioning phrases, banned claims).');
    remediationParts.push('2. Edit top-trafficked pages (homepage, About, top-3 service pages) to use the Brand Truth phrasing verbatim.');
    remediationParts.push('3. Re-run the LLM-Friendly Content Checklist scan to confirm pages now meet the rubric.');
  }
  if (citations.length > 0) {
    remediationParts.push('');
    remediationParts.push('**Where the LLM sourced its info:**');
    for (const c of citations.slice(0, 5)) remediationParts.push(`- ${c}`);
    remediationParts.push('');
    remediationParts.push('Pages the LLM is reading FROM matter most. If a wrong-info page is in this list, it\'s an Entity Optimization (third-party) or Suppression (own-site) ticket — fix the source.');
  }
  if (!input.mentioned) {
    remediationParts.push('');
    remediationParts.push('**Non-mention is the bigger issue.** The firm wasn\'t referenced at all for this query. Likely causes: weak entity signals (no Wikidata / no schema.org Organization), thin content on this query\'s topic, or competitor-dominated SERP. Run Phase 4 entity scan + Phase 3 LLM-Friendly scan to triangulate.');
  }
  const remediationCopy = remediationParts.join('\n');

  const validationSteps: Array<{ description: string }> = [];
  if (factualErrors.length > 0) validationSteps.push({ description: 'Verify + correct each factual error in Brand Truth' });
  if (gapReasons.length > 0) validationSteps.push({ description: 'Update Brand Truth + propagate positioning to top pages' });
  validationSteps.push({ description: 'Re-run the full Brand Visibility Audit after 2-4 weeks' });
  validationSteps.push({ description: 'Confirm this query no longer scores Red' });

  const evidenceLinks: TicketPrescription['evidenceLinks'] = citations
    .slice(0, 10)
    .map((url) => ({ kind: 'llm_citation' as const, url, description: input.provider }));

  return {
    title,
    description: descLines.join('\n'),
    priorityRank: hasErrors ? 1 : !input.mentioned ? 2 : 3,
    remediationCopy,
    validationSteps,
    evidenceLinks,
    automationTier: 'assist',
    // For audit tickets there isn't a single executeUrl — the operator
    // works in Brand Truth + multiple pages. Leave undefined; the UI
    // falls back to the SOP detail page.
    executeUrl: undefined,
    executeLabel: undefined,
  };
}

// ── Legacy / Suppression (suppression/scan.ts) ───────────────
// Source: legacy_finding → page.

interface LegacyPrescriptionInput {
  pageUrl: string;
  pageTitle: string | null;
  wordCount: number | null;
  action: 'delete' | 'redirect' | 'noindex' | 'keep' | 'rewrite' | string;
  rationale: string;
  semanticDistance: number;
}

export function prescribeLegacyTicket(input: LegacyPrescriptionInput): TicketPrescription {
  const action = input.action.toLowerCase();
  const titleText = input.pageTitle?.trim() || input.pageUrl;
  const actionLabel = action[0]!.toUpperCase() + action.slice(1);
  const title = `${actionLabel} ${truncate(titleText, 80)}`;

  const description =
    `${input.rationale}\n\n` +
    `URL: ${input.pageUrl}\n` +
    `Semantic distance from Brand Truth: ${input.semanticDistance.toFixed(3)}\n` +
    `Word count: ${input.wordCount ?? 'unknown'}`;

  const remediationByAction: Record<string, string> = {
    delete: `**Action:** Delete \`${input.pageUrl}\`.\n\n1. Back up the page content first (export HTML, save in archive folder).\n2. Set the page to draft / trash in CMS.\n3. After 2-4 weeks of monitoring, permanently delete.\n4. Verify the URL returns 404 (not 500).\n5. Optionally submit URL removal in GSC → Removals.`,
    redirect: `**Action:** Create a 301 redirect from \`${input.pageUrl}\` to the closest aligned page.\n\n1. Identify the target page that best covers this topic under current Brand Truth.\n2. Add the redirect (CMS / .htaccess / Cloudflare Page Rules).\n3. Verify the redirect returns 301 (not 302).\n4. Update internal links pointing at the old URL.\n5. Submit the change in GSC.`,
    noindex: `**Action:** Add \`noindex\` meta tag to \`${input.pageUrl}\`.\n\n1. Edit the page in CMS.\n2. Add the meta tag (Yoast / RankMath / manual \`<meta name="robots" content="noindex">\`).\n3. Verify via View Source.\n4. Leave page in sitemap so internal crawl still works.`,
    rewrite: `**Action:** Rewrite \`${input.pageUrl}\` to align with current Brand Truth.\n\n1. Audit current copy against Brand Truth (\`primary_url\`, \`required_positioning_phrases\`, \`unique_differentiators\`, \`banned_claims\`).\n2. Rewrite intro + H1 + meta description.\n3. Restructure body for AEO (scannable headings, citable facts, required positioning phrases verbatim).\n4. Update schema markup.\n5. Publish + verify in browser.\n6. Re-run LLM-Friendly Content Checklist scan; confirm score ≥ 5/7.`,
    keep: `**Action:** Page has high traffic (≥50 clicks/mo). This is a Content Repositioning candidate, not a suppression target — move to the Repositioning workflow under Phase 3.`,
  };

  const remediationCopy =
    `**Page:** ${input.pageUrl}\n\n**Distance:** ${input.semanticDistance.toFixed(3)} (above 0.40 rewrite threshold)\n\n${remediationByAction[action] ?? `**Action:** Operator decision required for unhandled action \`${action}\`.`}`;

  const validationSteps: Array<{ description: string }> = [
    { description: `Apply the ${actionLabel.toLowerCase()} action in CMS` },
    { description: 'Verify the change (status code, meta tag, redirect target)' },
    { description: 'Update internal links if redirected / deleted' },
    { description: 'Re-run Suppression scan to confirm the page is cleared' },
  ];

  return {
    title,
    description,
    priorityRank: null,
    remediationCopy,
    validationSteps,
    evidenceLinks: [{ kind: 'page_url', url: input.pageUrl, description: `${input.semanticDistance.toFixed(2)} distance` }],
    automationTier: 'assist',
    executeUrl: input.pageUrl,
    executeLabel: 'Open page',
  };
}

// ── Entity (entity/scan.ts + entity/cross-source-scan.ts) ────
// Source: entity_signal → divergence_flags + playbook_step.

interface EntityPrescriptionInput {
  source: string;
  url: string | null;
  divergenceFlags: string[];
  /**
   * The playbook_step string the scanner originally set.
   * Examples: 'entity:google-kg:claim', 'entity:wikidata:create',
   *           'entity:schema:Person',
   *           'entity:cross-source:divergent:superlawyers'.
   * Parsed by parseEntityPlaybookStep below.
   */
  playbookStep: string;
}

interface EntityActionShape {
  kind: 'wikidata-create' | 'wikidata-update' | 'google-kg-claim' | 'schema-add' | 'cross-source-divergent' | 'cross-source-unverified' | 'unknown';
  detail: string;
}

function parseEntityPlaybookStep(step: string): EntityActionShape {
  if (step.startsWith('entity:wikidata:create')) return { kind: 'wikidata-create', detail: 'Create a Wikidata entry for the firm.' };
  if (step.startsWith('entity:wikidata:update')) return { kind: 'wikidata-update', detail: 'Update Wikidata entry to match Brand Truth.' };
  if (step.startsWith('entity:google-kg:claim')) return { kind: 'google-kg-claim', detail: 'Claim the Google Knowledge Panel.' };
  if (step.startsWith('entity:schema:')) {
    const type = step.replace('entity:schema:', '');
    return { kind: 'schema-add', detail: `Add \`@type=${type}\` JSON-LD schema to the firm site.` };
  }
  if (step.includes('cross-source:divergent')) return { kind: 'cross-source-divergent', detail: 'Third-party listing diverges from Brand Truth.' };
  if (step.includes('badge-unverified')) return { kind: 'cross-source-unverified', detail: 'Award is in Brand Truth but absent from the issuer\'s page.' };
  return { kind: 'unknown', detail: step };
}

const PLATFORM_ADMIN_URLS: Record<string, string> = {
  bbb: 'https://www.bbb.org/get-listed',
  superlawyers: 'https://www.superlawyers.com/contact',
  avvo: 'https://support.avvo.com/hc/en-us/categories/4407466091789-Manage-Your-Profile',
  justia: 'https://www.justia.com/lawyers/',
  lawyers_com: 'https://www.lawyers.com/profile-claim',
  martindale: 'https://www.martindale.com/profile-claim',
  healthgrades: 'https://www.healthgrades.com/dms/jss/jsi',
  zocdoc: 'https://www.zocdoc.com/professionals',
  yelp: 'https://biz.yelp.com',
  clutch: 'https://clutch.co/profile/edit',
  g2: 'https://my.g2.com',
  gbp: 'https://business.google.com',
  wikidata: 'https://www.wikidata.org/wiki/Wikidata:Main_Page',
};

export function prescribeEntityTicket(input: EntityPrescriptionInput): TicketPrescription {
  const action = parseEntityPlaybookStep(input.playbookStep);
  const flags = input.divergenceFlags.slice(0, 6);

  const title = (() => {
    switch (action.kind) {
      case 'wikidata-create':
        return 'Create Wikidata entry for the firm';
      case 'wikidata-update':
        return 'Update Wikidata entry to match Brand Truth';
      case 'google-kg-claim':
        return 'Claim Google Knowledge Panel';
      case 'schema-add':
        return action.detail;
      case 'cross-source-divergent':
        return `${input.source} listing drifts from Brand Truth`;
      case 'cross-source-unverified':
        return `Award unverified on ${input.source}`;
      default:
        return `Entity action: ${input.playbookStep}`;
    }
  })();

  const description =
    `${action.detail}\n\n` +
    `Source: ${input.source}\n` +
    `URL: ${input.url ?? '(no URL on signal)'}\n` +
    (flags.length > 0 ? `Divergence flags: ${flags.join(', ')}\n` : '');

  const adminUrl = PLATFORM_ADMIN_URLS[input.source.toLowerCase()] ?? input.url ?? undefined;

  const remediationParts: string[] = [];
  remediationParts.push(`**Source:** ${input.source}`);
  if (input.url) remediationParts.push(`**Profile:** ${input.url}`);
  remediationParts.push('');
  remediationParts.push(`**Action:** ${action.detail}`);
  remediationParts.push('');
  if (action.kind === 'cross-source-divergent' || action.kind === 'cross-source-unverified') {
    remediationParts.push('**Resolve:**');
    remediationParts.push('1. Open the platform admin and review the live listing.');
    remediationParts.push('2. Compare to current Brand Truth (firm name, NAP, primary description, primary URL).');
    remediationParts.push('3. Update divergent fields via the platform\'s own form.');
    remediationParts.push('4. Re-run the cross-source scan to confirm the flag clears.');
  } else if (action.kind === 'wikidata-create' || action.kind === 'wikidata-update') {
    remediationParts.push('**Resolve via Wikidata:**');
    remediationParts.push('1. Sign in to wikidata.org with a Wikipedia account.');
    remediationParts.push('2. Create or edit the firm\'s Q-item.');
    remediationParts.push('3. Add core statements: instance of (Q...), industry (Q...), location, founded date, website.');
    remediationParts.push('4. Cite each claim against an authoritative source (firm website, press, public records).');
    remediationParts.push('5. Re-run the entity scan; the wikidata flag should clear within 24h after the bot indexing pass.');
  } else if (action.kind === 'google-kg-claim') {
    remediationParts.push('**Resolve via Google Knowledge Panel:**');
    remediationParts.push('1. Sign in to a Google account that owns the firm\'s GBP listing.');
    remediationParts.push('2. Search the firm name in Google → click "Claim this knowledge panel".');
    remediationParts.push('3. Verify ownership via the prompted method (email/phone/admin).');
    remediationParts.push('4. Update the panel content (description, founded date, products/services).');
  } else if (action.kind === 'schema-add') {
    remediationParts.push('**Resolve via schema markup:**');
    remediationParts.push(`1. Add the missing schema block to the firm site (Phase 5 Schema Markup Deployment scanner has the boilerplate).`);
    remediationParts.push('2. Validate at https://search.google.com/test/rich-results.');
    remediationParts.push('3. Re-run the entity scan to confirm the schema is detected.');
  }

  const validationSteps: Array<{ description: string }> = [
    { description: 'Take the action above on the relevant platform / page' },
    { description: 'Verify the change is live + visible to crawlers' },
    { description: 'Re-run entity scan; confirm divergence_flag clears' },
  ];

  return {
    title,
    description,
    priorityRank: null,
    remediationCopy: remediationParts.join('\n'),
    validationSteps,
    evidenceLinks: input.url ? [{ kind: 'third_party_listing', url: input.url, description: input.source }] : [],
    automationTier: 'assist',
    executeUrl: adminUrl,
    executeLabel: adminUrl ? `Open ${input.source}` : undefined,
  };
}

// ── Reddit (reddit/scan.ts) ──────────────────────────────────
// Source: reddit_mention row.

interface RedditPrescriptionInput {
  subreddit: string;
  threadUrl: string;
  karma: number | null;
  sentiment: string | null;
  text: string | null;
  postedAt: Date | null;
}

export function prescribeRedditTicket(input: RedditPrescriptionInput): TicketPrescription {
  const karmaLabel = input.karma != null ? ` (${input.karma} karma)` : '';
  const snippet = input.text && input.text.length > 200 ? `${input.text.slice(0, 200)}…` : input.text ?? '';
  const title = `Reddit complaint on r/${input.subreddit}${karmaLabel}`;

  const description =
    `A complaint-classified Reddit mention surfaced. Review and decide: engage, escalate, or dismiss.\n\n` +
    `Thread: ${input.threadUrl}\n` +
    `Subreddit: r/${input.subreddit}\n` +
    `Karma: ${input.karma ?? 'unknown'}\n` +
    `Sentiment: ${input.sentiment ?? 'unknown'}\n` +
    `Posted: ${input.postedAt?.toISOString() ?? 'unknown'}\n` +
    `Excerpt: ${snippet || '(empty selftext)'}`;

  const remediationCopy = `**Thread:** ${input.threadUrl}\n\n**Decision tree:**\n\n1. **Engage** — reply to the thread if the complaint can be resolved publicly (refund, follow-up, clarification). Use the firm's verified Reddit account, never a sock-puppet.\n2. **Escalate** — forward to support/legal if the complaint involves a real customer issue needing internal action.\n3. **Dismiss** — if the mention is off-brand (wrong firm with similar name, satire, irrelevant), update triage status in the Reddit dashboard.\n\nMark the triage status in the Reddit dashboard once handled. Open complaints leaking to LLMs influence the firm's overall sentiment surface.`;

  return {
    title,
    description,
    priorityRank: null,
    remediationCopy,
    validationSteps: [
      { description: 'Read the thread and surrounding context' },
      { description: 'Choose: engage / escalate / dismiss' },
      { description: 'Update triage status in the Reddit dashboard' },
    ],
    evidenceLinks: [{ kind: 'reddit_thread', url: input.threadUrl, description: `r/${input.subreddit}` }],
    automationTier: 'assist',
    executeUrl: input.threadUrl,
    executeLabel: 'Open thread',
  };
}

// ── helpers ──────────────────────────────────────────────────
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
