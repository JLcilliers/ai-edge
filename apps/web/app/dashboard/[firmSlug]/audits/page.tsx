import { notFound } from 'next/navigation';
import { getAuditRuns } from '../../../actions/audit-actions';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { AuditListClient } from './audit-list-client';

export const dynamic = 'force-dynamic';

export default async function AuditsPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const runs = await getAuditRuns(firmSlug).catch(() => []);

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
      <AuditListClient firmSlug={firmSlug} initialRuns={runs} />
    </div>
  );
}
