import { PhasePageShell } from '../_phase/phase-page-shell';

export const dynamic = 'force-dynamic';

export default async function ThirdPartyOptimizationPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  return <PhasePageShell firmSlug={firmSlug} phaseKey="third-party-optimization" />;
}
