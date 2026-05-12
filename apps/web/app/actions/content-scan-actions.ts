'use server';

/**
 * Phase 3 (Content Optimization) + Phase 5 (Technical Implementation)
 * scanner triggers.
 *
 * Each scanner is a read-only-or-bounded-fetch pass over the firm's
 * `pages` corpus — the operator must run the Suppression scan first to
 * populate that corpus. The "Run scan" buttons on the Content
 * Optimization and Technical Implementation phase pages call these.
 *
 * Each action returns either a structured result summary (counts,
 * ticket count) or an `{ error }` object. The phase-page-shell
 * surfaces the result inline in a banner; the actual remediation
 * tickets land in the execution-task list below the scan-controls
 * strip.
 *
 * Lifecycle is fire-and-await within the request — the action returns
 * when finished and revalidates the phase route so the new execution
 * tasks appear without a manual refresh.
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
import {
  runSemanticHtmlScanBySlug,
  type SemanticHtmlScanResult,
} from '../lib/content/semantic-html-scanner';
import {
  runSchemaMarkupScanBySlug,
  type SchemaScanResult,
} from '../lib/content/schema-markup-scanner';

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

export interface TechnicalImplementationScanResponse {
  ok: true;
  semanticHtml: SemanticHtmlScanResult;
  schemaMarkup: SchemaScanResult;
}

export async function runTechnicalImplementationScan(
  firmSlug: string,
): Promise<TechnicalImplementationScanResponse | ContentScanError> {
  try {
    // Run both Phase 5 audit scanners sequentially. They each hit the
    // network with concurrency 4 — running them in parallel would
    // double the firm site's connection load without a wall-clock win
    // big enough to matter.
    const semanticHtml = await runSemanticHtmlScanBySlug(firmSlug);
    const schemaMarkup = await runSchemaMarkupScanBySlug(firmSlug);

    try {
      revalidatePath(`/dashboard/${firmSlug}/technical-implementation`);
      revalidatePath(`/dashboard/${firmSlug}/action-items`);
    } catch {
      /* not in a Next request context — safe to ignore */
    }

    return { ok: true, semanticHtml, schemaMarkup };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
