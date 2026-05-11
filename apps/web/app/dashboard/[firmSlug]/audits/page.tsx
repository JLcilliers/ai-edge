import { notFound } from 'next/navigation';
import { getAuditRuns } from '../../../actions/audit-actions';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { getFirmBudgetStatus } from '../../../lib/audit/budget';
import { AuditListClient } from './audit-list-client';

export const dynamic = 'force-dynamic';
// `startAudit` runs a full audit fan-out (3-20 queries × 2-4 providers × k=3)
// which can take 60-120s. Without this, the server action inherits the
// default 60s timeout and silently fails for any non-trivial run.
export const maxDuration = 300;

export default async function AuditsPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  // Fetch runs + budget in parallel — both are read-only server-side reads
  // and serializing them would just add a round-trip for no benefit. Budget
  // is rendered as context above the Run Audit button so operators see
  // their current-month spend before clicking (matches the server-side
  // gate in startAudit — batch 15 — so the disabled state lines up).
  const [runs, budget] = await Promise.all([
    getAuditRuns(firmSlug).catch(() => []),
    getFirmBudgetStatus(firm.id).catch(() => null),
  ]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Trust Alignment Audits
        </h1>
        <p className="mt-2 text-white/55">
          How LLMs actually describe {firm.name} vs how you want them to
        </p>
      </div>
      <AuditListClient firmSlug={firmSlug} initialRuns={runs} budget={budget} />
    </div>
  );
}
