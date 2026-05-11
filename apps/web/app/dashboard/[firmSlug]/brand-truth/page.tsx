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
  searchParams: Promise<{
    bootstrap?: string;
    reason?: string;
    // Per-scan enrichment summary encoded into the redirect by the
    // new-client form so the banner can say "+ 7 findings + 3 sources +
    // 2 AIO" without an extra DB round-trip.
    sup?: string;
    sup_count?: string;
    ent?: string;
    ent_count?: string;
    aio?: string;
    aio_count?: string;
  }>;
}) {
  const { firmSlug } = await params;
  const {
    bootstrap: bootstrapFlag,
    reason: bootstrapReason,
    sup,
    sup_count,
    ent,
    ent_count,
    aio,
    aio_count,
  } = await searchParams;
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
            {/* Per-scan summary chips. Rendered only when the new-client
                form passed the corresponding query params; older bootstrap
                redirects without the params still get the generic banner. */}
            {(sup || ent || aio) ? (
              <div className="mt-2 mb-3 flex flex-wrap gap-2">
                {sup ? (
                  <EnrichmentChip
                    label="Suppression"
                    status={sup}
                    detail={
                      sup === 'completed'
                        ? `${sup_count ?? '0'} findings`
                        : sup === 'failed'
                          ? 'site likely WAF-blocked'
                          : 'skipped'
                    }
                  />
                ) : null}
                {ent ? (
                  <EnrichmentChip
                    label="Entity"
                    status={ent}
                    detail={
                      ent === 'completed'
                        ? `${ent_count ?? '0'} sources`
                        : 'failed'
                    }
                  />
                ) : null}
                {aio ? (
                  <EnrichmentChip
                    label="AI Overviews"
                    status={aio}
                    detail={
                      aio === 'completed'
                        ? `${aio_count ?? '0'} captured`
                        : 'provider not configured'
                    }
                  />
                ) : null}
              </div>
            ) : null}
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

/**
 * Small pill rendering the outcome of one of the chained enrichment scans
 * (suppression / entity / AIO) so the operator can see at a glance which
 * modules already have data when they land in the editor.
 *
 * Color tone tracks status:
 *   completed → accent (green-ish)
 *   skipped   → muted white (not an error, just disabled)
 *   failed    → amber (worth a look — usually WAF or config issue)
 */
function EnrichmentChip({
  label,
  status,
  detail,
}: {
  label: string;
  status: string;
  detail: string;
}) {
  const tone =
    status === 'completed'
      ? 'border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--accent)]'
      : status === 'failed'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
        : 'border-white/10 bg-white/5 text-white/60';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${tone}`}
    >
      <span className="font-semibold">{label}</span>
      <span className="text-white/55">·</span>
      <span>{detail}</span>
    </span>
  );
}
