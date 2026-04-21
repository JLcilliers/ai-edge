import { notFound } from 'next/navigation';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { listTickets } from '../../../actions/remediation-actions';
import { RemediationListClient } from './remediation-list-client';

export const dynamic = 'force-dynamic';

export default async function RemediationPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const tickets = await listTickets(firmSlug).catch(() => []);

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Remediation Queue
        </h1>
        <p className="mt-2 text-white/55">
          Every red audit finding and complaint-karma Reddit post opens a
          ticket. Triage them here.
        </p>
      </div>
      <RemediationListClient firmSlug={firmSlug} initialTickets={tickets} />
    </div>
  );
}
