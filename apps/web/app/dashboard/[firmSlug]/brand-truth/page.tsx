import { notFound } from 'next/navigation';
import { Sparkles, AlertTriangle } from 'lucide-react';
import {
  getLatestBrandTruth,
  getBrandTruthVersions,
} from '../../../actions/brand-truth-actions';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { BrandTruthEditor } from './editor';
import { emptySeed } from './seed-data';

// Force dynamic — this page hits the DB at render time
export const dynamic = 'force-dynamic';

export default async function BrandTruthPage({
  params,
  searchParams,
}: {
  params: Promise<{ firmSlug: string }>;
  searchParams: Promise<{ bootstrap?: string; reason?: string }>;
}) {
  const { firmSlug } = await params;
  const { bootstrap: bootstrapFlag, reason: bootstrapReason } = await searchParams;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const [latest, versions] = await Promise.all([
    getLatestBrandTruth(firmSlug),
    getBrandTruthVersions(firmSlug),
  ]);

  const initialPayload =
    latest?.payload ?? emptySeed({ name: firm.name, firm_type: firm.firm_type });
  const currentVersion = latest?.version ?? 0;

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Brand Truth
        </h1>
        <p className="mt-2 text-white/55">
          Define how AI should describe {firm.name}
        </p>
        <p className="mt-1 text-xs font-[family-name:var(--font-geist-mono)] text-white/40">
          Version {currentVersion || 'unsaved'}
        </p>
      </div>

      {/* One-time post-bootstrap banner — driven by the ?bootstrap=ok|failed
          query param the new-client form appends after the bootstrap action
          completes. Hidden on every other render so it doesn't clutter the
          editor on subsequent visits. */}
      {bootstrapFlag === 'ok' && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-4">
          <Sparkles
            size={18}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0 text-[var(--accent)]"
          />
          <div className="flex-1 text-sm text-white/80">
            <div className="mb-1 font-semibold text-white">
              Bootstrap complete — v1 pre-populated from {firm.name}'s website.
            </div>
            <p className="text-white/55">
              Review every field below. Common fixes: confirm the headquarters
              address, add any awards we couldn't find on the public site,
              pick the right <code className="font-[family-name:var(--font-geist-mono)] text-white/70">compliance_jurisdictions</code>,
              and fill in <code className="font-[family-name:var(--font-geist-mono)] text-white/70">banned_claims</code> per your firm's
              jurisdictional rules. Your first Save creates v2.
            </p>
          </div>
        </div>
      )}
      {bootstrapFlag === 'failed' && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <AlertTriangle
            size={18}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0 text-amber-300"
          />
          <div className="flex-1 text-sm text-white/80">
            <div className="mb-1 font-semibold text-amber-100">
              Bootstrap couldn't run — author Brand Truth manually below.
            </div>
            <p className="text-white/55">
              Reason:{' '}
              <span className="font-[family-name:var(--font-geist-mono)] text-amber-200">
                {bootstrapReason ?? 'unknown'}
              </span>
              . The site may be JS-rendered, behind a WAF, or returning no
              extractable content. You can still author Brand Truth by hand —
              the rest of the platform works the same.
            </p>
          </div>
        </div>
      )}

      <BrandTruthEditor
        firmSlug={firmSlug}
        initialPayload={initialPayload}
        currentVersion={currentVersion}
        versions={versions}
      />
    </div>
  );
}
