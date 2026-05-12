'use server';

/**
 * Phase 3 (Content Optimization) scanner triggers.
 *
 * Both scanners are read-only over the existing `pages` corpus (no
 * re-crawl) — the operator must run the Suppression scan first to
 * populate page content + embeddings. The "Run scan" button on the
 * Content Optimization phase page calls these.
 *
 * Each action returns either a structured result summary (counts,
 * ticket count) or an `{ error }` object. The phase-page-shell
 * surfaces the result inline in a toast; the actual remediation
 * tickets land in the execution-task list below the scan-controls
 * strip.
 *
 * Lifecycle is intentionally identical to runSuppressionScan: the
 * action is fire-and-await within the request, returns when finished,
 * and revalidates the phase page so the new execution tasks appear
 * without a refresh.
 */

import { revalidatePath } from 'next/cache';
import {
  runLlmFriendlyScanBySlug,
  type LlmFriendlyScanResult,
} from '../lib/content/llm-friendly-scanner';
import {
  runFreshnessScanBySlug,
  type FreshnessScanResult,
} from '../lib/content/freshness-scanner';

export type ContentScanKind = 'llm_friendly' | 'freshness' | 'both';

export interface ContentScanResponse {
  ok: true;
  llmFriendly?: LlmFriendlyScanResult;
  freshness?: FreshnessScanResult;
}
export interface ContentScanError {
  ok: false;
  error: string;
}

export async function runContentOptimizationScan(
  firmSlug: string,
  kind: ContentScanKind = 'both',
): Promise<ContentScanResponse | ContentScanError> {
  try {
    let llmFriendly: LlmFriendlyScanResult | undefined;
    let freshness: FreshnessScanResult | undefined;

    if (kind === 'llm_friendly' || kind === 'both') {
      llmFriendly = await runLlmFriendlyScanBySlug(firmSlug);
    }
    if (kind === 'freshness' || kind === 'both') {
      freshness = await runFreshnessScanBySlug(firmSlug);
    }

    // The phase page rendering pulls execution tasks via
    // getPhaseExecutionTasks — revalidate the route so the operator
    // sees the new tickets without a manual refresh.
    try {
      revalidatePath(`/dashboard/${firmSlug}/content-optimization`);
      revalidatePath(`/dashboard/${firmSlug}/action-items`);
    } catch {
      /* not in a Next request context — safe to ignore */
    }

    return { ok: true, llmFriendly, freshness };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
