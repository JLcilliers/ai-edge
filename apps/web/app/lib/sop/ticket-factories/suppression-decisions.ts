/**
 * Ticket factory: suppression_decisions_to_tickets
 *
 * Reads the decisions produced by buildSuppressionArtifacts (cached on
 * the SOP run via the deliverables) and emits one ticket per page that
 * requires implementation work (Delete / 301 / No-Index).
 *
 * The "Keep + update" pages get an Action Item too, but flagged as
 * "Content refresh" instead of suppression — these are the ones that
 * benefit from Content Repositioning SOP (Phase 3) rather than this
 * SOP.
 *
 * Each ticket carries the concrete remediation copy (exactly how to
 * implement: CMS path, redirect map entry, noindex meta tag).
 */

import { createTicketFromStep } from '../../../actions/sop-actions';
import { buildSuppressionArtifacts } from '../deliverables/suppression-artifacts';
import { computePriority } from '../priority-score';

interface Args {
  firmSlug: string;
  firmId: string;
  firmName: string;
  primaryUrl: string | null;
  sopKey: 'legacy_content_suppression';
  runId: string;
  stepNumber: number;
}

const PRIORITY: Record<string, number> = {
  delete: 1,    // High-impact wins first
  redirect: 2,  // Medium effort
  noindex: 3,   // Low risk, do early
  keep: 4,      // Out of scope for this SOP
};

const REMEDIATION_COPY: Record<string, (url: string, target?: string | null) => string> = {
  delete: (url) => `**Action:** Delete the page at \`${url}\`.

1. Back up the page content first (export HTML, save in archive folder)
2. Set the page to draft / trash in CMS
3. After 2-4 weeks of monitoring (Phase C), permanently delete
4. Verify the URL returns 404 (not 500)
5. Optionally submit URL removal in GSC → Removals`,

  redirect: (url, target) => `**Action:** Create a 301 redirect from \`${url}\` to \`${target ?? '[OPERATOR TO ASSIGN]'}\`.

1. Verify the target page exists and reflects current Brand Truth
2. Add the redirect via your chosen method:
   - WordPress: Redirection plugin → Source URL → Target URL → Type: 301
   - htaccess: \`Redirect 301 ${new URL(url).pathname} ${target ?? '/'}\`
   - Cloudflare: Rules → Page Rules → Forwarding URL (301)
3. Test by visiting the source URL — should redirect to target
4. Check status code is 301 (not 302 / 307)
5. Update internal links pointing to the old URL`,

  noindex: (url) => `**Action:** Add \`noindex\` meta tag to \`${url}\`.

1. Edit the page in CMS
2. Add the meta tag (method varies):
   - Yoast: Advanced → Meta Robots Index → "No"
   - RankMath: Advanced → Robots Meta → uncheck Index
   - Webflow: Page Settings → SEO → uncheck "Allow indexing"
   - Manual: \`<meta name="robots" content="noindex">\` in \`<head>\`
3. Verify via View Source — should see the noindex tag
4. Leave page in sitemap (so internal crawl still works) but de-index from search`,

  keep: (url) => `**Action:** Page \`${url}\` has high traffic (≥50 clicks/mo). This is a Content Repositioning candidate, not a suppression target.

1. Move to the Content Repositioning SOP (Phase 3)
2. Plan a content refresh to update with current Brand Truth positioning
3. Do NOT suppress`,
};

export async function generateSuppressionTickets(args: Args): Promise<{
  created: Array<{ id: string; title: string; priorityRank: number; action: string }>;
}> {
  const artifacts = await buildSuppressionArtifacts({
    firmId: args.firmId,
    firmName: args.firmName,
    primaryUrl: args.primaryUrl,
    generatedAt: new Date(),
  });

  const created: Array<{ id: string; title: string; priorityRank: number; action: string }> = [];

  let rankCounter = 1;
  // Sort within each action bucket by clicks (highest first within
  // suppression candidates, lowest first within keeps).
  const sorted = [...artifacts.decisions].sort((a, b) => {
    const ap = PRIORITY[a.action];
    const bp = PRIORITY[b.action];
    if (ap == null || bp == null) return 0;
    if (ap !== bp) return ap - bp;
    if (a.action === 'keep') return b.clicks12m - a.clicks12m;
    return b.clicks12m - a.clicks12m;
  });

  for (const d of sorted) {
    const actionLabel = d.action[0]!.toUpperCase() + d.action.slice(1);
    const title =
      d.action === 'keep'
        ? `Refresh content: ${d.title ?? d.url}`
        : `${actionLabel} ${d.title ?? d.url}`;
    const description = `${d.rationale}\n\nPage: ${d.url}\nClicks/mo (last 90d): ${d.clicks12m}\nSemantic distance from Brand Truth: ${d.semanticDistance.toFixed(3)}\nWord count: ${d.wordCount ?? 'unknown'}`;
    const remediation = REMEDIATION_COPY[d.action]?.(d.url, d.redirectTarget) ?? '';
    const validation = [
      { description: `Implement the change in CMS` },
      { description: `Verify via page source / browser (status code or meta tag)` },
      { description: `Tick this ticket complete once verified` },
    ];
    if (d.action === 'delete') {
      validation.unshift({ description: 'Back up the page content first' });
      validation.push({ description: 'Wait 2-4 weeks (Phase C monitoring window) before permanent delete' });
    }
    if (d.action === 'redirect') {
      validation.push({ description: 'Update internal links pointing to the old URL' });
    }

    // Automation tier per action type. All four currently ship as
    // 'assist' — the operator implements the noindex/301/delete via
    // their CMS. We can flip these to 'auto' once a firm has wired
    // CMS credentials in Settings (WordPress REST, Webflow Custom
    // Code API, Shopify urlRedirectCreate, Cloudflare Rulesets API).
    const automationTier: 'auto' | 'assist' | 'manual' = 'assist';
    const executeLabel =
      d.action === 'noindex'
        ? 'Apply noindex meta tag'
        : d.action === 'redirect'
          ? 'Configure 301 redirect'
          : d.action === 'delete'
            ? 'Delete via CMS'
            : 'Refresh content (Phase 3)';

    // Map suppression-decision action to the priority class. Mirrors
    // the legacy scanner's emit path so the factory and the scanner
    // produce identically-scored tickets.
    const { priorityClass, priorityScore } = computePriority({
      sourceType: 'legacy',
      sopKey: args.sopKey,
      legacyAction: d.action,
      semanticDistance: d.semanticDistance,
      clicksPerMonth: d.clicks12m ?? null,
    });
    const r = await createTicketFromStep({
      firmSlug: args.firmSlug,
      sopKey: args.sopKey,
      runId: args.runId,
      stepNumber: args.stepNumber,
      title,
      description,
      priorityRank: rankCounter++,
      priorityClass,
      priorityScore,
      remediationCopy: remediation,
      validationSteps: validation,
      evidenceLinks: [{ kind: 'page_url', url: d.url, description: `Drifted from Brand Truth (d=${d.semanticDistance.toFixed(2)})` }],
      automationTier,
      executeUrl: d.url,
      executeLabel,
    });
    created.push({ id: r.id, title, priorityRank: rankCounter - 1, action: d.action });
  }

  return { created };
}
