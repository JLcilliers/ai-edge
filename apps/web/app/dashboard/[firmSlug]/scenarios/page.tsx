import { notFound } from 'next/navigation';
import {
  getScenarioOverview,
  listSerps,
  listScenarios,
  listPagesWithFeatures,
} from '../../../actions/scenarios-actions';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { ScenariosClient } from './scenarios-client';

export const dynamic = 'force-dynamic';
// Scenario-lab server actions (recrawlFeaturesViaHtml, runFirmCalibration,
// captureSerpsViaBing) iterate over every crawled page on the firm's site —
// 75+ pages × ~250ms politeness + per-page HTTP fetch routinely runs 2-3
// minutes. Without lifting maxDuration the function dies at Vercel's 60s
// default and the UI shows "nothing happened" because the transport error
// can't surface a clean error message.
export const maxDuration = 300;

/**
 * Scenario Lab — `/dashboard/[firmSlug]/scenarios`.
 *
 * Three tabs in one client shell:
 *   1. Scenarios   — list + create (the operator's daily surface)
 *   2. Calibration — current weights generation, fitness, run-calibration CTA
 *   3. SERPs       — observed-SERP corpus (paste-in for v1; live capture in Phase B)
 *
 * Per ADR-0006 / PLAN §5.7, this is a calibrated proxy ranker. The UI
 * surfaces that caveat prominently — `confidenceLabel` is shown on every
 * scenario row and the Calibration tab explains exactly what the fitness
 * score represents.
 */
export default async function ScenarioLabPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  // All four reads are independent — fan out in parallel. Each catches its
  // own error and degrades to a sensible empty default so a single broken
  // table doesn't blank the whole page.
  const [overview, serps, scenarios, pagesWithFeatures] = await Promise.all([
    getScenarioOverview(firmSlug).catch(() => ({
      firmSlug,
      firmName: firm.name,
      serpCount: 0,
      scenarioCount: 0,
      pageFeatureCount: 0,
      latestWeights: null,
      primaryUrl: null,
      seedQueries: [] as string[],
    })),
    listSerps(firmSlug).catch(() => []),
    listScenarios(firmSlug).catch(() => []),
    listPagesWithFeatures(firmSlug).catch(() => []),
  ]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Scenario Lab
        </h1>
        <p className="mt-2 text-white/55">
          Predict directional rank impact of a proposed content change before
          shipping it. Calibrated against this firm&apos;s observed SERPs via
          a 22-feature linear ranker + Particle Swarm Optimization.
        </p>
        <p className="mt-2 font-[family-name:var(--font-geist-mono)] text-[11px] text-white/40">
          Honest claim: directional, not absolute. Use Δrank to rank-order
          candidate changes — not to forecast literal SERP positions.
        </p>
      </div>

      <ScenariosClient
        overview={overview}
        serps={serps}
        scenarios={scenarios}
        pagesWithFeatures={pagesWithFeatures}
      />
    </div>
  );
}
