/**
 * Semantic HTML Optimization scanner — Phase 5 SOP
 * `semantic_html_optimization`.
 *
 * Unlike LLM-Friendly + Freshness (which read existing page rows), this
 * scanner needs the *raw HTML* of each page — the rubric counts tags
 * the suppression extractor strips out. So it fetches each page fresh
 * (concurrency 4, max 100 pages per run, 10s timeout), scores against
 * the 7-criterion rubric, and emits assist-tier tickets for pages
 * scoring < 70.
 *
 * The fetch is bounded — we read up to 256KB of body per page (typical
 * pages are 50-200KB), enough to capture all body markup while avoiding
 * pulling multi-MB pages. This is acceptable v1 because the rubric only
 * needs tag presence + heading sequence, both of which appear in the
 * first 256KB of any realistic page.
 *
 * Lifecycle matches the other Phase 3 scanners — idempotent over
 * (firm × SOP), clears prior open tickets on re-run, leaves
 * status=awaiting_input.
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
import {
  scoreSemanticHtml,
  TICKET_THRESHOLD,
  type SemanticPageScore,
  type SemanticCriterionResult,
} from './semantic-html-rubric';

const SOP_KEY = 'semantic_html_optimization' as const;
// Tickets attach to step 1 (Audit Current HTML Structure) — that's the
// "scan + rank" step. The remaining steps (implementation work) are
// what the tickets are *for*.
const TICKET_STEP_NUMBER = 1;
const MAX_PAGES_PER_RUN = 100;
const FETCH_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;

export interface SemanticHtmlScanResult {
  runId: string;
  pagesScanned: number;
  pagesNeedingWork: number;
  ticketsCreated: number;
  averageScore: number;
  bandCounts: {
    high: number;
    medium: number;
    low: number;
    maintenance: number;
  };
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

/**
 * Bounded GET. Reads up to MAX_BODY_BYTES of body, then cancels the
 * stream. Returns null on any failure — the scanner skips failing
 * pages rather than aborting the whole run.
 */
async function fetchHtmlBounded(url: string): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        // Some servers refuse anonymous fetches. Identify ourselves.
        'User-Agent': 'ClixsyAEOScanner/1.0 (+semantic-html-scan; bounded read)',
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
      created_by: 'scanner:semantic-html',
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
  const def = getSopDefinition(SOP_KEY);

  for (const step of def.steps) {
    const targetStatus = step.number <= TICKET_STEP_NUMBER ? 'completed' : 'not_started';
    await db
      .update(sopStepStates)
      .set({
        status: targetStatus,
        started_at: targetStatus === 'completed' ? now : null,
        completed_at: targetStatus === 'completed' ? now : null,
      })
      .where(
        and(eq(sopStepStates.sop_run_id, runId), eq(sopStepStates.step_number, step.number)),
      );
  }

  // Step 2 (Apply Document Structure) is the operator's next step — the
  // tickets emitted at step 1 are the input to step 2's work. Status
  // stays awaiting_input.
  await db
    .update(sopRuns)
    .set({
      current_step: TICKET_STEP_NUMBER + 1,
      status: 'awaiting_input',
      started_at: now,
    })
    .where(eq(sopRuns.id, runId));
}

const BAND_LABEL: Record<SemanticPageScore['band'], string> = {
  high: 'High priority',
  medium: 'Medium priority',
  low: 'Low priority',
  maintenance: 'Maintenance',
};

function buildTicketPayload(score: SemanticPageScore): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  const weak = score.criteria
    .filter((c) => c.score < c.max)
    .sort((a, b) => b.max - a.max); // tackle the highest-weighted gaps first

  const title = `Semantic HTML: ${BAND_LABEL[score.band]} (${score.total}/100) — ${score.url}`;

  const description =
    `Page scored ${score.total}/100 on the Semantic HTML rubric.\n\n` +
    `URL: ${score.url}\n` +
    `Priority band: ${BAND_LABEL[score.band]}\n\n` +
    `Score breakdown:\n` +
    score.criteria
      .map((c) => `- ${c.label}: ${c.score}/${c.max}`)
      .join('\n');

  const remediationCopy =
    `**Page:** ${score.url}\n\n` +
    `**Score:** ${score.total}/100 (target: ≥ ${TICKET_THRESHOLD + 10})\n\n` +
    `**Fix order — tackle highest-weight gaps first:**\n\n` +
    weak
      .map(
        (c, i) =>
          `${i + 1}. **${c.label}** — ${c.score}/${c.max} pts\n   ↳ ${c.detail}\n   ↳ ${FIX_HINT[c.key]}`,
      )
      .join('\n\n');

  const validationSteps: Array<{ description: string }> = [
    { description: 'Implement the highest-weighted gaps in the page template / CMS' },
    { description: 'Validate at https://validator.w3.org — no errors' },
    { description: 'Re-run Semantic HTML Optimization scan' },
    { description: `Score lifts to ≥ ${TICKET_THRESHOLD + 10}/100 before resolving` },
  ];

  return { title, description, remediationCopy, validationSteps };
}

/** Concrete next-step guidance per criterion. One line each. */
const FIX_HINT: Record<SemanticCriterionResult['key'], string> = {
  document_structure:
    'In the page template: replace the outer <div> wrapping primary content with <main>; wrap each topic block in <article> or <section>.',
  definition_lists:
    'Convert "<strong>Term</strong> — Definition" patterns into <dl><dt>Term</dt><dd>Definition</dd></dl>. Highest LLM-extraction signal in the rubric.',
  semantic_text:
    'Find/replace <b>→<strong>, <i>→<em> in the page content. <b>/<i> are styling, not semantics — LLMs ignore the emphasis weight.',
  heading_hierarchy:
    'Ensure exactly one <h1> per page and that depth increases by 1 each step (no H1 → H3 skips).',
  figures: 'Wrap each meaningful <img> in <figure>...<figcaption>caption</figcaption></figure>.',
  sectioning: 'Add <header> for the page intro, <footer> for the page close, <aside> for sidebars/callouts.',
  semantic_tables: 'Replace flat <table><tr><td>... with <table><thead><tr><th>...</th></tr></thead><tbody>... so header rows are unambiguous.',
};

/**
 * Concurrency-limited fetch of every URL. Returns a map of url → html.
 * Failed fetches are absent from the map (caller treats absence as
 * "skip and don't score").
 */
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

/** Main entry point. Idempotent over (firm × scanner). */
export async function runSemanticHtmlScan(firmId: string): Promise<SemanticHtmlScanResult> {
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

  const scores: SemanticPageScore[] = [];
  for (const r of rows) {
    const html = htmlMap.get(r.url);
    if (!html) continue;
    scores.push(scoreSemanticHtml(r.url, html));
  }

  if (scores.length === 0) {
    throw new Error('Every page fetch failed — verify the firm site is reachable and try again.');
  }

  const runId = await findOrCreateScannerRun(firm.id);
  await clearPriorOpenTickets(firm.id, runId);

  const failing = scores
    .filter((s) => s.total < TICKET_THRESHOLD)
    .sort((a, b) => a.total - b.total);

  let priorityRank = 1;
  let ticketsCreated = 0;
  for (const score of failing) {
    const payload = buildTicketPayload(score);
    await createTicketFromStep({
      firmSlug: firm.slug,
      sopKey: SOP_KEY,
      runId,
      stepNumber: TICKET_STEP_NUMBER,
      title: payload.title,
      description: payload.description,
      priorityRank: priorityRank++,
      remediationCopy: payload.remediationCopy,
      validationSteps: payload.validationSteps,
      evidenceLinks: [
        {
          kind: 'page_url',
          url: score.url,
          description: `Scored ${score.total}/100 — ${BAND_LABEL[score.band]}`,
        },
      ],
      automationTier: 'assist',
      executeUrl: score.url,
      executeLabel: 'Open page',
    });
    ticketsCreated += 1;
  }

  await markScannerStepComplete(runId);

  const total = scores.reduce((acc, s) => acc + s.total, 0);
  const bandCounts = {
    high: scores.filter((s) => s.band === 'high').length,
    medium: scores.filter((s) => s.band === 'medium').length,
    low: scores.filter((s) => s.band === 'low').length,
    maintenance: scores.filter((s) => s.band === 'maintenance').length,
  };
  return {
    runId,
    pagesScanned: scores.length,
    pagesNeedingWork: failing.length,
    ticketsCreated,
    averageScore: scores.length ? Math.round(total / scores.length) : 0,
    bandCounts,
  };
}

export async function runSemanticHtmlScanBySlug(
  firmSlug: string,
): Promise<SemanticHtmlScanResult> {
  const firm = await resolveFirm({ slug: firmSlug });
  return runSemanticHtmlScan(firm.id);
}
