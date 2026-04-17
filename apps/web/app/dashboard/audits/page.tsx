import { getAuditRuns } from '../../actions/audit-actions';
import { AuditListClient } from './audit-list-client';

export const dynamic = 'force-dynamic';

export default async function AuditsPage() {
  const runs = await getAuditRuns().catch(() => []);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Trust Alignment Audits</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Run and review LLM alignment audits against your Brand Truth.
          </p>
        </div>
      </div>
      <AuditListClient initialRuns={runs} />
    </div>
  );
}
