import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, GitCompare } from 'lucide-react';
import { getFirmBySlug } from '../../../../../actions/firm-actions';
import { getAuditDiff } from '../../../../../actions/audit-diff-actions';
import { AuditDiffClient } from './audit-diff-client';

export const dynamic = 'force-dynamic';

/**
 * Audit-to-audit diff page.
 *
 * Defaults to comparing `auditId` against the scoring run immediately
 * preceding it for the same firm. `?compareTo=<runId>` overrides the
 * comparison target, enabling explicit "pick two runs to diff" flows
 * from future UI.
 *
 * The server action enforces firm scoping by looking up the previous run
 * by firm_id, so a malicious compareTo from another firm would produce
 * "insufficient_data"-style output but can't leak rows — all rows come
 * from the latest run id which the firm slug already gates.
 */
export default async function AuditDiffPage({
  params,
  searchParams,
}: {
  params: Promise<{ firmSlug: string; auditId: string }>;
  searchParams: Promise<{ compareTo?: string }>;
}) {
  const [{ firmSlug, auditId }, sp] = await Promise.all([params, searchParams]);
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const diff = await getAuditDiff(auditId, {
    compareToRunId: sp.compareTo,
  }).catch(() => null);
  if (!diff) notFound();

  return (
    <div>
      <div className="mb-4">
        <Link
          href={`/dashboard/${firmSlug}/audits/${auditId}`}
          className="inline-flex items-center gap-1.5 text-xs text-white/55 hover:text-white"
        >
          <ArrowLeft size={14} strokeWidth={1.5} />
          Back to audit detail
        </Link>
      </div>

      <div className="mb-8 flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/5">
          <GitCompare size={24} strokeWidth={1.5} className="text-[var(--accent)]" />
        </div>
        <div>
          <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
            Audit Diff
          </h1>
          <p className="mt-2 text-white/55">
            Per-query label movement between this run and the previous
            scoring run. Regressions (green/yellow → red, green → yellow) are
            the actionable queue — these are the queries that need fresh
            Brand Truth attention.
          </p>
        </div>
      </div>

      <AuditDiffClient firmSlug={firmSlug} diff={diff} />
    </div>
  );
}
