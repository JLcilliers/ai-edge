/**
 * Schema Markup Deployment scanner — Phase 5 SOP
 * `schema_markup_deployment`.
 *
 * Shares the bounded-fetch pattern with semantic-html-scanner. Per page:
 *   1. Pull up to 256KB of HTML
 *   2. Extract every <script type="application/ld+json"> block
 *   3. Parse + classify the @type values
 *   4. Compare against page-kind expectations (URL + body heuristics)
 *   5. Emit one ticket per finding (multiple findings per page are
 *      possible — each carries its own severity + fix copy)
 *
 * V1 detection rules surfaced as separate tickets so the operator can
 * triage them independently:
 *   - No JSON-LD on the page                  → high
 *   - Malformed JSON-LD                       → high
 *   - Missing Organization-family schema      → high
 *   - FAQ-shaped page without FAQPage         → medium
 *   - Article-shaped page without Article    → medium
 *   - Non-homepage missing BreadcrumbList     → low
 *
 * Lifecycle parallels the other Phase 3/5 scanners — idempotent over
 * (firm × SOP), reuse the same sop_run, clear prior open tickets on
 * re-run, leave status=awaiting_input.
 */

import {
  getDb,
  firms,
  pages,
  sopRuns,
  sopStepStates,
  remediationTickets,
} from '@ai-edge/db';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { createTicketFromStep } from '../../actions/sop-actions';
import { getSopDefinition } from '../sop/registry';
import { computePriority } from '../sop/priority-score';
import {
  auditPageSchema,
  compareAuditsBySeverity,
  type SchemaFinding,
  type SchemaPageAudit,
} from './schema-markup-rubric';

const SOP_KEY = 'schema_markup_deployment' as const;
// Tickets attach to step 1 (Audit Existing Schema) — the "scan + rank"
// step. Steps 2-7 are the deployment work the tickets are *for*.
const TICKET_STEP_NUMBER = 1;
const MAX_PAGES_PER_RUN = 100;
const FETCH_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;

const SEVERITY_RANK: Record<SchemaFinding['severity'], number> = {
  high: 1,
  medium: 2,
  low: 3,
};

export interface SchemaScanResult {
  runId: string;
  pagesScanned: number;
  pagesWithFindings: number;
  ticketsCreated: number;
  severityCounts: { high: number; medium: number; low: number };
  /** Pages that already have a clean schema setup. Surfaced as a positive
   *  signal in the banner — "12 pages already squared away." */
  pagesClean: number;
}

interface FirmRow {
  id: string;
  slug: string;
  name: string;
}

async function resolveFirm(arg: { id?: string; slug?: string }): Promise<FirmRow> {
  const db = getDb();
  if (arg.id) {
    const [f] = await db
      .select({ id: firms.id, slug: firms.slug, name: firms.name })
      .from(firms)
      .where(eq(firms.id, arg.id))
      .limit(1);
    if (!f) throw new Error(`Firm not found: ${arg.id}`);
    return f;
  }
  if (arg.slug) {
    const [f] = await db
      .select({ id: firms.id, slug: firms.slug, name: firms.name })
      .from(firms)
      .where(eq(firms.slug, arg.slug))
      .limit(1);
    if (!f) throw new Error(`Firm not found: ${arg.slug}`);
    return f;
  }
  throw new Error('resolveFirm: id or slug required');
}

async function fetchHtmlBounded(url: string): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'ClixsyAEOScanner/1.0 (+schema-markup-scan; bounded read)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return null;
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.toLowerCase().includes('html')) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const dec = new TextDecoder();
    let out = '';
    let read = 0;
    while (read < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      read += value.byteLength;
    }
    try {
      await reader.cancel();
    } catch {
      /* harmless */
    }
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findOrCreateScannerRun(firmId: string): Promise<string> {
  const db = getDb();
  const def = getSopDefinition(SOP_KEY);

  const [existing] = await db
    .select({ id: sopRuns.id, status: sopRuns.status })
    .from(sopRuns)
    .where(and(eq(sopRuns.firm_id, firmId), eq(sopRuns.sop_key, SOP_KEY)))
    .orderBy(desc(sopRuns.created_at))
    .limit(1);

  if (existing && existing.status !== 'cancelled') {
    return existing.id;
  }

  const now = new Date();
  const [inserted] = await db
    .insert(sopRuns)
    .values({
      firm_id: firmId,
      sop_key: SOP_KEY,
      phase: def.phase,
      status: 'in_progress',
      current_step: 1,
      started_at: now,
      meta: { scanner_managed: true },
      created_by: 'scanner:schema-markup',
    })
    .returning({ id: sopRuns.id });
  const runId = inserted!.id;

  await db.insert(sopStepStates).values(
    def.steps.map((s) => ({
      sop_run_id: runId,
      step_number: s.number,
      step_key: s.key,
      status: 'not_started' as const,
    })),
  );
  return runId;
}

async function clearPriorOpenTickets(firmId: string, runId: string): Promise<void> {
  const db = getDb();
  await db
    .delete(remediationTickets)
    .where(
      and(
        eq(remediationTickets.firm_id, firmId),
        eq(remediationTickets.sop_run_id, runId),
        eq(remediationTickets.sop_step_number, TICKET_STEP_NUMBER),
        inArray(remediationTickets.status, ['open', 'in_progress']),
      ),
    );
}

async function markScannerStepComplete(runId: string): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .update(sopStepStates)
    .set({ status: 'completed', started_at: now, completed_at: now })
    .where(
      and(
        eq(sopStepStates.sop_run_id, runId),
        eq(sopStepStates.step_number, TICKET_STEP_NUMBER),
      ),
    );
  await db
    .update(sopRuns)
    .set({
      current_step: TICKET_STEP_NUMBER + 1,
      status: 'awaiting_input',
      started_at: now,
    })
    .where(eq(sopRuns.id, runId));
}

/** Boilerplate snippet per finding type — the operator can drop these
 * into a CMS code block as a starting point and customize. */
const SCHEMA_BOILERPLATE: Partial<Record<SchemaFinding['key'], (url: string) => string>> = {
  no_jsonld: () => `\`\`\`html
<!-- Site-wide Organization (one block, include in every page <head>) -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Your Firm Name",
  "url": "https://yoursite.com",
  "logo": "https://yoursite.com/logo.png",
  "sameAs": [
    "https://www.linkedin.com/company/your-firm",
    "https://twitter.com/your-firm"
  ]
}
</script>
\`\`\``,
  missing_organization: () => `\`\`\`html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Your Firm Name",
  "url": "https://yoursite.com",
  "logo": "https://yoursite.com/logo.png",
  "sameAs": ["https://wikipedia.org/wiki/...", "https://www.linkedin.com/..."]
}
</script>
\`\`\`
Tip: use the most specific subtype (LocalBusiness, Attorney, Dentist, MedicalBusiness) when applicable.`,
  faq_without_faqpage: () => `\`\`\`html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Your question here?",
      "acceptedAnswer": { "@type": "Answer", "text": "Your answer here." }
    }
  ]
}
</script>
\`\`\``,
  article_without_article_schema: (url) => `\`\`\`html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "Page title",
  "author": { "@type": "Person", "name": "Author Name" },
  "datePublished": "YYYY-MM-DD",
  "dateModified": "YYYY-MM-DD",
  "mainEntityOfPage": "${url}"
}
</script>
\`\`\``,
  missing_breadcrumb: (url) => `\`\`\`html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://yoursite.com/" },
    { "@type": "ListItem", "position": 2, "name": "Page title", "item": "${url}" }
  ]
}
</script>
\`\`\``,
};

function buildTicketForFinding(
  audit: SchemaPageAudit,
  finding: SchemaFinding,
): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  const sev = finding.severity[0]!.toUpperCase() + finding.severity.slice(1);
  const title = `[${sev}] Schema: ${finding.label} — ${audit.url}`;

  const detectedSummary =
    audit.detectedTypes.length === 0
      ? 'No JSON-LD types detected on this page.'
      : `Currently detected @types on this page: ${audit.detectedTypes.join(', ')}`;

  const description =
    `${finding.detail}\n\n` +
    `Page: ${audit.url}\n` +
    `Detected page kind: ${audit.pageKind}\n` +
    `${detectedSummary}`;

  const boilerplate = SCHEMA_BOILERPLATE[finding.key]?.(audit.url) ?? '';
  const remediationCopy = boilerplate
    ? `**Page:** ${audit.url}\n\n**Finding:** ${finding.label}\n\n${finding.detail}\n\n**Boilerplate to start from:**\n\n${boilerplate}\n\n**Validate:** paste the page URL into https://search.google.com/test/rich-results and confirm no errors.`
    : `**Page:** ${audit.url}\n\n**Finding:** ${finding.label}\n\n${finding.detail}\n\n**Validate:** paste the page URL into https://search.google.com/test/rich-results and confirm no errors.`;

  const validationSteps: Array<{ description: string }> = [
    { description: 'Add or correct the schema block in CMS / template' },
    { description: 'Validate at https://search.google.com/test/rich-results — no errors' },
    { description: 'Re-run Schema Markup scan and confirm finding is cleared' },
  ];

  return { title, description, remediationCopy, validationSteps };
}

async function fetchAllPages(urls: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < FETCH_CONCURRENCY; w++) {
    workers.push(
      (async () => {
        while (cursor < urls.length) {
          const i = cursor++;
          const url = urls[i]!;
          const html = await fetchHtmlBounded(url);
          if (html) result.set(url, html);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return result;
}

export async function runSchemaMarkupScan(firmId: string): Promise<SchemaScanResult> {
  const db = getDb();
  const firm = await resolveFirm({ id: firmId });

  const rows = await db
    .select({
      url: pages.url,
    })
    .from(pages)
    .where(eq(pages.firm_id, firm.id))
    .orderBy(desc(pages.fetched_at))
    .limit(MAX_PAGES_PER_RUN);

  if (rows.length === 0) {
    throw new Error('No crawled pages found — run the Suppression scan first to populate the page corpus.');
  }

  const htmlMap = await fetchAllPages(rows.map((r) => r.url));

  const audits: SchemaPageAudit[] = [];
  for (const r of rows) {
    const html = htmlMap.get(r.url);
    if (!html) continue;
    audits.push(auditPageSchema(r.url, html));
  }
  if (audits.length === 0) {
    throw new Error('Every page fetch failed — verify the firm site is reachable and try again.');
  }

  const runId = await findOrCreateScannerRun(firm.id);
  await clearPriorOpenTickets(firm.id, runId);

  // Sort pages by severity (worst first), emit one ticket per finding.
  const sorted = [...audits].sort(compareAuditsBySeverity);
  let priorityRank = 1;
  let ticketsCreated = 0;
  const severityCounts = { high: 0, medium: 0, low: 0 };

  for (const audit of sorted) {
    if (audit.findings.length === 0) continue;
    // Sort findings within a page by severity too.
    const findings = [...audit.findings].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
    for (const finding of findings) {
      severityCounts[finding.severity] += 1;
      const payload = buildTicketForFinding(audit, finding);
      // Map schema-finding severity to a rubric-equivalent score so the
      // priority math is consistent with the other per_page_quality
      // scanners. High-severity schema gap = "this page is barely
      // machine-readable" = score 20 (offset 80); medium = score 50
      // (offset 50); low = score 80 (offset 20).
      const rubricEquivalent =
        finding.severity === 'high' ? 20 :
        finding.severity === 'medium' ? 50 :
        80;
      const { priorityClass, priorityScore } = computePriority({
        sourceType: 'sop',
        sopKey: SOP_KEY,
        rubricScore: rubricEquivalent,
        rubricMax: 100,
      });
      await createTicketFromStep({
        firmSlug: firm.slug,
        sopKey: SOP_KEY,
        runId,
        stepNumber: TICKET_STEP_NUMBER,
        title: payload.title,
        description: payload.description,
        priorityRank: priorityRank++,
        priorityClass,
        priorityScore,
        remediationCopy: payload.remediationCopy,
        validationSteps: payload.validationSteps,
        evidenceLinks: [
          {
            kind: 'page_url',
            url: audit.url,
            description: `Page kind: ${audit.pageKind} · finding: ${finding.label}`,
          },
        ],
        automationTier: 'assist',
        executeUrl: audit.url,
        executeLabel: 'Open page',
      });
      ticketsCreated += 1;
    }
  }

  await markScannerStepComplete(runId);

  const pagesWithFindings = audits.filter((a) => a.findings.length > 0).length;
  return {
    runId,
    pagesScanned: audits.length,
    pagesWithFindings,
    ticketsCreated,
    severityCounts,
    pagesClean: audits.length - pagesWithFindings,
  };
}

export async function runSchemaMarkupScanBySlug(firmSlug: string): Promise<SchemaScanResult> {
  const firm = await resolveFirm({ slug: firmSlug });
  return runSchemaMarkupScan(firm.id);
}
