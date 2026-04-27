import {
  getDb,
  firms,
  aioCaptures,
  brandTruthVersions,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { eq, desc } from 'drizzle-orm';

/**
 * Google AI Overview panel capture (Phase B #7).
 *
 * The hard part of AIO. Google doesn't expose AI Overview content via
 * the public Search API. The available paths are:
 *
 *   1. Licensed SERP vendors that scrape on your behalf (DataForSEO,
 *      SerpAPI, Bright Data SERP API). Paid. Reliable. Hides the
 *      bot-detection mess.
 *   2. Self-hosted Playwright with residential proxies (Bright Data).
 *      Highest fidelity (you see EXACTLY what a real browser sees) but
 *      operationally heavy: ~$500/mo proxy costs, fragile selectors,
 *      ongoing CAPTCHA arms race.
 *   3. Direct Gemini API. Returns Gemini-the-model output. Useful but
 *      ≠ AIO-the-product-surface (different prompt, different ranking,
 *      different source picking).
 *
 * Per ADR-0009: DataForSEO is the primary AIO capture path. ADR-0010
 * specifies Bright Data residential proxies if/when we ever need
 * Playwright fallback. We hit Gemini directly for all the in-app
 * audit work because that captures the model behaviour, not the
 * product surface — but for "did Google's AIO surface mention us
 * for this query at this time?" we need DataForSEO.
 *
 * What this module ships
 * ----------------------
 * Adapter pattern with three providers:
 *   - DataForSEOAioProvider (real, paid; DATAFORSEO_LOGIN+PASSWORD env)
 *   - PlaywrightAioProvider (stub; throws "not yet implemented" until
 *     a Fly.io worker is provisioned per ADR-0010)
 *   - NullAioProvider (no-op fallback; reports has_aio=false)
 *
 * The adapter persists into `aio_capture` so the visibility tab can
 * diff captures over time and flag "AIO citation lost" / "AIO citation
 * gained" the same way `citation_diff` flags general LLM citation
 * drift.
 *
 * Cost note. DataForSEO AI Mode endpoint: ~$0.001-$0.005 per query.
 * For a 5-query firm with weekly capture: ~$0.10/firm/month.
 */

export interface AioSource {
  url: string;
  title?: string;
  domain?: string;
}

export interface AioCaptureResult {
  hasAio: boolean;
  overviewText: string | null;
  sources: AioSource[];
  // Raw provider response — preserved for debugging + future re-analysis.
  raw: unknown;
  provider: string;
}

export interface AioProvider {
  name: string;
  capture(args: { query: string; country?: string; language?: string }): Promise<
    | { ok: true; result: AioCaptureResult }
    | { ok: false; reason: string }
  >;
}

// ── DataForSEO ────────────────────────────────────────────────────────

interface DataForSEOAiOverviewResponse {
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    result?: Array<{
      items?: Array<{
        type?: string;
        text?: string;
        markdown?: string;
        rank_group?: number;
        rank_absolute?: number;
        position?: string;
        references?: Array<{
          url?: string;
          title?: string;
          source?: string;
          domain?: string;
        }>;
        // The AI overview block has its own shape.
        ai_overview?: {
          text?: string;
          references?: Array<{ url?: string; title?: string; domain?: string }>;
        };
      }>;
    }>;
  }>;
}

class DataForSEOAioProvider implements AioProvider {
  name = 'dataforseo';
  private login: string;
  private password: string;
  constructor(login: string, password: string) {
    this.login = login;
    this.password = password;
  }
  async capture(args: { query: string; country?: string; language?: string }) {
    const credentials = Buffer.from(`${this.login}:${this.password}`).toString('base64');
    const country = args.country ?? 'United States';
    const language = args.language ?? 'English';
    try {
      const res = await fetch(
        'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${credentials}`,
            'Content-Type': 'application/json',
          },
          // The 'advanced' endpoint includes AIO blocks when present;
          // the dedicated /ai_mode/ endpoint is for full Gemini-style
          // AI mode searches and can be wired here as a second pass
          // when richer AIO data is required.
          body: JSON.stringify([
            {
              keyword: args.query,
              location_name: country,
              language_name: language,
              depth: 10,
              calculate_rectangles: false,
            },
          ]),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          ok: false as const,
          reason: `dataforseo returned ${res.status}: ${body.slice(0, 200)}`,
        };
      }
      const json = (await res.json()) as DataForSEOAiOverviewResponse;
      const items = json.tasks?.[0]?.result?.[0]?.items ?? [];

      // Find the AI overview block. DataForSEO uses 'ai_overview' as
      // the type discriminator — historically also surfaces it under
      // 'people_also_ask' adjacent items, but the canonical shape is
      // a top-level item with type='ai_overview'.
      const aioItem = items.find(
        (i) =>
          i.type === 'ai_overview' ||
          (typeof i.type === 'string' && i.type.toLowerCase().includes('ai_overview')),
      );

      if (!aioItem) {
        return {
          ok: true as const,
          result: {
            hasAio: false,
            overviewText: null,
            sources: [],
            raw: json,
            provider: this.name,
          },
        };
      }

      const overviewText =
        aioItem.ai_overview?.text ??
        aioItem.markdown ??
        aioItem.text ??
        null;
      const refs = aioItem.ai_overview?.references ?? aioItem.references ?? [];
      const sources: AioSource[] = refs
        .filter((r): r is { url: string; title?: string; domain?: string } => !!r?.url)
        .map((r) => ({
          url: r.url,
          title: r.title,
          domain: r.domain ?? safeHost(r.url),
        }));

      return {
        ok: true as const,
        result: {
          hasAio: !!overviewText,
          overviewText,
          sources,
          raw: json,
          provider: this.name,
        },
      };
    } catch (e) {
      return {
        ok: false as const,
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

// ── Playwright stub ───────────────────────────────────────────────────

class PlaywrightAioProvider implements AioProvider {
  name = 'playwright';
  async capture(): Promise<{ ok: false; reason: string }> {
    return {
      ok: false,
      reason:
        'Playwright AIO capture not yet implemented — requires Fly.io worker + Bright Data residential proxies per ADR-0010',
    };
  }
}

// ── Null fallback ─────────────────────────────────────────────────────

class NullAioProvider implements AioProvider {
  name = 'none';
  async capture(): Promise<{ ok: false; reason: string }> {
    return { ok: false, reason: 'No AIO provider configured' };
  }
}

// ── Resolver ──────────────────────────────────────────────────────────

export function getAioProvider(): AioProvider {
  if (process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD) {
    return new DataForSEOAioProvider(
      process.env.DATAFORSEO_LOGIN,
      process.env.DATAFORSEO_PASSWORD,
    );
  }
  if (process.env.PLAYWRIGHT_AIO_WORKER_URL) {
    return new PlaywrightAioProvider();
  }
  return new NullAioProvider();
}

// ── Persistence + orchestration ───────────────────────────────────────

function safeHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Capture an AIO panel for a single (firm, query) pair, persist into
 * `aio_capture`. Uses the resolved provider; no-ops cleanly with a
 * `provider:'none'` row when no provider env is configured.
 *
 * Returns a slim result so the cron's per-firm summary stays tidy.
 */
export interface SingleCaptureOutcome {
  ok: boolean;
  hasAio: boolean;
  firmCited: boolean;
  sourceCount: number;
  reason?: string;
}

export async function captureAioForQuery(args: {
  firmId: string;
  query: string;
  country?: string;
  language?: string;
}): Promise<SingleCaptureOutcome> {
  const provider = getAioProvider();
  const db = getDb();

  // Resolve firm host from Brand Truth so we can compute firm_cited.
  const [btv] = await db
    .select({ payload: brandTruthVersions.payload })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, args.firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  const bt = (btv?.payload ?? null) as BrandTruth | null;
  const primaryUrl =
    (bt as { primary_url?: string } | null)?.primary_url ?? null;
  const firmHost = primaryUrl ? safeHost(primaryUrl) : null;

  const captured = await provider.capture({
    query: args.query,
    country: args.country,
    language: args.language,
  });

  if (!captured.ok) {
    // Persist the no-op so the operator can see we tried — different
    // from "didn't try" because the cron-health row reflects activity.
    await db.insert(aioCaptures).values({
      firm_id: args.firmId,
      query: args.query,
      provider: provider.name,
      country: args.country ?? null,
      language: args.language ?? null,
      has_aio: false,
      overview_text: null,
      sources: [],
      firm_cited: false,
      raw: { error: captured.reason } as Record<string, unknown>,
    });
    return { ok: false, hasAio: false, firmCited: false, sourceCount: 0, reason: captured.reason };
  }

  const r = captured.result;
  let firmCited = false;
  if (firmHost && r.sources.length > 0) {
    firmCited = r.sources.some((s) => s.domain && s.domain === firmHost);
  }

  await db.insert(aioCaptures).values({
    firm_id: args.firmId,
    query: args.query,
    provider: r.provider,
    country: args.country ?? null,
    language: args.language ?? null,
    has_aio: r.hasAio,
    overview_text: r.overviewText,
    sources: r.sources,
    firm_cited: firmCited,
    raw: r.raw as Record<string, unknown>,
  });

  return {
    ok: true,
    hasAio: r.hasAio,
    firmCited,
    sourceCount: r.sources.length,
  };
}

/** Capture top N seed queries for a firm. */
export interface BulkAioCaptureOutcome {
  attempted: number;
  hasAio: number;
  firmCited: number;
  errors: number;
  perQuery: Array<{ query: string; outcome: SingleCaptureOutcome }>;
}

export async function captureAioForFirm(
  firmId: string,
  options: { maxQueries?: number; country?: string; language?: string } = {},
): Promise<BulkAioCaptureOutcome> {
  const db = getDb();
  const [btv] = await db
    .select({ payload: brandTruthVersions.payload })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  const bt = (btv?.payload ?? null) as BrandTruth | null;
  const queries = (bt?.seed_query_intents ?? []).slice(
    0,
    Math.max(1, options.maxQueries ?? 5),
  );

  const perQuery: BulkAioCaptureOutcome['perQuery'] = [];
  let hasAio = 0;
  let firmCited = 0;
  let errors = 0;
  for (const q of queries) {
    const outcome = await captureAioForQuery({
      firmId,
      query: q,
      country: options.country,
      language: options.language,
    });
    perQuery.push({ query: q, outcome });
    if (outcome.ok && outcome.hasAio) hasAio += 1;
    if (outcome.firmCited) firmCited += 1;
    if (!outcome.ok) errors += 1;
  }
  return { attempted: queries.length, hasAio, firmCited, errors, perQuery };
}

/** Cross-workspace cron entry point. */
export async function captureAioForAllFirms(options: {
  maxQueries?: number;
  country?: string;
  language?: string;
} = {}): Promise<{
  firmsScanned: number;
  totalAttempted: number;
  totalHasAio: number;
  totalFirmCited: number;
  totalErrors: number;
}> {
  const db = getDb();
  const allFirms = await db.select({ id: firms.id }).from(firms);
  let totalAttempted = 0;
  let totalHasAio = 0;
  let totalFirmCited = 0;
  let totalErrors = 0;
  for (const f of allFirms) {
    const r = await captureAioForFirm(f.id, options);
    totalAttempted += r.attempted;
    totalHasAio += r.hasAio;
    totalFirmCited += r.firmCited;
    totalErrors += r.errors;
  }
  return {
    firmsScanned: allFirms.length,
    totalAttempted,
    totalHasAio,
    totalFirmCited,
    totalErrors,
  };
}

/** Read for the visibility-tab AIO panel. */
export async function listRecentAioCaptures(firmId: string, limit: number = 20): Promise<Array<{
  id: string;
  query: string;
  hasAio: boolean;
  firmCited: boolean;
  sourceCount: number;
  fetchedAt: Date;
  provider: string;
}>> {
  const db = getDb();
  const rows = await db
    .select()
    .from(aioCaptures)
    .where(eq(aioCaptures.firm_id, firmId))
    .orderBy(desc(aioCaptures.fetched_at))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    query: r.query,
    hasAio: r.has_aio,
    firmCited: r.firm_cited,
    sourceCount: (r.sources ?? []).length,
    fetchedAt: r.fetched_at,
    provider: r.provider,
  }));
}
