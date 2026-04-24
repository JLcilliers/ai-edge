import { notFound } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { getComplianceScope } from '../../../actions/compliance-actions';
import { ComplianceClient } from './compliance-client';

export const dynamic = 'force-dynamic';

export default async function CompliancePage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const scope = await getComplianceScope(firmSlug).catch(() => null);

  if (!scope?.brandTruthFound) {
    return (
      <div>
        <div className="mb-8">
          <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
            Compliance Check
          </h1>
          <p className="mt-2 text-white/55">
            Paste any copy (ad, remediation draft, email, landing-page
            paragraph) and we&apos;ll flag banned claims from both the
            jurisdictional rulebook and this firm&apos;s own Brand Truth.
          </p>
        </div>
        <div className="rounded-xl border border-amber-500/40 bg-[--bg-secondary] p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle
              size={18}
              strokeWidth={1.5}
              className="mt-0.5 shrink-0 text-amber-300"
            />
            <div>
              <p className="font-semibold text-amber-300">
                No Brand Truth saved yet
              </p>
              <p className="mt-1 text-sm text-white/60">
                Compliance checks rely on the firm&apos;s{' '}
                <span className="font-mono text-white/80">banned_claims</span>{' '}
                list and{' '}
                <span className="font-mono text-white/80">
                  compliance_jurisdictions
                </span>{' '}
                from Brand Truth. Set one up first.
              </p>
              <Link
                href={`/dashboard/${firmSlug}/brand-truth`}
                className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-white/10 px-4 py-1.5 text-xs text-white transition hover:border-[--accent]"
              >
                Configure Brand Truth
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8 flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/5">
          <ShieldCheck size={24} strokeWidth={1.5} className="text-[--accent]" />
        </div>
        <div>
          <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
            Compliance Check
          </h1>
          <p className="mt-2 text-white/55">
            Paste any copy (ad, remediation draft, email, landing-page
            paragraph) and we&apos;ll flag banned claims from both the
            jurisdictional rulebook and this firm&apos;s own Brand Truth.
          </p>
        </div>
      </div>

      {/* Active ruleset summary */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
          <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
            Jurisdictions Active
          </div>
          <div className="mt-2 font-[family-name:var(--font-jakarta)] text-2xl font-bold text-white">
            {scope.jurisdictions.length}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {scope.jurisdictions.length === 0 && (
              <span className="text-xs text-white/40">
                None — add codes in Brand Truth to enable the regex rulebook.
              </span>
            )}
            {scope.jurisdictions.map((j) => (
              <span
                key={j.code}
                className={`rounded-full border px-2.5 py-0.5 font-[family-name:var(--font-geist-mono)] text-[10px] uppercase tracking-wider ${
                  j.known
                    ? 'border-white/10 text-white/70'
                    : 'border-amber-500/40 text-amber-300'
                }`}
                title={
                  j.known
                    ? `${j.ruleCount} rule${j.ruleCount === 1 ? '' : 's'} loaded`
                    : 'Jurisdiction code not in seed rulebook — no rules will match'
                }
              >
                {j.code} · {j.ruleCount}
              </span>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
          <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
            Firm-Specific Banned Phrases
          </div>
          <div className="mt-2 font-[family-name:var(--font-jakarta)] text-2xl font-bold text-white">
            {scope.firmBannedClaims.length}
          </div>
          <div className="mt-1 text-xs text-white/40">
            {scope.firmBannedClaims.length === 0
              ? 'Add to Brand Truth to flag firm-specific phrasing.'
              : 'Case-insensitive substring match on every check.'}
          </div>
        </div>
      </div>

      <ComplianceClient firmSlug={firmSlug} />
    </div>
  );
}
