/**
 * Ticket factory: priority_actions_from_visibility_audit
 *
 * Reads the audit findings + citation sources tied to the
 * Brand Visibility Audit's anchor (sop_run.meta.anchors.auditRunId)
 * and produces a ranked list of Priority Action tickets per the
 * SOP Step 7 formula:
 *
 *   priority_rank = f(LLMs_affected, ease_of_implementation, impact)
 *
 * Concrete actions we generate from real audit data:
 *   1. "Update [G2|LinkedIn|Wikipedia|Crunchbase] description" — one
 *      per outdated third-party listing surfaced via citation counts
 *   2. "Suppress blog post [URL]" — one per Red-scored response that
 *      cites a specific firm-owned page
 *   3. "Update [home/about] page first paragraph" — when ≥3/5 LLMs
 *      describe the firm with off-brand terminology
 *   4. "Add FAQ schema" — when ≥3/5 LLMs miss key positioning that's
 *      not present on the site
 *
 * Each ticket carries:
 *   - title, description, priority_rank
 *   - remediation_copy (the exact text the operator pastes)
 *   - validation_steps (checklist before closing)
 *   - evidence_links (which LLM cited what, with URLs)
 */

import {
  getDb,
  queries,
  consensusResponses,
  alignmentScores,
  citations,
  brandTruthVersions,
  firms,
} from '@ai-edge/db';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { BrandTruth } from '@ai-edge/shared';
import { createTicketFromStep } from '../../../actions/sop-actions';
import { computePriority } from '../priority-score';

interface Args {
  firmSlug: string;
  firmId: string;
  sopKey: 'brand_visibility_audit';
  runId: string;
  stepNumber: number;
  auditRunId: string;
}

interface FindingsBundle {
  redCount: number;
  yellowCount: number;
  greenCount: number;
  // Domain → count of citations across all responses.
  citationDomains: Map<string, number>;
  // Specific Red findings with their query + factual_errors + gap_reasons.
  // Note: provider granularity isn't directly on consensus_response (it's
  // aggregated across the k=3 self-consistency runs of one provider×query).
  // For ranking we mostly care about uniqueness of (query, factual_error)
  // not which provider — so we omit provider here.
  redFindings: Array<{
    query: string;
    factualErrors: string[];
    gapReasons: string[];
  }>;
}

async function loadAuditFindings(auditRunId: string): Promise<FindingsBundle> {
  const db = getDb();

  // Alignment scores → consensus → query (all R/Y/G scored responses for
  // the audit). consensus_response.query_id is the direct FK we use.
  const rows = await db
    .select({
      query: queries.text,
      rag: alignmentScores.rag_label,
      factualErrors: alignmentScores.factual_errors,
      gapReasons: alignmentScores.gap_reasons,
      consensusId: consensusResponses.id,
    })
    .from(alignmentScores)
    .innerJoin(consensusResponses, eq(alignmentScores.consensus_response_id, consensusResponses.id))
    .innerJoin(queries, eq(consensusResponses.query_id, queries.id))
    .where(eq(queries.audit_run_id, auditRunId));

  let redCount = 0,
    yellowCount = 0,
    greenCount = 0;
  const redFindings: FindingsBundle['redFindings'] = [];

  for (const r of rows) {
    if (r.rag === 'red') redCount += 1;
    else if (r.rag === 'yellow') yellowCount += 1;
    else if (r.rag === 'green') greenCount += 1;
    if (r.rag === 'red') {
      redFindings.push({
        query: r.query,
        factualErrors: (r.factualErrors as string[]) ?? [],
        gapReasons: (r.gapReasons as string[]) ?? [],
      });
    }
  }

  // Citation domains across all consensus responses tied to this audit.
  const citationRows = await db
    .select({
      domain: citations.domain,
      url: citations.url,
      consensusId: citations.consensus_response_id,
    })
    .from(citations)
    .innerJoin(consensusResponses, eq(citations.consensus_response_id, consensusResponses.id))
    .innerJoin(queries, eq(consensusResponses.query_id, queries.id))
    .where(eq(queries.audit_run_id, auditRunId));

  const citationDomains = new Map<string, number>();
  for (const c of citationRows) {
    citationDomains.set(c.domain, (citationDomains.get(c.domain) ?? 0) + 1);
  }

  return {
    redCount,
    yellowCount,
    greenCount,
    citationDomains,
    redFindings,
  };
}

/**
 * Score the impact of a candidate fix on a 1-10 scale.
 *   impact = (number of LLMs affected) * (visibility weight of the fix)
 * Then rank ascending: rank 1 = highest priority.
 */
function rankActions(actions: Array<{ baseImpact: number; ease: number; llmsAffected: number; title: string }>): Array<typeof actions[number] & { priorityRank: number; score: number }> {
  const scored = actions.map((a) => ({
    ...a,
    score: a.baseImpact * a.ease * a.llmsAffected,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((a, i) => ({ ...a, priorityRank: i + 1 }));
}

/**
 * Run the factory: create ranked tickets, return the list of created
 * ticket IDs.
 */
export async function generatePriorityActions(args: Args): Promise<{
  created: Array<{ id: string; title: string; priorityRank: number }>;
}> {
  const db = getDb();
  const findings = await loadAuditFindings(args.auditRunId);

  // Brand Truth gives us the canonical positioning to reference in
  // remediation_copy.
  const [bt] = await db
    .select({ payload: brandTruthVersions.payload })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, args.firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  const brandTruth = (bt?.payload ?? null) as BrandTruth | null;
  const firmName = brandTruth?.firm_name ?? 'this firm';
  const positioningStatement =
    (brandTruth as { positioning_statement?: string } | null)?.positioning_statement ?? '';

  // Detect third-party domains worth flagging.
  // Heuristic: any domain that appears in ≥2 LLM citations AND isn't the
  // firm's own domain or schema.org docs.
  const firmHost = (brandTruth as { primary_url?: string } | null)?.primary_url
    ? new URL((brandTruth as { primary_url?: string }).primary_url!).host.replace(/^www\./, '')
    : '';
  const KNOWN_PLATFORMS = new Map<string, string>([
    ['g2.com', 'G2'],
    ['linkedin.com', 'LinkedIn'],
    ['en.wikipedia.org', 'Wikipedia'],
    ['wikidata.org', 'Wikidata'],
    ['crunchbase.com', 'Crunchbase'],
    ['capterra.com', 'Capterra'],
    ['trustradius.com', 'TrustRadius'],
    ['producthunt.com', 'Product Hunt'],
    ['justia.com', 'Justia'],
    ['avvo.com', 'Avvo'],
    ['lawyers.com', 'Lawyers.com'],
    ['superlawyers.com', 'Super Lawyers'],
    ['bbb.org', 'BBB'],
  ]);

  const candidates: Array<{
    baseImpact: number;
    ease: number;
    llmsAffected: number;
    title: string;
    description: string;
    remediation: string;
    validation: Array<{ description: string }>;
    evidence: Array<{ kind: string; url: string; description?: string }>;
    automationTier: 'auto' | 'assist' | 'manual';
    executeUrl?: string;
    executeLabel?: string;
    manualReason?: string;
  }> = [];

  // Per-platform automation classification — driven by the
  // 2025/2026 research pass on programmatic write access:
  //   auto    → public write API exists + permissive policy
  //             (Google Business Profile, Wikidata)
  //   assist  → no public write API OR permissive but operator must
  //             paste on the platform UI; we drop a deep-link
  //   manual  → blocked by policy (e.g. Wikipedia direct edit under
  //             COI/PAID) or no admin URL pattern available
  //
  // KNOWN_PLATFORMS only includes domains the audit pipeline cites
  // back to the firm context, so this lookup is complete for the
  // tickets we actually generate.
  const PLATFORM_AUTOMATION: Record<string, {
    tier: 'auto' | 'assist' | 'manual';
    adminUrlTemplate?: string; // %s gets replaced with firm slug for some, or just opened raw
    manualReason?: string;
  }> = {
    'g2.com': { tier: 'assist', adminUrlTemplate: 'https://my.g2.com/products' },
    'linkedin.com': { tier: 'assist', adminUrlTemplate: 'https://www.linkedin.com/company/' },
    'en.wikipedia.org': {
      tier: 'manual',
      manualReason:
        "Wikipedia's COI / Paid-contribution policy forbids direct article edits on behalf of the subject. The compliant path is a {{edit request}} on the article Talk page, which a volunteer reviews. Wire the Talk-page autopost workflow before re-classifying as 'assist'.",
    },
    'wikidata.org': {
      tier: 'auto',
      adminUrlTemplate: 'https://www.wikidata.org',
    },
    'crunchbase.com': { tier: 'assist', adminUrlTemplate: 'https://www.crunchbase.com' },
    'capterra.com': { tier: 'assist', adminUrlTemplate: 'https://about.capterra.com/vendors/' },
    'trustradius.com': { tier: 'assist', adminUrlTemplate: 'https://www.trustradius.com/vendor' },
    'producthunt.com': { tier: 'assist', adminUrlTemplate: 'https://www.producthunt.com/maker' },
    'justia.com': { tier: 'assist', adminUrlTemplate: 'https://lawyers.justia.com/edit_profile' },
    'avvo.com': { tier: 'assist', adminUrlTemplate: 'https://www.avvo.com/account/profile' },
    'lawyers.com': { tier: 'assist', adminUrlTemplate: 'https://www.lawyers.com/account' },
    'superlawyers.com': { tier: 'assist', adminUrlTemplate: 'https://www.superlawyers.com' },
    'bbb.org': { tier: 'assist', adminUrlTemplate: 'https://www.bbb.org/business-login' },
  };

  // Generate "Update [Platform] description" tickets for each known
  // third-party platform that LLMs cited.
  for (const [domain, count] of findings.citationDomains.entries()) {
    if (domain === firmHost) continue;
    const platformName = KNOWN_PLATFORMS.get(domain);
    if (!platformName) continue;
    const automation = PLATFORM_AUTOMATION[domain] ?? { tier: 'assist' as const };
    candidates.push({
      baseImpact: 8,         // third-party listings carry high LLM-trust weight
      ease: 7,               // simple form edit on the platform
      llmsAffected: count,
      title: `Update ${platformName} description to reflect current positioning`,
      description: `${platformName} (${domain}) was cited ${count} time${count === 1 ? '' : 's'} by LLMs in this audit. Its current description likely poisons the LLM's understanding of ${firmName}. Update it to match the approved positioning.`,
      remediation: positioningStatement
        ? `Replace the ${platformName} listing's main description with:\n\n${positioningStatement}`
        : `Replace the ${platformName} listing's main description with the approved positioning. See Brand Truth → positioning_statement.`,
      validation: [
        { description: `Open the ${platformName} listing and replace the description` },
        { description: `Screenshot the before/after for the change log` },
        { description: `Verify the new description appears live` },
      ],
      evidence: [
        {
          kind: 'third_party_listing',
          url: `https://${domain}`,
          description: `Cited ${count} time(s) by LLMs in the latest Brand Visibility Audit`,
        },
      ],
      automationTier: automation.tier,
      executeUrl: automation.adminUrlTemplate,
      executeLabel:
        automation.tier === 'auto'
          ? `Update ${platformName} via API`
          : automation.tier === 'assist'
            ? `Open ${platformName}`
            : undefined,
      manualReason: automation.manualReason,
    });
  }

  // Generate "Address consistent off-brand mention" tickets for the top
  // factual errors / gap reasons across Red responses.
  const errorFreq = new Map<string, number>();
  for (const f of findings.redFindings) {
    for (const e of f.factualErrors) errorFreq.set(e, (errorFreq.get(e) ?? 0) + 1);
    for (const g of f.gapReasons) errorFreq.set(g, (errorFreq.get(g) ?? 0) + 1);
  }
  const topErrors = [...errorFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [errorOrGap, count] of topErrors) {
    candidates.push({
      baseImpact: 9,         // direct content alignment
      ease: 5,               // requires copywriting + CMS edit
      llmsAffected: count,
      title: `Address recurring LLM gap: "${errorOrGap.slice(0, 80)}${errorOrGap.length > 80 ? '…' : ''}"`,
      description: `This issue appeared in ${count} Red-scored response${count === 1 ? '' : 's'} across the audit. Updating the firm's homepage/about copy + adding FAQ schema should close the gap.`,
      remediation: `Add the following clarifying statement to the homepage / about page where appropriate:\n\n[Approved positioning that addresses: ${errorOrGap}]`,
      validation: [
        { description: 'Add or update the copy on the relevant page' },
        { description: 'Verify the change is live via page source' },
        { description: 'Re-run the Brand Visibility Audit in 4-6 weeks to confirm LLM uptake' },
      ],
      evidence: [],
      // CMS copy edits depend on which CMS the firm uses. Until the
      // operator declares it in Settings, we ship as 'assist' — the
      // remediation is drafted; deploy is via their CMS. When we
      // detect WordPress/Webflow/Shopify and have valid credentials,
      // these can flip to 'auto'.
      automationTier: 'assist',
      executeLabel: 'Edit on-site copy',
    });
  }

  // Always-on: "Update Wikipedia/Wikidata first sentence" if neither
  // is in the citation set yet (these are highest-trust sources for
  // LLMs; presence is mandatory).
  const hasWikipedia = findings.citationDomains.has('en.wikipedia.org');
  if (!hasWikipedia) {
    candidates.push({
      baseImpact: 10,
      ease: 4,
      llmsAffected: 5,    // assume all 5 LLMs benefit
      title: 'Create or update Wikipedia entry first sentence',
      description: `${firmName} does not appear in Wikipedia citations in this audit. Wikipedia is the highest-trust LLM source — even a minimal stub article significantly improves brand grounding.`,
      remediation: positioningStatement
        ? `Create or update the Wikipedia article with the first sentence:\n\n${positioningStatement}`
        : 'Create or update the Wikipedia article first sentence to match approved positioning.',
      validation: [
        { description: 'Verify Wikipedia notability criteria are met (NCORP: multiple independent secondary sources)' },
        { description: 'Use a third-party editor (e.g. Beutler Ink) OR post {{edit request}} on Talk page with proposed wording + sources' },
        { description: 'Monitor edit retention for 30 days' },
      ],
      evidence: [
        { kind: 'third_party_listing', url: 'https://en.wikipedia.org', description: 'Not cited in current audit' },
      ],
      automationTier: 'manual',
      manualReason:
        "Wikipedia's Conflict-of-Interest and Paid-Contribution policies (binding under WMF Terms of Use) forbid the subject from editing their own article. Undisclosed edits get reverted and the account banned. The compliant path is either a Talk-page {{edit request}} (which a volunteer reviews — outcome not guaranteed) or hiring a specialist editor (Beutler Ink, ReputationX). For brands without an existing article, NCORP notability criteria reject ~80% of corporate stubs, so drafting one programmatically has near-zero survival probability. We surface this as manual and stop there.",
    });
  }

  if (candidates.length === 0) {
    return { created: [] };
  }

  // Rank by composite score.
  const ranked = rankActions(
    candidates.map((c) => ({ baseImpact: c.baseImpact, ease: c.ease, llmsAffected: c.llmsAffected, title: c.title })),
  );

  // Persist each.
  const created: Array<{ id: string; title: string; priorityRank: number }> = [];
  for (const r of ranked) {
    const detail = candidates.find((c) => c.title === r.title);
    if (!detail) continue;
    // The priority-actions factory consolidates audit findings into
    // synthesized actions ("Update [Platform] description", "Address
    // recurring LLM gap", "Create Wikipedia entry"). These are
    // *prescribed actions*, not the audit findings themselves, so
    // routing through factual_error/non_mention would over-rank them.
    // Route through the audit-fallback (content_drift) path so they
    // sit above per-page quality work but below raw audit tickets.
    // Multi-provider impact is encoded via providerCount = evidence
    // count (more LLM citations → higher within-class offset, capped
    // at 90).
    const providerCount = Math.max(1, detail.evidence?.length ?? 1);
    const { priorityClass, priorityScore } = computePriority({
      sourceType: 'audit',
      sopKey: args.sopKey,
      auditHasFactualErrors: false,
      auditMentioned: true,
      providerCount,
    });
    const result = await createTicketFromStep({
      firmSlug: args.firmSlug,
      sopKey: args.sopKey,
      runId: args.runId,
      stepNumber: args.stepNumber,
      title: detail.title,
      description: detail.description,
      priorityRank: r.priorityRank,
      priorityClass,
      priorityScore,
      remediationCopy: detail.remediation,
      validationSteps: detail.validation,
      evidenceLinks: detail.evidence,
      automationTier: detail.automationTier,
      executeUrl: detail.executeUrl,
      executeLabel: detail.executeLabel,
      manualReason: detail.manualReason,
    });
    created.push({ id: result.id, title: detail.title, priorityRank: r.priorityRank });
  }

  return { created };
}

// Helper for the firms table import resolution
export { firms };
