/**
 * Content Freshness Audit scanner.
 *
 * Phase 3 SOP `content_freshness_audit` — finds pages that LLMs are
 * likely to deprioritize because they're stale. Steve Toth's data point:
 * "content less than 12 months old is favored by LLMs." We translate
 * that into a three-bucket scoring system:
 *
 *   < 6 months   → fresh, no ticket
 *   6-12 months  → aging, low-priority ticket ("watch")
 *   12-24 months → stale, medium-priority ticket
 *   > 24 months  → dormant, high-priority ticket
 *
 * Source of truth for "how old":
 *   1. HEAD request to the page → `Last-Modified` header if the server
 *      returns one.
 *   2. Fall back to a parsed `<meta property="article:modified_time">`
 *      or schema.org `dateModified` on a tiny GET if the HEAD didn't
 *      give us a date.
 *   3. As a last resort, use `page.fetched_at` minus a constant — we
 *      don't have crawl history, so a page with no published-date
 *      signal is treated as "age unknown" rather than guessing.
 *
 * We scan up to MAX_PAGES per run and run HEAD requests with a small
 * concurrency. The whole pass is dominated by the upstream site's
 * latency, not local CPU. Failures (timeouts, 4xx, 5xx) are logged but
 * skipped — one broken page shouldn't fail the audit.
 *
 * Lifecycle parallels llm-friendly-scanner.ts: idempotent over (firm ×
 * scanner), reuses the same sop_run row, clears prior open tickets on
 * re-run.
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

const SOP_KEY = 'content_freshness_audit' as const;
// Tickets attach to the synthesis step (Prioritize for Refresh).
const TICKET_STEP_NUMBER = 3;
const MAX_PAGES_PER_RUN = 150;
const HEAD_CONCURRENCY = 4;
const HEAD_TIMEOUT_MS = 8_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const SIX_MONTHS_MS = 183 * DAY_MS;
const TWELVE_MONTHS_MS = 365 * DAY_MS;
const TWENTY_FOUR_MONTHS_MS = 730 * DAY_MS;

export type FreshnessTier = 'fresh' | 'aging' | 'stale' | 'dormant' | 'unknown';

export interface FreshnessFinding {
  url: string;
  title: string | null;
  lastModified: Date | null;
  ageDays: number | null;
  tier: FreshnessTier;
  source: 'last_modified_header' | 'meta_tag' | 'schema_dateModified' | 'unknown';
}

export interface FreshnessScanResult {
  runId: string;
  pagesScanned: number;
  fresh: number;
  aging: number;
  stale: number;
  dormant: number;
  unknown: number;
  ticketsCreated: number;
}

interface FirmRow {
  id: string;
  slug: string;
  name: string;
}

async function resolveFirm(firmIdOrSlug: { id?: string; slug?: string }): Promise<FirmRow> {
  const db = getDb();
  if (firmIdOrSlug.id) {
    const [f] = await db
      .select({ id: firms.id, slug: firms.slug, name: firms.name })
      .from(firms)
      .where(eq(firms.id, firmIdOrSlug.id))
      .limit(1);
    if (!f) throw new Error(`Firm not found: ${firmIdOrSlug.id}`);
    return f;
  }
  if (firmIdOrSlug.slug) {
    const [f] = await db
      .select({ id: firms.id, slug: firms.slug, name: firms.name })
      .from(firms)
      .where(eq(firms.slug, firmIdOrSlug.slug))
      .limit(1);
    if (!f) throw new Error(`Firm not found: ${firmIdOrSlug.slug}`);
    return f;
  }
  throw new Error('resolveFirm: id or slug required');
}

/**
 * Convert a Last-Modified header value or meta-tag string into a Date.
 * Returns null on parse failure.
 */
function parseHttpDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  // Sanity check — anything before 2000 or after now+1 day is garbage.
  const t = d.getTime();
  const now = Date.now();
  if (t < new Date('2000-01-01').getTime() || t > now + DAY_MS) return null;
  return d;
}

/**
 * Run a fetch under an independent AbortController + timeout. Returns
 * the Response or null on any failure (timeout, network error, refusal).
 *
 * Why per-request: previously HEAD + GET shared one AbortController, so a
 * HEAD timeout aborted the subsequent GET via the now-fired signal. Pages
 * with slow HEAD (or HEAD-refusing servers that still serve GET fine)
 * silently fell through to "unknown" age even though their Last-Modified
 * header was on the GET response.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HEAD_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal, redirect: 'follow' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try a HEAD request first; fall back to a tiny GET if the server
 * returns no Last-Modified or refuses HEAD entirely. We don't read more
 * than 32KB of HTML on the fallback — enough to capture <head>.
 *
 * HEAD and GET each run under their own AbortController + timer so a
 * slow HEAD doesn't poison the GET attempt.
 */
async function fetchLastModified(url: string): Promise<{
  date: Date | null;
  source: FreshnessFinding['source'];
}> {
  // HEAD first.
  const head = await fetchWithTimeout(url, { method: 'HEAD' });
  if (head) {
    const lm = parseHttpDate(head.headers.get('last-modified'));
    if (lm) return { date: lm, source: 'last_modified_header' };
  }

  // Small GET — bounded by an explicit byte read so we don't pull the
  // whole page. We use a streaming reader instead of `await res.text()`
  // because some servers respond with multi-megabyte bodies.
  const res = await fetchWithTimeout(url, { method: 'GET' });
  if (!res || !res.ok) return { date: null, source: 'unknown' };

  const lm = parseHttpDate(res.headers.get('last-modified'));
  if (lm) return { date: lm, source: 'last_modified_header' };

  const reader = res.body?.getReader();
  if (!reader) return { date: null, source: 'unknown' };

  const dec = new TextDecoder();
  let html = '';
  const maxBytes = 32_768;
  let read = 0;
  try {
    while (read < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      read += value.byteLength;
    }
  } catch {
    /* mid-read failure — fall through with whatever we managed to read */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* harmless */
    }
  }

  // article:modified_time / og:updated_time meta tag.
  const metaMatch =
    /<meta\s+[^>]*property=["'](?:article:modified_time|og:updated_time)["'][^>]*content=["']([^"']+)["']/i.exec(
      html,
    ) ??
    /<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["'](?:article:modified_time|og:updated_time)["']/i.exec(
      html,
    );
  if (metaMatch && metaMatch[1]) {
    const d = parseHttpDate(metaMatch[1]);
    if (d) return { date: d, source: 'meta_tag' };
  }

  // schema.org dateModified inside any JSON-LD <script>.
  const jsonLdMatches = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  if (jsonLdMatches) {
    for (const block of jsonLdMatches) {
      const inner = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
      if (!inner) continue;
      try {
        const parsed = JSON.parse(inner) as unknown;
        const date = findDateModified(parsed);
        if (date) {
          const d = parseHttpDate(date);
          if (d) return { date: d, source: 'schema_dateModified' };
        }
      } catch {
        /* malformed JSON-LD; skip */
      }
    }
  }

  return { date: null, source: 'unknown' };
}

/**
 * Walk a parsed JSON-LD payload looking for `dateModified`. Schema-org
 * blocks come in many shapes (single object, @graph array, nested
 * mainEntity, etc.) — we just dig recursively until we find a string
 * at that key.
 */
function findDateModified(node: unknown): string | null {
  if (!node) return null;
  if (typeof node === 'string') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findDateModified(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.dateModified === 'string') return obj.dateModified;
    for (const v of Object.values(obj)) {
      const found = findDateModified(v);
      if (found) return found;
    }
  }
  return null;
}

function classify(ageMs: number | null): FreshnessTier {
  if (ageMs == null) return 'unknown';
  if (ageMs < SIX_MONTHS_MS) return 'fresh';
  if (ageMs < TWELVE_MONTHS_MS) return 'aging';
  if (ageMs < TWENTY_FOUR_MONTHS_MS) return 'stale';
  return 'dormant';
}

const TIER_PRIORITY: Record<FreshnessTier, number> = {
  dormant: 1,
  stale: 2,
  aging: 3,
  unknown: 4,
  fresh: 99, // doesn't emit a ticket, but a value for type safety
};

const TIER_LABEL: Record<FreshnessTier, string> = {
  fresh: 'Fresh',
  aging: 'Aging',
  stale: 'Stale',
  dormant: 'Dormant',
  unknown: 'Age unknown',
};

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
      created_by: 'scanner:freshness',
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

async function markScannerStepsComplete(runId: string): Promise<void> {
  const db = getDb();
  const now = new Date();
  const def = getSopDefinition(SOP_KEY);

  for (const step of def.steps) {
    const targetStatus = step.number <= TICKET_STEP_NUMBER ? 'completed' : 'in_progress';
    await db
      .update(sopStepStates)
      .set({
        status: targetStatus,
        started_at: now,
        completed_at: targetStatus === 'completed' ? now : null,
      })
      .where(
        and(eq(sopStepStates.sop_run_id, runId), eq(sopStepStates.step_number, step.number)),
      );
  }

  // Schedule the next quarterly review per the SOP cadence (90 days).
  const def2 = getSopDefinition(SOP_KEY);
  const nextReviewAt =
    typeof def2.cadence === 'object'
      ? new Date(Date.now() + def2.cadence.intervalDays * DAY_MS)
      : null;

  // For scanner-managed SOPs we use started_at as "last scan started"
  // (see llm-friendly-scanner.ts for the same rationale).
  await db
    .update(sopRuns)
    .set({
      current_step: TICKET_STEP_NUMBER + 1,
      status: 'awaiting_input',
      next_review_at: nextReviewAt,
      started_at: now,
    })
    .where(eq(sopRuns.id, runId));
}

function buildTicketPayload(f: FreshnessFinding): {
  title: string;
  description: string;
  remediationCopy: string;
  validationSteps: Array<{ description: string }>;
} {
  const ageLabel =
    f.ageDays != null
      ? `${f.ageDays} day${f.ageDays === 1 ? '' : 's'} old`
      : 'age unknown';
  const sourceLabel =
    f.source === 'last_modified_header'
      ? 'HTTP Last-Modified header'
      : f.source === 'meta_tag'
        ? 'article:modified_time meta tag'
        : f.source === 'schema_dateModified'
          ? 'schema.org dateModified'
          : 'no date signal — neither header, meta tag, nor schema dateModified was present';

  const title = `${TIER_LABEL[f.tier]}: refresh ${f.title?.trim() || f.url}`;

  const description =
    `Page is ${ageLabel}.\n\n` +
    `URL: ${f.url}\n` +
    `Last modified: ${f.lastModified?.toISOString() ?? 'unknown'}\n` +
    `Detection source: ${sourceLabel}\n\n` +
    `LLMs preferentially cite content less than 12 months old. ${
      f.tier === 'dormant'
        ? 'This page has crossed the 24-month dormancy threshold — citation chances are minimal until refreshed.'
        : f.tier === 'stale'
          ? 'Past the 12-month freshness window — citation rates measurably decline beyond this point.'
          : f.tier === 'aging'
            ? 'Approaching the 12-month threshold — refresh before LLMs decay the page out of their preference window.'
            : 'No published-date signal makes LLMs treat the page as ambient/timeless content — adding a modified date increases pickup.'
    }`;

  const remediationCopy =
    f.tier === 'unknown'
      ? `**Page:** ${f.url}\n\n**Why it's flagged:** Neither the HTTP Last-Modified header, the article:modified_time meta tag, nor schema.org dateModified is present. LLMs use these signals to decide freshness — without them, the page reads as ambient/timeless and gets de-prioritized for time-sensitive queries.\n\n**Fix:**\n\n1. Add an OpenGraph article:modified_time meta tag in <head>:\n   \`<meta property="article:modified_time" content="${new Date().toISOString()}" />\`\n2. Or add schema.org Article/BlogPosting JSON-LD with a dateModified field.\n3. Configure your CMS / hosting to emit a Last-Modified HTTP header.`
      : `**Page:** ${f.url}\n\n**Age:** ${ageLabel}\n**Last modified:** ${f.lastModified?.toISOString().slice(0, 10) ?? 'unknown'}\n\n**Refresh checklist:**\n\n1. Review the page against the current Brand Truth — is positioning still correct?\n2. Update statistics, dates, and named entities with the most recent figures.\n3. Add at least one new section reflecting changes in the last 12 months (new case studies, new regulations, new product features).\n4. Update the page's Last-Modified date in your CMS so the freshness signal propagates.\n5. Re-submit the URL via GSC → URL Inspection → Request Indexing.\n6. Verify the Last-Modified HTTP header reflects today's date after deploy.`;

  const validationSteps: Array<{ description: string }> = [
    { description: 'Apply refresh changes in CMS' },
    { description: 'Verify Last-Modified HTTP header reflects today' },
    { description: 'Request re-indexing via GSC' },
    { description: 'Re-run Content Freshness scan' },
  ];

  return { title, description, remediationCopy, validationSteps };
}

/**
 * Concurrency-limited HEAD/GET sweep. Returns the same order as input.
 */
async function fetchAllLastModified(
  urls: string[],
): Promise<Map<string, { date: Date | null; source: FreshnessFinding['source'] }>> {
  const result = new Map<string, { date: Date | null; source: FreshnessFinding['source'] }>();
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < HEAD_CONCURRENCY; w++) {
    workers.push(
      (async () => {
        while (cursor < urls.length) {
          const i = cursor++;
          const url = urls[i]!;
          try {
            const r = await fetchLastModified(url);
            result.set(url, r);
          } catch {
            result.set(url, { date: null, source: 'unknown' });
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  return result;
}

/**
 * Main entry point. Idempotent over (firm × scanner).
 */
export async function runFreshnessScan(firmId: string): Promise<FreshnessScanResult> {
  const db = getDb();
  const firm = await resolveFirm({ id: firmId });

  // Load up to MAX_PAGES_PER_RUN pages. We sort by fetched_at DESC so
  // re-runs hit the freshly-crawled pages first — that way a partial
  // run still gives the operator useful signal.
  const rows = await db
    .select({
      url: pages.url,
      title: pages.title,
      fetchedAt: pages.fetched_at,
    })
    .from(pages)
    .where(eq(pages.firm_id, firm.id))
    .orderBy(desc(pages.fetched_at))
    .limit(MAX_PAGES_PER_RUN);

  if (rows.length === 0) {
    throw new Error('No crawled pages found — run the Suppression scan first to populate the page corpus.');
  }

  // HEAD-fetch every URL.
  const lastModifiedMap = await fetchAllLastModified(rows.map((r) => r.url));

  const now = Date.now();
  const findings: FreshnessFinding[] = rows.map((r) => {
    const lm = lastModifiedMap.get(r.url) ?? { date: null, source: 'unknown' as const };
    const ageMs = lm.date ? now - lm.date.getTime() : null;
    const tier = classify(ageMs);
    const ageDays = ageMs != null ? Math.floor(ageMs / DAY_MS) : null;
    return {
      url: r.url,
      title: r.title,
      lastModified: lm.date,
      ageDays,
      tier,
      source: lm.source,
    };
  });

  // Bucket counts (for the result summary).
  const counts: Record<FreshnessTier, number> = {
    fresh: 0,
    aging: 0,
    stale: 0,
    dormant: 0,
    unknown: 0,
  };
  for (const f of findings) counts[f.tier] += 1;

  // Run + ticket lifecycle.
  const runId = await findOrCreateScannerRun(firm.id);
  await clearPriorOpenTickets(firm.id, runId);

  // Emit tickets for every non-fresh page. Sort by tier priority then age.
  const failing = findings
    .filter((f) => f.tier !== 'fresh')
    .sort((a, b) => {
      const tp = TIER_PRIORITY[a.tier] - TIER_PRIORITY[b.tier];
      if (tp !== 0) return tp;
      return (b.ageDays ?? 0) - (a.ageDays ?? 0);
    });

  let priorityRank = 1;
  let ticketsCreated = 0;
  for (const finding of failing) {
    const payload = buildTicketPayload(finding);
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
          url: finding.url,
          description:
            finding.ageDays != null
              ? `${TIER_LABEL[finding.tier]} (${finding.ageDays} days old)`
              : TIER_LABEL[finding.tier],
        },
      ],
      automationTier: 'assist',
      executeUrl: finding.url,
      executeLabel: 'Open page',
    });
    ticketsCreated += 1;
  }

  await markScannerStepsComplete(runId);

  return {
    runId,
    pagesScanned: findings.length,
    fresh: counts.fresh,
    aging: counts.aging,
    stale: counts.stale,
    dormant: counts.dormant,
    unknown: counts.unknown,
    ticketsCreated,
  };
}

export async function runFreshnessScanBySlug(firmSlug: string): Promise<FreshnessScanResult> {
  const firm = await resolveFirm({ slug: firmSlug });
  return runFreshnessScan(firm.id);
}
