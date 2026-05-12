'use server';

/**
 * Phase 3 (Content Optimization), Phase 5 (Technical Implementation),
 * and Phase 6 (Content Generation) scanner triggers.
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
import {
  runTrustAlignmentScanBySlug,
  type TrustScanResult,
} from '../lib/content/trust-scanner';
import {
  runThirdPartyTriageScanBySlug,
  type ThirdPartyTriageResult,
} from '../lib/content/third-party-scanner';
import {
  runWeeklyReportingScanBySlug,
  type WeeklyReportingScanResult,
} from '../lib/content/weekly-reporting-scanner';
import {
  runMeasurementTriageScanBySlug,
  type MeasurementTriageResult,
} from '../lib/content/measurement-scanner';
import {
  runRepositioningScanBySlug,
  type RepositioningScanResult,
} from '../lib/content/repositioning-scanner';
import {
  runAiInfoScanBySlug,
  type AiInfoScanResult,
} from '../lib/content/ai-info-scanner';
import {
  runCompetitiveScanBySlug,
  type CompetitiveScanResult,
} from '../lib/content/competitive-scanner';
import {
  runDeepResearchScanBySlug,
  type DeepResearchScanResult,
} from '../lib/content/deep-research-scanner';

export interface ContentScanResponse {
  ok: true;
  llmFriendly: LlmFriendlyScanResult;
  freshness: FreshnessScanResult;
  repositioning: RepositioningScanResult;
}
export interface ContentScanError {
  ok: false;
  error: string;
}

export async function runContentOptimizationScan(
  firmSlug: string,
): Promise<ContentScanResponse | ContentScanError> {
  try {
    // All three Phase 3 scanners run sequentially. Each is cheap
    // (read-only or single HEAD/GET sweep over already-crawled pages)
    // and they share the same underlying corpus so the network /
    // database overhead is amortized.
    const llmFriendly = await runLlmFriendlyScanBySlug(firmSlug);
    const freshness = await runFreshnessScanBySlug(firmSlug);
    const repositioning = await runRepositioningScanBySlug(firmSlug);

    try {
      revalidatePath(`/dashboard/${firmSlug}/content-optimization`);
      revalidatePath(`/dashboard/${firmSlug}/action-items`);
    } catch {
      /* not in a Next request context — safe to ignore */
    }

    return { ok: true, llmFriendly, freshness, repositioning };
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
  aiInfo: AiInfoScanResult;
}

export async function runTechnicalImplementationScan(
  firmSlug: string,
): Promise<TechnicalImplementationScanResponse | ContentScanError> {
  try {
    // Run all three Phase 5 scanners sequentially. semantic-html +
    // schema-markup each hit the network with concurrency 4 — running
    // them in parallel would double the firm site's connection load
    // without a wall-clock win big enough to matter. ai-info is a
    // cheap DB-only check that runs last.
    const semanticHtml = await runSemanticHtmlScanBySlug(firmSlug);
    const schemaMarkup = await runSchemaMarkupScanBySlug(firmSlug);
    const aiInfo = await runAiInfoScanBySlug(firmSlug);

    try {
      revalidatePath(`/dashboard/${firmSlug}/technical-implementation`);
      revalidatePath(`/dashboard/${firmSlug}/action-items`);
    } catch {
      /* not in a Next request context — safe to ignore */
    }

    return { ok: true, semanticHtml, schemaMarkup, aiInfo };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ThirdPartyScanResponse {
  ok: true;
  triage: ThirdPartyTriageResult;
}

export async function runThirdPartyOptimizationScan(
  firmSlug: string,
): Promise<ThirdPartyScanResponse | ContentScanError> {
  try {
    const triage = await runThirdPartyTriageScanBySlug(firmSlug);

    try {
      revalidatePath(`/dashboard/${firmSlug}/third-party-optimization`);
      revalidatePath(`/dashboard/${firmSlug}/action-items`);
    } catch {
      /* not in a Next request context — safe to ignore */
    }

    return { ok: true, triage };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface DeepResearchScanResponse {
  ok: true;
  result: DeepResearchScanResult;
}

/**
 * Deep Research Content Audit — opt-in, LLM-cost-bearing scanner.
 *
 * Kept on its own server action (not chained into
 * runContentOptimizationScan) because:
 *   1. It costs real money per run (~$0.05-$0.20).
 *   2. The SOP cadence is quarterly — chaining it into every scan
 *      would burn the budget faster than intended.
 *   3. The budget cap is per-firm-tier-configurable; explicit opt-in
 *      gives operators a clear "I'm spending money now" affordance.
 *
 * The scanner itself enforces the firm_budget.deep_research_quarterly_
 * cap_usd gate — it refuses to run and emits a manual-tier "Budget
 * cap reached" ticket when adding the estimated cost would exceed the
 * cap. So the explicit button is the UX layer; the budget gate is
 * the safety net.
 */
export async function runDeepResearchAudit(
  firmSlug: string,
): Promise<DeepResearchScanResponse | ContentScanError> {
  try {
    const result = await runDeepResearchScanBySlug(firmSlug);

    try {
      revalidatePath(`/dashboard/${firmSlug}/content-optimization`);
      revalidatePath(`/dashboard/${firmSlug}/action-items`);
      revalidatePath(`/dashboard/${firmSlug}/sop/deep_research_content_audit`);
    } catch {
      /* not in a Next request context — safe to ignore */
    }

    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface MeasurementScanResponse {
  ok: true;
  triage: MeasurementTriageResult;
}

export async function runMeasurementMonitoringScan(
  firmSlug: string,
): Promise<MeasurementScanResponse | ContentScanError> {
  try {
    const triage = await runMeasurementTriageScanBySlug(firmSlug);

    try {
      revalidatePath(`/dashboard/${firmSlug}/measurement-monitoring`);
      revalidatePath(`/dashboard/${firmSlug}/action-items`);
    } catch {
      /* not in a Next request context — safe to ignore */
    }

    return { ok: true, triage };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ClientServicesScanResponse {
  ok: true;
  weeklyReport: WeeklyReportingScanResult;
  competitive: CompetitiveScanResult;
}

export async function runClientServicesScan(
  firmSlug: string,
): Promise<ClientServicesScanResponse | ContentScanError> {
  try {
    // Weekly Reporting + Competitive LLM Monitoring share the
    // Client Services phase. Both read from existing data (no
    // re-crawl) and complete in seconds.
    const weeklyReport = await runWeeklyReportingScanBySlug(firmSlug);
    const competitive = await runCompetitiveScanBySlug(firmSlug);

    try {
      revalidatePath(`/dashboard/${firmSlug}/client-services`);
      revalidatePath(`/dashboard/${firmSlug}/action-items`);
      revalidatePath(`/dashboard/${firmSlug}/sop/weekly_aeo_reporting`);
      revalidatePath(`/dashboard/${firmSlug}/sop/competitive_llm_monitoring`);
    } catch {
      /* not in a Next request context — safe to ignore */
    }

    return { ok: true, weeklyReport, competitive };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ContentGenerationScanResponse {
  ok: true;
  trustAlignment: TrustScanResult;
}

export async function runContentGenerationScan(
  firmSlug: string,
): Promise<ContentGenerationScanResponse | ContentScanError> {
  try {
    const trustAlignment = await runTrustAlignmentScanBySlug(firmSlug);

    try {
      revalidatePath(`/dashboard/${firmSlug}/content-generation`);
      revalidatePath(`/dashboard/${firmSlug}/action-items`);
    } catch {
      /* not in a Next request context — safe to ignore */
    }

    return { ok: true, trustAlignment };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
