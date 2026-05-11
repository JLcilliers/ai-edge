import {
  getDb,
  firms,
  serpSnapshots,
  serpResults,
  brandTruthVersions,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { eq, desc } from 'drizzle-orm';

/**
 * Live SERP capture via DataForSEO Google Organic SERP (Phase B #3).
 *
 * History. v1 of this module used Bing Web Search v7 because Microsoft
 * exposed it as a clean JSON API with a 1,000-query free tier. **Microsoft
 * retired the Bing Search API on August 11, 2025** (announced May 2025),
 * so that path no longer exists. We swapped to DataForSEO Google Organic
 * SERP — same `/v3/serp/google/organic/live/advanced` endpoint already
 * used by the AIO capture module — because:
 *
 *   1. The DataForSEO credentials are already provisioned and paid for
 *      (see ADR-0009 for AIO capture); reusing them avoids adding a new
 *      vendor purely for the calibration corpus.
 *   2. DataForSEO returns Google SERPs directly, which are a strictly
 *      better calibration target for a Scenario Lab that's modeling
 *      Google rank predictions than Bing-as-proxy ever was.
 *   3. The response includes both organic results and any AIO panel that
 *      rendered, so a single API call powers both the SERP snapshot and
 *      the AIO capture (the AIO module uses its own pass for now to keep
 *      concerns separate; we may unify later).
 *
 * Cost. DataForSEO organic SERP is roughly $0.0006/query for the live
 * advanced endpoint. 5 queries/firm/week × 4 weeks × 50 firms ≈ 1,000
 * queries/month ≈ $0.60/month. Well inside any reasonable budget cap.
 *
 * Auth. Set `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` (HTTP Basic).
 * The cron route is the only caller; gated keys → graceful no-op.
 *
 * Graceful no-op. If either credential is missing, every call returns
 * `{ ok: false, reason: 'DATAFORSEO credentials not set' }` and the
 * cron records "skipped: N" rather than failing. Tenants without
 * DataForSEO procurement still deploy cleanly.
 *
 * Provider discriminator stays at the `serp_snapshot.provider` level —
 * historical Bing rows remain queryable as `'bing-web-search'`; new
 * rows persist as `'dataforseo'`.
 */

const DATAFORSEO_ENDPOINT =
  'https://api.dataforseo.com/v3/serp/google/organic/live/advanced';

// Inbound types — only the shape we touch. DataForSEO returns dozens of
// fields per result; we keep the type narrow so we fail loudly if a
// breaking change in their API removes one of the four fields we depend on.
interface DataForSEOOrganicItem {
  type?: string;
  rank_group?: number;
  rank_absolute?: number;
  url?: string;
  title?: string;
  description?: string;
}

interface DataForSEOResponse {
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    result?: Array<{
      items_count?: number;
      items?: DataForSEOOrganicItem[];
    }>;
  }>;
}

export interface SerpCaptureSuccess {
  ok: true;
  snapshotId: string;
  resultCount: number;
}

export interface SerpCaptureSkipped {
  ok: false;
  reason: string;
}

export type SerpCaptureOutcome = SerpCaptureSuccess | SerpCaptureSkipped;

function safeHostFromUrl(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Capture a single Google SERP for (firmId, query). The caller decides
 * which queries to capture; this function is just the "fetch + persist"
 * unit. Returns the snapshot id + count on success, or a structured skip
 * reason on credential-missing / API-error.
 *
 * `location_name` / `language_name` follow DataForSEO's enum naming
 * ("United States" / "English"), not ISO codes. We persist the ISO-ish
 * pair on the snapshot row for downstream queries that want to filter
 * by region.
 */
export async function captureSerpViaDataForSEO(
  firmId: string,
  query: string,
  options: {
    count?: number;
    /** DataForSEO location_name, e.g. "United States". */
    locationName?: string;
    /** DataForSEO language_name, e.g. "English". */
    languageName?: string;
    /** ISO 3166-1 alpha-2, persisted on serp_snapshot.country. */
    countryCode?: string;
    /** IETF language tag, persisted on serp_snapshot.language. */
    languageCode?: string;
  } = {},
): Promise<SerpCaptureOutcome> {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    return { ok: false, reason: 'DATAFORSEO credentials not set' };
  }
  const count = Math.max(1, Math.min(100, options.count ?? 10));
  const locationName = options.locationName ?? 'United States';
  const languageName = options.languageName ?? 'English';
  const countryCode = options.countryCode ?? 'US';
  const languageCode = options.languageCode ?? 'en';

  // Resolve firm host so we can flag is_target on the firm's own URLs.
  const db = getDb();
  const [btv] = await db
    .select({ payload: brandTruthVersions.payload })
    .from(brandTruthVersions)
    .where(eq(brandTruthVersions.firm_id, firmId))
    .orderBy(desc(brandTruthVersions.version))
    .limit(1);
  const bt = (btv?.payload ?? null) as BrandTruth | null;
  const primaryUrl = (bt as { primary_url?: string } | null)?.primary_url ?? null;
  const firmHost = primaryUrl ? safeHostFromUrl(primaryUrl) : '';

  const credentials = Buffer.from(`${login}:${password}`).toString('base64');

  let json: DataForSEOResponse;
  try {
    const res = await fetch(DATAFORSEO_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ai-edge-serp-capture/0.2',
      },
      body: JSON.stringify([
        {
          keyword: query,
          location_name: locationName,
          language_name: languageName,
          depth: count,
          calculate_rectangles: false,
        },
      ]),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        reason: `dataforseo returned ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    json = (await res.json()) as DataForSEOResponse;
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  // DataForSEO returns a top-level status; per-task status lives at
  // tasks[i].status_code (20000 = success). Bail with a useful reason if
  // the task failed — saves us logging a parsed-but-empty snapshot.
  const task = json.tasks?.[0];
  if (task && task.status_code !== 20000) {
    return {
      ok: false,
      reason: `dataforseo task ${task.status_code}: ${task.status_message ?? 'unknown'}`,
    };
  }

  // Filter to organic results only — the items array also includes
  // featured_snippet, people_also_ask, related_searches, ai_overview, etc.
  // We only want organic rows for the calibration corpus; the AIO capture
  // module handles the ai_overview block separately.
  const items = task?.result?.[0]?.items ?? [];
  const organic = items
    .filter((it): it is DataForSEOOrganicItem & { url: string } =>
      it.type === 'organic' && typeof it.url === 'string' && it.url.length > 0,
    )
    .sort((a, b) => (a.rank_absolute ?? 9999) - (b.rank_absolute ?? 9999))
    .slice(0, count);

  if (organic.length === 0) {
    // Successful API hit but no organic results — persist an empty snapshot
    // so the operator can see we ran and Google simply had no matches
    // (or every position was an answer-box / featured-snippet that we
    // intentionally filtered out).
    const [snap] = await db
      .insert(serpSnapshots)
      .values({
        firm_id: firmId,
        query,
        provider: 'dataforseo',
        country: countryCode,
        language: languageCode,
        raw: json as unknown as Record<string, unknown>,
        notes: 'DataForSEO returned 0 organic items',
      })
      .returning({ id: serpSnapshots.id });
    return { ok: true, snapshotId: snap!.id, resultCount: 0 };
  }

  const [snap] = await db
    .insert(serpSnapshots)
    .values({
      firm_id: firmId,
      query,
      provider: 'dataforseo',
      country: countryCode,
      language: languageCode,
      raw: json as unknown as Record<string, unknown>,
    })
    .returning({ id: serpSnapshots.id });

  // We re-rank to 1..N rather than trusting `rank_absolute`, because
  // `rank_absolute` is the position on the SERP including answer boxes,
  // and we want consecutive 1..N positions in the snapshot for the
  // PSO-based ranker calibration.
  const rows = organic.map((r, i) => {
    const resultUrl = r.url;
    const host = safeHostFromUrl(resultUrl);
    return {
      snapshot_id: snap!.id,
      position: i + 1,
      url: resultUrl,
      domain: host,
      title: r.title ?? null,
      snippet: r.description ?? null,
      is_target: !!firmHost && host === firmHost,
    };
  });
  if (rows.length > 0) {
    await db.insert(serpResults).values(rows);
  }

  return {
    ok: true,
    snapshotId: snap!.id,
    resultCount: rows.length,
  };
}

/**
 * Backwards-compatible alias for the previous Bing-named function.
 *
 * Kept as a thin wrapper so any external caller (server action, script,
 * future cron) that imported the old name keeps working. The argument
 * shape is the closest legible mapping: `market="en-US"` is split to
 * `languageCode="en", countryCode="US"`, with the DataForSEO enum
 * names defaulted ("English" / "United States").
 *
 * Mark for removal once we're confident no caller imports the old name
 * (check via `grep -r captureSerpViaBing` before deleting).
 *
 * @deprecated use `captureSerpViaDataForSEO` directly.
 */
export async function captureSerpViaBing(
  firmId: string,
  query: string,
  options: { count?: number; market?: string } = {},
): Promise<SerpCaptureOutcome> {
  const market = options.market ?? 'en-US';
  const [lang, country] = market.split('-');
  return captureSerpViaDataForSEO(firmId, query, {
    count: options.count,
    languageCode: lang ?? 'en',
    countryCode: country ?? 'US',
  });
}

/**
 * Capture SERPs for multiple seed queries on a firm. Default behavior:
 * pull the firm's `seed_query_intents` from Brand Truth and capture the
 * top N (cap to keep per-run cost bounded — ~$0.0006/query on DataForSEO
 * but cron budgets are still finite).
 */
export interface BulkCaptureOptions {
  /** Override the queries to capture; default = Brand Truth seed_query_intents */
  queries?: string[];
  /** Max queries to capture per call (cron-budget-friendly default = 5). */
  maxQueries?: number;
  count?: number;
  /** DataForSEO location_name, e.g. "United States". */
  locationName?: string;
  /** DataForSEO language_name, e.g. "English". */
  languageName?: string;
}

export interface BulkCaptureOutcome {
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
  perQuery: Array<{ query: string; outcome: SerpCaptureOutcome }>;
}

export async function captureSerpsForFirm(
  firmId: string,
  options: BulkCaptureOptions = {},
): Promise<BulkCaptureOutcome> {
  const db = getDb();

  let queries = options.queries;
  if (!queries) {
    const [btv] = await db
      .select({ payload: brandTruthVersions.payload })
      .from(brandTruthVersions)
      .where(eq(brandTruthVersions.firm_id, firmId))
      .orderBy(desc(brandTruthVersions.version))
      .limit(1);
    const bt = (btv?.payload ?? null) as BrandTruth | null;
    queries = bt?.seed_query_intents ?? [];
  }
  const max = Math.max(1, options.maxQueries ?? 5);
  const subset = queries.slice(0, max);

  const perQuery: BulkCaptureOutcome['perQuery'] = [];
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  for (const q of subset) {
    const outcome = await captureSerpViaDataForSEO(firmId, q, {
      count: options.count,
      locationName: options.locationName,
      languageName: options.languageName,
    });
    perQuery.push({ query: q, outcome });
    if (outcome.ok) succeeded += 1;
    else if (outcome.reason === 'DATAFORSEO credentials not set') skipped += 1;
    else failed += 1;
  }

  return { attempted: subset.length, succeeded, skipped, failed, perQuery };
}

/**
 * Cron-style wrapper: capture SERPs for every firm in the workspace.
 * Used by /api/cron/serp-capture. Returns a summary suitable for the
 * cron observability log.
 */
export async function captureSerpsForAllFirms(
  options: BulkCaptureOptions = {},
): Promise<{
  firmsScanned: number;
  totalSucceeded: number;
  totalSkipped: number;
  totalFailed: number;
  perFirm: Array<{ slug: string; outcome: BulkCaptureOutcome }>;
}> {
  const db = getDb();
  const allFirms = await db
    .select({ id: firms.id, slug: firms.slug })
    .from(firms);
  const perFirm: Array<{ slug: string; outcome: BulkCaptureOutcome }> = [];
  let totalSucceeded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  for (const f of allFirms) {
    const outcome = await captureSerpsForFirm(f.id, options);
    perFirm.push({ slug: f.slug, outcome });
    totalSucceeded += outcome.succeeded;
    totalSkipped += outcome.skipped;
    totalFailed += outcome.failed;
  }
  return {
    firmsScanned: allFirms.length,
    totalSucceeded,
    totalSkipped,
    totalFailed,
    perFirm,
  };
}
