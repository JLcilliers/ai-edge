/**
 * AI Info Page Creation scanner — Phase 5 SOP `ai_info_page_creation`.
 *
 * Every AEO client should have a dedicated entity reference page at
 * `/ai-info` or `/llm-info` — a canonical page LLMs use as a grounding
 * source for queries about the brand. The SOP defines the structure:
 *
 *   H1: "What is [Brand]?"
 *   - Canonical brand definition (1-2 sentences)
 *   - Per-topic / per-service definitions
 *   - FAQ section (5-10 common questions)
 *   - FAQPage + Organization JSON-LD
 *   - Linked from the global footer + sitemap
 *
 * This scanner is the simplest one in the catalog: check if the firm
 * has crawled any URL matching the canonical paths. If yes → page
 * exists, mark SOP complete with no tickets. If no → emit one
 * assist-tier ticket with the full structure pre-drafted from Brand
 * Truth so the operator pastes it into CMS.
 *
 * Cadence per SOP: 90 days. After a successful creation the scanner
 * re-runs quarterly to confirm the page still exists and the JSON-LD
 * still validates.
 */

import {
  getDb,
  firms,
  pages,
  sopRuns,
  sopStepStates,
  remediationTickets,
  brandTruthVersions,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { and, eq, desc, inArray, or, like } from 'drizzle-orm';
import { createTicketFromStep } from '../../actions/sop-actions';
import { getSopDefinition } from '../sop/registry';
import { computePriority } from '../sop/priority-score';

const SOP_KEY = 'ai_info_page_creation' as const;
// Tickets attach to step 1 (Draft Page Structure) — the create-step.
const TICKET_STEP_NUMBER = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

// URL patterns that count as "the AI info page already exists."
// We check the firm's crawled `pages` table for any URL whose path
// contains one of these segments. Case-insensitive via lower().
const CANONICAL_PATH_NEEDLES = [
  '/ai-info',
  '/llm-info',
  '/ai_info',
  '/llm_info',
  '/ai-overview',
  '/llm-overview',
  '/about-ai',
];

export interface AiInfoScanResult {
  runId: string;
  pageExists: boolean;
  detectedUrl: string | null;
  ticketCreated: boolean;
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

async function findExistingAiInfoUrl(firmId: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ url: pages.url })
    .from(pages)
    .where(
      and(
        eq(pages.firm_id, firmId),
        or(...CANONICAL_PATH_NEEDLES.map((n) => like(pages.url, `%${n}%`))),
      ),
    )
    .limit(1);
  return rows[0]?.url ?? null;
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
      created_by: 'scanner:ai-info',
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

async function markScannerStepsComplete(runId: string, allComplete: boolean): Promise<void> {
  const db = getDb();
  const now = new Date();
  const def = getSopDefinition(SOP_KEY);

  // When the page already exists, mark every step complete (the page
  // is published — there's nothing left to do until the next quarterly
  // refresh). When the page doesn't exist, we only mark step 1
  // (Draft Page Structure) complete — the rest of the steps are the
  // operator's work after they pick up the ticket.
  for (const step of def.steps) {
    const shouldComplete = allComplete || step.number <= TICKET_STEP_NUMBER;
    await db
      .update(sopStepStates)
      .set({
        status: shouldComplete ? 'completed' : 'not_started',
        started_at: shouldComplete ? now : null,
        completed_at: shouldComplete ? now : null,
      })
      .where(
        and(eq(sopStepStates.sop_run_id, runId), eq(sopStepStates.step_number, step.number)),
      );
  }

  await db
    .update(sopRuns)
    .set({
      current_step: allComplete ? def.steps.length : TICKET_STEP_NUMBER + 1,
      status: allComplete ? 'completed' : 'awaiting_input',
      completed_at: allComplete ? now : null,
      next_review_at: new Date(Date.now() + 90 * DAY_MS),
      started_at: now,
    })
    .where(eq(sopRuns.id, runId));
}

/**
 * Build per-topic definitions from Brand Truth. Different firm types
 * carry different fields — law firms have practice_areas, dental
 * practices have practice_areas (same key), agencies have
 * service_offerings. We read what's there and pass through.
 */
function extractTopicsFromBrandTruth(
  brandTruth: BrandTruth | null,
): Array<{ name: string; scope?: string }> {
  if (!brandTruth) return [];
  const bt = brandTruth as Record<string, unknown>;

  // Service offerings (agency / other variants).
  if (Array.isArray(bt.service_offerings)) {
    return (bt.service_offerings as Array<{ name?: unknown; scope?: unknown }>)
      .filter((s) => typeof s?.name === 'string')
      .map((s) => ({
        name: s.name as string,
        scope: typeof s.scope === 'string' ? s.scope : undefined,
      }));
  }
  // Practice areas (law firm / dental).
  if (Array.isArray(bt.practice_areas)) {
    return (bt.practice_areas as unknown[])
      .filter((p): p is string => typeof p === 'string')
      .map((p) => ({ name: p }));
  }
  return [];
}

function buildCanonicalDefinition(brandTruth: BrandTruth | null, firmName: string): string {
  if (!brandTruth) return `${firmName} is a firm specializing in [add specialty].`;
  const bt = brandTruth as Record<string, unknown>;
  const differentiators = Array.isArray(bt.unique_differentiators)
    ? (bt.unique_differentiators as unknown[]).filter(
        (s): s is string => typeof s === 'string',
      )
    : [];
  const topics = extractTopicsFromBrandTruth(brandTruth);
  const topicList =
    topics.length > 0
      ? topics
          .slice(0, 3)
          .map((t) => t.name)
          .join(', ')
      : '[primary services]';
  const differentiator = differentiators[0] ?? '[primary differentiator]';
  return `${firmName} is a firm specializing in ${topicList}. ${differentiator}.`;
}

function buildCreateTicket(
  firmName: string,
  primaryUrl: string | null,
  brandTruth: BrandTruth | null,
): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  const canonicalDef = buildCanonicalDefinition(brandTruth, firmName);
  const topics = extractTopicsFromBrandTruth(brandTruth);
  const homeUrl = primaryUrl ?? 'https://yoursite.com';
  // Clean trailing slash so the suggested URL doesn't read like `//ai-info`.
  const homeTrimmed = homeUrl.replace(/\/$/, '');

  const topicsBlock =
    topics.length > 0
      ? topics
          .slice(0, 8)
          .map(
            (t, i) =>
              `${i + 1}. **${t.name}** — ${
                t.scope ?? '[1-2 sentence definition of this service / practice area]'
              }`,
          )
          .join('\n')
      : '1. **[Primary service]** — [1-2 sentence definition]\n2. **[Secondary service]** — [1-2 sentence definition]';

  const faqBlock = topics
    .slice(0, 5)
    .map(
      (t) =>
        `- **Q: What is ${t.name}?**\n  A: ${t.scope ?? `${t.name} is …`}`,
    )
    .join('\n');

  const orgJsonLd = `{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "${firmName}",
  "url": "${homeTrimmed}",
  "logo": "${homeTrimmed}/logo.png",
  "sameAs": [
    "[LinkedIn URL]",
    "[Wikipedia URL if applicable]",
    "[Crunchbase URL if applicable]"
  ]
}`;

  const faqJsonLd = `{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    ${topics
      .slice(0, 5)
      .map(
        (t) =>
          `{
      "@type": "Question",
      "name": "What is ${t.name}?",
      "acceptedAnswer": { "@type": "Answer", "text": "${(t.scope ?? `${t.name} is …`).replace(/"/g, '\\"')}" }
    }`,
      )
      .join(',\n    ')}
  ]
}`;

  const title = `Create /ai-info entity reference page for ${firmName}`;
  const description = `${firmName} doesn't have a dedicated entity reference page at /ai-info or /llm-info yet. Every AEO client should have one — it's the canonical source LLMs use for grounding queries about the brand ("What is [Brand]?", "What does [Brand] do?", "Who is [Brand]'s leadership?").\n\nWithout this page, LLMs synthesize an answer from whatever's on the site, which is exactly the inconsistency you're trying to suppress.\n\nThis is a one-time setup — once published, the scanner re-checks quarterly to confirm the page still exists and JSON-LD still validates.`;

  const remediationCopy = `**Suggested URL:** \`${homeTrimmed}/ai-info\` (or \`/llm-info\` — pick one and stick with it)

**Page structure (Steve Toth AI Info Page Creation SOP):**

\`\`\`markdown
# What is ${firmName}?

${canonicalDef}

## Our Services

${topicsBlock}

## Frequently Asked Questions

${faqBlock || '- **Q: [Common question]?**\n  A: [Answer]'}

## Authoritative Sources

- [Wikipedia page if applicable]
- [LinkedIn company page]
- [Crunchbase profile if applicable]
- [Bar association / state board listing if applicable]
- [Trade press articles citing the firm]
\`\`\`

**JSON-LD schema (paste both blocks in <head>):**

\`\`\`html
<!-- Organization schema -->
<script type="application/ld+json">
${orgJsonLd}
</script>

<!-- FAQPage schema -->
<script type="application/ld+json">
${faqJsonLd}
</script>
\`\`\`

**Publishing checklist:**

1. Create the page in CMS at \`/ai-info\` (or chosen canonical URL).
2. Paste the markdown structure; customize the topic definitions + FAQ answers.
3. Add the two JSON-LD scripts in the page <head>.
4. Add a footer link: \`<a href="/ai-info">AI Info</a>\`.
5. Add the URL to the XML sitemap.
6. Validate at https://search.google.com/test/rich-results.
7. Submit for indexing in GSC → URL Inspection.

**Validation:** the next quarterly re-scan checks the page still exists + JSON-LD still parses. The page lives in your CMS as a regular page — keep it updated alongside Brand Truth changes.`;

  const validationSteps = [
    { description: 'Create the page in CMS' },
    { description: 'Paste structure + customize topics + FAQ' },
    { description: 'Add both JSON-LD scripts' },
    { description: 'Add footer link + sitemap entry' },
    { description: 'Validate JSON-LD at rich-results test' },
    { description: 'Submit for indexing in GSC' },
    { description: 'Confirm Brand Visibility Audit picks up the new page' },
  ];

  return { title, description, remediationCopy, validationSteps };
}

export async function runAiInfoScan(firmId: string): Promise<AiInfoScanResult> {
  const db = getDb();
  const firm = await resolveFirm({ id: firmId });

  const existing = await findExistingAiInfoUrl(firm.id);
  const runId = await findOrCreateScannerRun(firm.id);
  await clearPriorOpenTickets(firm.id, runId);

  if (existing) {
    // Page exists — SOP is satisfied. Mark every step complete and
    // bump the next review +90 days. No ticket.
    await markScannerStepsComplete(runId, true);
    return {
      runId,
      pageExists: true,
      detectedUrl: existing,
      ticketCreated: false,
    };
  }

  // Need to create it.
  const [bt] = await db
    .select({ payload: brandTruthVersions.payload })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firm.id))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  const brandTruth = (bt?.payload as BrandTruth | undefined) ?? null;
  const primaryUrl =
    (brandTruth as { primary_url?: string } | null | undefined)?.primary_url ?? null;

  const payload = buildCreateTicket(firm.name, primaryUrl, brandTruth);
  // AI-info page creation is a one-shot per-page rubric. The firm
  // either has the page (rubric = max) or doesn't (rubric = 0 →
  // offset 99). This ticket only fires when the page is missing, so
  // we score at the high-urgency end of per_page_quality.
  const { priorityClass, priorityScore } = computePriority({
    sourceType: 'sop',
    sopKey: SOP_KEY,
    rubricScore: 0,
    rubricMax: 100,
  });
  await createTicketFromStep({
    firmSlug: firm.slug,
    sopKey: SOP_KEY,
    runId,
    stepNumber: TICKET_STEP_NUMBER,
    title: payload.title,
    description: payload.description,
    priorityRank: 1,
    priorityClass,
    priorityScore,
    remediationCopy: payload.remediationCopy,
    validationSteps: payload.validationSteps,
    evidenceLinks: primaryUrl
      ? [{ kind: 'page_url', url: primaryUrl, description: 'Firm homepage' }]
      : [],
    automationTier: 'assist',
    executeUrl: primaryUrl ?? undefined,
    executeLabel: primaryUrl ? 'Open homepage' : undefined,
  });

  await markScannerStepsComplete(runId, false);

  return {
    runId,
    pageExists: false,
    detectedUrl: null,
    ticketCreated: true,
  };
}

export async function runAiInfoScanBySlug(firmSlug: string): Promise<AiInfoScanResult> {
  const firm = await resolveFirm({ slug: firmSlug });
  return runAiInfoScan(firm.id);
}
