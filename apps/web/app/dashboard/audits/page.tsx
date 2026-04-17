import { getAuditRuns } from '../../actions/audit-actions';
import { AuditListClient } from './audit-list-client';

export const dynamic = 'force-dynamic';

export default async function AuditsPage() {
  const runs = await getAuditRuns().catch(() => []);

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Trust Alignment Audits
        </h1>
        <p className="mt-2 text-white/55">
          How LLMs actually describe you vs how you want to be described
        </p>
      </div>
      <AuditListClient initialRuns={runs} />
    </div>
  );
}
