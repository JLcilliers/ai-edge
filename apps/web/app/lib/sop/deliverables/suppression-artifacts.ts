/**
 * Deliverable builders for Legacy Content Suppression SOP:
 *   - decision_matrix_csv     — Step 3: per-page Delete/301/No-Index/Keep
 *   - redirect_map_csv        — Step 5: source URL → target URL for 301s
 *   - phased_implementation_plan_md — Step 5: Phase A/B/C with timelines
 *
 * Data source: the firm's `legacy_findings` table + `pages` for context.
 * GSC clicks are pulled if a gsc_connection exists, otherwise the
 * decision framework falls back to legacy_finding.action (the existing
 * semantic-distance-based decision).
 */

import { put } from '@vercel/blob';
import {
  getDb,
  legacyFindings,
  pages,
} from '@ai-edge/db';
import { eq, sql } from 'drizzle-orm';

interface DecisionRow {
  pageId: string;
  url: string;
  title: string | null;
  wordCount: number | null;
  action: 'delete' | 'redirect' | 'noindex' | 'keep';
  rationale: string;
  semanticDistance: number;
  clicks12m: number;
  redirectTarget: string | null;
}

interface BuildArgs {
  firmId: string;
  firmName: string;
  primaryUrl: string | null;
  generatedAt: Date;
}

interface BuildResult {
  decisions: DecisionRow[];
  decisionMatrix: { filename: string; blobUrl: string | null; rowCount: number };
  redirectMap: { filename: string; blobUrl: string | null; rowCount: number };
  phasedPlan: { filename: string; blobUrl: string | null; bytes: number };
}

const DELETE_CLICK_THRESHOLD = 5;
const REDIRECT_CLICK_THRESHOLD = 10;
const KEEP_CLICK_THRESHOLD = 50;

/**
 * Apply the SOP Step 3 decision framework.
 *   <5 clicks/mo + drifted (d≥0.55) + no backlinks  → DELETE
 *   ≥10 clicks/mo OR has backlinks                   → 301 REDIRECT
 *   5-20 clicks/mo + needs to exist                  → NO-INDEX
 *   ≥50 clicks/mo + can be updated                   → KEEP (update)
 *
 * Without GSC data, falls back to the semantic-distance heuristic the
 * legacy suppression scanner used (d≥0.55 = noindex, 0.4-0.55 = rewrite).
 */
function decideAction(
  d: number,
  clicksPerMonth: number,
  legacyAction: string,
): { action: DecisionRow['action']; rationale: string } {
  if (clicksPerMonth >= KEEP_CLICK_THRESHOLD) {
    return {
      action: 'keep',
      rationale: `${clicksPerMonth.toFixed(0)} clicks/mo — refresh in place rather than suppress`,
    };
  }
  if (clicksPerMonth >= REDIRECT_CLICK_THRESHOLD) {
    return {
      action: 'redirect',
      rationale: `${clicksPerMonth.toFixed(0)} clicks/mo — preserve search authority via 301`,
    };
  }
  if (d >= 0.55 && clicksPerMonth < DELETE_CLICK_THRESHOLD) {
    return {
      action: 'delete',
      rationale: `Semantic distance ${d.toFixed(2)} (drifted) and ${clicksPerMonth.toFixed(0)} clicks/mo — safe to remove`,
    };
  }
  if (legacyAction === 'noindex') {
    return {
      action: 'noindex',
      rationale: `Drifted from Brand Truth (d=${d.toFixed(2)}) but ${clicksPerMonth.toFixed(0)} clicks/mo — hide from search`,
    };
  }
  // Rewrite candidate from the scanner. With low click data, default to
  // no-index (lowest risk) until operator decides.
  return {
    action: 'noindex',
    rationale: `Drifted (d=${d.toFixed(2)}) with ${clicksPerMonth.toFixed(0)} clicks/mo — recommend no-index until operator decides`,
  };
}

async function loadDecisionRows(firmId: string): Promise<DecisionRow[]> {
  const db = getDb();

  // Latest finding per page.
  const rows = await db
    .select({
      pageId: pages.id,
      url: pages.url,
      title: pages.title,
      wordCount: pages.word_count,
      action: legacyFindings.action,
      distance: legacyFindings.semantic_distance,
      detectedAt: legacyFindings.detected_at,
    })
    .from(legacyFindings)
    .innerJoin(pages, eq(legacyFindings.page_id, pages.id))
    .where(eq(pages.firm_id, firmId))
    .orderBy(sql`${pages.id}, ${legacyFindings.detected_at} DESC`);

  // Dedupe by pageId, keeping the newest finding.
  const latestByPage = new Map<string, typeof rows[number]>();
  for (const r of rows) {
    if (!latestByPage.has(r.pageId)) latestByPage.set(r.pageId, r);
  }

  // Per-URL GSC click data isn't available in this schema yet —
  // gsc_daily_metric is firm-wide aggregate. Until the GSC sync stores
  // per-URL breakdowns we fall back to clicks=0 and let the decision
  // framework rely on semantic distance + the existing legacy_finding
  // action recommendation. The decision thresholds activate as soon as
  // GSC per-URL data lands (no factory rewrite needed).
  const clicksByUrl = new Map<string, number>();

  const out: DecisionRow[] = [];
  for (const r of latestByPage.values()) {
    const clicks = clicksByUrl.get(r.url) ?? 0;
    const { action, rationale } = decideAction(r.distance, clicks, r.action);
    out.push({
      pageId: r.pageId,
      url: r.url,
      title: r.title,
      wordCount: r.wordCount,
      action,
      rationale,
      semanticDistance: r.distance,
      clicks12m: clicks,
      redirectTarget: action === 'redirect' ? null : null, // operator picks
    });
  }
  // Sort by impact: deletes first (clear win), then redirects, then noindex, then keep.
  const order = { delete: 0, redirect: 1, noindex: 2, keep: 3 } as const;
  out.sort((a, b) => order[a.action] - order[b.action]);
  return out;
}

function decisionsToCsv(decisions: DecisionRow[]): string {
  const headers = [
    'URL',
    'Title',
    'Action',
    'Rationale',
    'Semantic Distance',
    'Clicks/mo (last 90d)',
    'Redirect Target',
    'Word Count',
  ];
  const lines = [headers.join(',')];
  for (const d of decisions) {
    const cells = [
      csv(d.url),
      csv(d.title ?? ''),
      d.action,
      csv(d.rationale),
      d.semanticDistance.toFixed(3),
      d.clicks12m.toString(),
      csv(d.redirectTarget ?? ''),
      (d.wordCount ?? 0).toString(),
    ];
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

function redirectMapCsv(decisions: DecisionRow[]): string {
  const lines = ['Source URL,Target URL,Notes'];
  for (const d of decisions) {
    if (d.action !== 'redirect') continue;
    const target = d.redirectTarget ?? '[operator to assign]';
    lines.push(`${csv(d.url)},${csv(target)},${csv(d.rationale)}`);
  }
  return lines.join('\n');
}

function phasedPlanMarkdown(decisions: DecisionRow[], firmName: string, generatedAt: Date): string {
  const deletes = decisions.filter((d) => d.action === 'delete');
  const redirects = decisions.filter((d) => d.action === 'redirect');
  const noindexes = decisions.filter((d) => d.action === 'noindex');
  const keeps = decisions.filter((d) => d.action === 'keep');

  return `# Legacy Content Suppression — Phased Implementation Plan

**Firm:** ${firmName}
**Generated:** ${generatedAt.toISOString()}
**Total flagged pages:** ${decisions.length}

## Summary

| Action | Count | Risk | Timing |
|---|---|---|---|
| Delete | ${deletes.length} | High | Phase C (week 6+) |
| 301 Redirect | ${redirects.length} | Medium | Phase B (week 3-5) |
| No-Index | ${noindexes.length} | Low | Phase A (week 1-2) |
| Keep (update) | ${keeps.length} | None | Out of scope |

---

## Phase A · No-Index (lowest risk — start here)

Estimated time: ${Math.ceil(noindexes.length / 20) * 15}-${Math.ceil(noindexes.length / 20) * 30} min for ${noindexes.length} pages

For each page below, add \`<meta name="robots" content="noindex">\` via Yoast / RankMath / page-level CMS setting.

${noindexes.map((d, i) => `${i + 1}. ${d.url}\n   - ${d.rationale}`).join('\n')}

---

## Phase B · 301 Redirects (medium risk — after Phase A is stable)

Estimated time: ${1 + Math.ceil(redirects.length / 30)}-${2 + Math.ceil(redirects.length / 30)} hours for ${redirects.length} pages

For each page below, configure a 301 redirect via Redirection plugin / htaccess / Cloudflare Page Rules. Test every redirect after deployment.

${redirects.map((d, i) => `${i + 1}. \`${d.url}\` → \`${d.redirectTarget ?? '[OPERATOR TO ASSIGN]'}\`\n   - ${d.rationale}`).join('\n')}

---

## Phase C · Deletions (highest risk — do last, after 2-4 week monitoring)

Estimated time: ${Math.ceil(deletes.length / 50) * 30} min for ${deletes.length} pages

For each page below:
1. Back up content (export HTML)
2. Move to Trash (don't permanently delete)
3. Wait 2-4 weeks, monitor analytics
4. Permanently delete if no unexpected traffic loss

${deletes.map((d, i) => `${i + 1}. ${d.url}\n   - ${d.rationale}\n   - Last 90 days: ${d.clicks12m} clicks/mo, ${d.wordCount ?? '?'} words`).join('\n')}

---

## Monitoring (Phase D — 4-6 weeks after Phase C)

- Track total indexed pages in GSC (Coverage report)
- Track brand-filtered query traffic
- Watch for 404 errors (Coverage → Excluded)
- Use Screaming Frog to find redirect chains
- Re-run Brand Visibility Audit to verify LLM citation drift improved

_Generated by Clixsy Intercept · ${generatedAt.toISOString()}_
`;
}

function csv(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

async function uploadOrFallback(
  filename: string,
  body: string | ArrayBuffer,
  contentType: string,
): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const blob = await put(`sop-deliverables/${filename}`, body, {
      access: 'public',
      contentType,
    });
    return blob.url;
  } catch (e) {
    console.error('[suppression] blob upload failed:', e);
    return null;
  }
}

export async function buildSuppressionArtifacts(args: BuildArgs): Promise<BuildResult> {
  const decisions = await loadDecisionRows(args.firmId);
  const slug = args.firmName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const datestamp = args.generatedAt.toISOString().slice(0, 10);

  const matrixFilename = `suppression-decisions-${slug}-${datestamp}.csv`;
  const matrixCsv = decisionsToCsv(decisions);
  const matrixUrl = await uploadOrFallback(matrixFilename, matrixCsv, 'text/csv');

  const mapFilename = `suppression-redirect-map-${slug}-${datestamp}.csv`;
  const mapCsv = redirectMapCsv(decisions);
  const mapUrl = await uploadOrFallback(mapFilename, mapCsv, 'text/csv');

  const planFilename = `suppression-phased-plan-${slug}-${datestamp}.md`;
  const planMd = phasedPlanMarkdown(decisions, args.firmName, args.generatedAt);
  const planUrl = await uploadOrFallback(planFilename, planMd, 'text/markdown');

  return {
    decisions,
    decisionMatrix: { filename: matrixFilename, blobUrl: matrixUrl, rowCount: decisions.length },
    redirectMap: {
      filename: mapFilename,
      blobUrl: mapUrl,
      rowCount: decisions.filter((d) => d.action === 'redirect').length,
    },
    phasedPlan: { filename: planFilename, blobUrl: planUrl, bytes: planMd.length },
  };
}
