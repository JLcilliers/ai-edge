import { createHash } from 'node:crypto';
import { getDb, queryResponseCache } from '@ai-edge/db';
import { and, eq, gt } from 'drizzle-orm';

/**
 * 24h response cache for deterministic LLM calls.
 *
 * The cache short-circuits *before* provider invocation, so a hit costs
 * one index lookup and pays $0 in API fees. Keys are sha256 over the full
 * (provider, model, system_prompt, user_prompt) tuple — changing any one
 * of those misses the cache and re-queries.
 *
 * This is intentionally cross-firm: two firms asking the same question of
 * the same model get the same answer, so they can share the row. Brand-
 * Truth-specific scoring happens downstream on the cached text and is
 * never cached.
 *
 * V1 TTL is 24h per PLAN §6. Extend via env `LLM_CACHE_TTL_HOURS`.
 */

function cacheTtlMs(): number {
  const hours = Number.parseFloat(process.env.LLM_CACHE_TTL_HOURS ?? '24');
  const safe = Number.isFinite(hours) && hours > 0 ? hours : 24;
  return safe * 60 * 60 * 1000;
}

export interface CacheKeyParts {
  provider: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

export function buildCacheKey(parts: CacheKeyParts): string {
  const normalized = JSON.stringify({
    p: parts.provider,
    m: parts.model,
    s: parts.systemPrompt,
    u: parts.userPrompt,
  });
  return createHash('sha256').update(normalized).digest('hex');
}

export interface CachedResponse {
  provider: string;
  model: string;
  response_text: string;
  raw_response: unknown;
  latency_ms: number | null;
  cost_usd: number | null;
}

/** Return the cached response if still fresh; otherwise null. */
export async function getCachedResponse(
  cacheKey: string,
): Promise<CachedResponse | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(queryResponseCache)
    .where(and(
      eq(queryResponseCache.cache_key, cacheKey),
      gt(queryResponseCache.expires_at, new Date()),
    ))
    .limit(1);
  if (!row) return null;
  return {
    provider: row.provider,
    model: row.model,
    response_text: row.response_text,
    raw_response: row.raw_response,
    latency_ms: row.latency_ms,
    cost_usd: row.cost_usd,
  };
}

export interface CachePutParams {
  cacheKey: string;
  provider: string;
  model: string;
  responseText: string;
  rawResponse: unknown;
  latencyMs: number | null;
  costUsd: number | null;
}

/**
 * Write-through cache. Upserts on primary key so a re-run within the TTL
 * overwrites the prior entry (if it somehow existed) rather than erroring.
 * For neon-http's limited onConflict support we do two-step insert/update.
 */
export async function putCachedResponse(params: CachePutParams): Promise<void> {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + cacheTtlMs());

  const [existing] = await db
    .select({ cache_key: queryResponseCache.cache_key })
    .from(queryResponseCache)
    .where(eq(queryResponseCache.cache_key, params.cacheKey))
    .limit(1);

  if (existing) {
    await db
      .update(queryResponseCache)
      .set({
        provider: params.provider,
        model: params.model,
        response_text: params.responseText,
        raw_response: params.rawResponse as never,
        latency_ms: params.latencyMs,
        cost_usd: params.costUsd,
        created_at: now,
        expires_at: expiresAt,
      })
      .where(eq(queryResponseCache.cache_key, params.cacheKey));
    return;
  }

  await db.insert(queryResponseCache).values({
    cache_key: params.cacheKey,
    provider: params.provider,
    model: params.model,
    response_text: params.responseText,
    raw_response: params.rawResponse as never,
    latency_ms: params.latencyMs,
    cost_usd: params.costUsd,
    created_at: now,
    expires_at: expiresAt,
  });
}
