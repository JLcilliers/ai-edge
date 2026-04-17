import { getAuditDetail } from '../../../actions/audit-actions';
import { AuditDetailClient } from './audit-detail-client';

export default async function AuditDetailPage({
  params,
}: {
  params: Promise<{ auditId: string }>;
}) {
  const { auditId } = await params;

  let detail;
  try {
    detail = await getAuditDetail(auditId);
  } catch (err) {
    return (
      <div>
        <h1 className="text-2xl font-semibold text-red-400">Audit not found</h1>
        <p className="mt-2 text-sm text-neutral-500">{String(err)}</p>
      </div>
    );
  }

  return <AuditDetailClient detail={detail} auditId={auditId} />;
}
