'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Copy,
  ExternalLink,
  Globe,
  Database,
  Network,
  Layers,
  Award,
  Loader2,
} from 'lucide-react';
import {
  startEntityScan,
  getEntityScanStatus,
  startCrossSourceScan,
  type EntityHealth,
  type CrossSourceHealthRow,
  type CrossSourceUiOutcome,
} from '../../../actions/entity-actions';

type LatestRun = {
  id: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
} | null;

export function EntityClient({
  firmSlug,
  initialHealth,
  initialLatestRun,
  initialCrossSource,
}: {
  firmSlug: string;
  initialHealth: EntityHealth | null;
  initialLatestRun: LatestRun;
  initialCrossSource: CrossSourceHealthRow[];
}) {
  const [isPending, startTransition] = useTransition();
  const [runningId, setRunningId] = useState<string | null>(
    initialLatestRun?.status === 'running' ? initialLatestRun.id : null,
  );
  const [error, setError] = useState<string | null>(initialLatestRun?.error ?? null);
  const [crossSourcePending, startCrossSourceTransition] = useTransition();
  const [crossSourceResult, setCrossSourceResult] =
    useState<CrossSourceUiOutcome | null>(null);
  const [crossSourceError, setCrossSourceError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!runningId) return;
    const interval = setInterval(async () => {
      const status = await getEntityScanStatus(runningId);
      if (status.status !== 'running') {
        setRunningId(null);
        if (status.error) setError(status.error);
        router.refresh();
        clearInterval(interval);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [runningId, router]);

  const handleStartScan = () => {
    setError(null);
    startTransition(async () => {
      const result = await startEntityScan(firmSlug);
      if ('error' in result) {
        setError(result.error);
      } else {
        setRunningId(result.runId);
        router.refresh();
      }
    });
  };

  const handleCrossSourceScan = () => {
    setCrossSourceError(null);
    setCrossSourceResult(null);
    startCrossSourceTransition(async () => {
      const result = await startCrossSourceScan(firmSlug);
      if ('error' in result) {
        setCrossSourceError(result.error);
      } else {
        setCrossSourceResult(result);
        router.refresh();
      }
    });
  };

  const h = initialHealth;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={handleStartScan}
          disabled={isPending || !!runningId}
          className="rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {isPending
            ? 'Starting...'
            : runningId
            ? 'Scan Running...'
            : 'Run Entity Scan'}
        </button>
        {initialLatestRun?.finishedAt && (
          <span
            className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40"
            suppressHydrationWarning
          >
            Last scanned {new Date(initialLatestRun.finishedAt).toLocaleString()}
          </span>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/15 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {runningId && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-3">
          <div className="h-3 w-3 animate-pulse rounded-full bg-[var(--accent)]" />
          <span className="text-sm text-[var(--accent)]">
            Probing schema + knowledge graphs... polling every 5s
          </span>
        </div>
      )}

      {!h && (
        <div className="mt-10 rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-6 text-sm text-white/55">
          Set up a Brand Truth before running an entity scan — we need the firm
          name + site URL to probe schema and knowledge graphs.
        </div>
      )}

      {h && (
        <>
          {/* Three big health panels */}
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <HealthPanel
              icon={Globe}
              title="Home page schema.org"
              state={
                h.schemaMissingRequired.length === 0 && h.schemaPresent.length > 0
                  ? 'ok'
                  : h.schemaPresent.length > 0
                  ? 'warn'
                  : 'bad'
              }
              primary={
                h.schemaPresent.length > 0
                  ? `${h.schemaPresent.length} / ${h.schemaPresent.length + h.schemaMissingRequired.length} required types present`
                  : 'No schema detected'
              }
              detail={
                h.schemaMissingRequired.length > 0
                  ? `Missing: ${h.schemaMissingRequired.join(', ')}`
                  : h.schemaMissingRecommended.length > 0
                  ? `Recommended: ${h.schemaMissingRecommended.slice(0, 3).join(', ')}`
                  : 'All required and recommended types present'
              }
            />
            <HealthPanel
              icon={Database}
              title="Wikidata"
              state={
                h.wikidata.status === 'present'
                  ? 'ok'
                  : h.wikidata.status === 'ambiguous'
                  ? 'warn'
                  : h.wikidata.status === 'never_scanned'
                  ? 'idle'
                  : 'bad'
              }
              primary={wikidataPrimary(h.wikidata.status)}
              detail={wikidataDetail(h.wikidata)}
              linkUrl={h.wikidata.url}
            />
            <HealthPanel
              icon={Network}
              title="Google Knowledge Graph"
              state={
                h.googleKg.status === 'present'
                  ? 'ok'
                  : h.googleKg.status === 'skipped_no_key'
                  ? 'idle'
                  : h.googleKg.status === 'never_scanned'
                  ? 'idle'
                  : 'bad'
              }
              primary={googleKgPrimary(h.googleKg.status)}
              detail={googleKgDetail(h.googleKg)}
              linkUrl={h.googleKg.url}
            />
          </div>

          {/* Present schema types */}
          {h.schemaPresent.length > 0 && (
            <div className="mt-8">
              <h2 className="mb-3 font-[family-name:var(--font-jakarta)] text-sm font-semibold uppercase tracking-widest text-white/55">
                Detected schema types
              </h2>
              <div className="flex flex-wrap gap-2">
                {h.schemaPresent.map((t) => (
                  <TypePill key={t} type={t} tone="ok" />
                ))}
              </div>
            </div>
          )}

          {h.schemaMissingRequired.length > 0 && (
            <div className="mt-6">
              <h2 className="mb-3 font-[family-name:var(--font-jakarta)] text-sm font-semibold uppercase tracking-widest text-white/55">
                Required — still missing
              </h2>
              <div className="flex flex-wrap gap-2">
                {h.schemaMissingRequired.map((t) => (
                  <TypePill key={t} type={t} tone="bad" />
                ))}
              </div>
            </div>
          )}

          {h.schemaMissingRecommended.length > 0 && (
            <div className="mt-6">
              <h2 className="mb-3 font-[family-name:var(--font-jakarta)] text-sm font-semibold uppercase tracking-widest text-white/55">
                Recommended
              </h2>
              <div className="flex flex-wrap gap-2">
                {h.schemaMissingRecommended.map((t) => (
                  <TypePill key={t} type={t} tone="warn" />
                ))}
              </div>
            </div>
          )}

          {/* JSON-LD patches */}
          {h.patches.length > 0 && (
            <div className="mt-10">
              <h2 className="mb-3 font-[family-name:var(--font-jakarta)] text-sm font-semibold uppercase tracking-widest text-white/55">
                Copy-paste JSON-LD patches ({h.patches.length})
              </h2>
              <p className="mb-4 text-sm text-white/55">
                Drop each block inside a{' '}
                <code className="rounded bg-white/10 px-1.5 py-0.5 font-[family-name:var(--font-geist-mono)] text-xs">
                  &lt;script type=&quot;application/ld+json&quot;&gt;
                </code>{' '}
                tag in the page&apos;s{' '}
                <code className="rounded bg-white/10 px-1.5 py-0.5 font-[family-name:var(--font-geist-mono)] text-xs">
                  &lt;head&gt;
                </code>
                . Patches are generated from your Brand Truth — double-check
                addresses and attorney bar numbers before shipping.
              </p>
              <div className="flex flex-col gap-4">
                {h.patches.map((p, i) => (
                  <PatchBlock key={`${p.type}-${i}`} patch={p} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Cross-source vector alignment + badge verification ── */}
      <div className="mt-12 border-t border-white/10 pt-10">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-[family-name:var(--font-jakarta)] text-lg font-semibold text-white">
              Cross-source alignment + badge verification
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-white/55">
              Fetches every URL the operator has curated in Brand Truth (
              <code className="font-[family-name:var(--font-geist-mono)] text-[11px]">
                third_party_listings[]
              </code>{' '}
              + every <code className="font-[family-name:var(--font-geist-mono)] text-[11px]">awards[].source_url</code>),
              embeds the prose, and compares to the Brand Truth centroid.
              Divergent third-party listings poison LLM alignment the same
              way divergent on-site copy does — except we can&apos;t fix
              them in the CMS, the operator has to update each platform
              via its own form. Award URLs also get a name-presence check
              ({' '}<strong className="font-semibold text-white/80">badge verification</strong>) — if the firm name doesn&apos;t
              appear on the listed page, the award is flagged unverified.
            </p>
          </div>
          <button
            type="button"
            onClick={handleCrossSourceScan}
            disabled={crossSourcePending}
            className="inline-flex shrink-0 items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {crossSourcePending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Layers size={14} strokeWidth={2} />
            )}
            Run cross-source scan
          </button>
        </div>

        {crossSourceResult && (
          <div className="mb-4 rounded-lg border border-[var(--rag-green)]/30 bg-[var(--rag-green-bg)] px-3 py-2 text-xs text-[var(--rag-green)]">
            Scanned {crossSourceResult.sourcesFetched} of{' '}
            {crossSourceResult.sourcesScanned} sources ·{' '}
            <span className="text-[var(--rag-green)]">
              {crossSourceResult.sourcesAligned} aligned
            </span>{' '}
            ·{' '}
            <span className="text-[var(--rag-yellow)]">
              {crossSourceResult.sourcesDrifted} drift
            </span>{' '}
            ·{' '}
            <span className="text-[var(--rag-red)]">
              {crossSourceResult.sourcesDivergent} divergent
            </span>
            {crossSourceResult.awardsVerified + crossSourceResult.awardsUnverified > 0 && (
              <>
                {' · awards: '}
                <span className="text-[var(--rag-green)]">
                  {crossSourceResult.awardsVerified} verified
                </span>
                {crossSourceResult.awardsUnverified > 0 && (
                  <>
                    {' / '}
                    <span className="text-[var(--rag-red)]">
                      {crossSourceResult.awardsUnverified} unverified
                    </span>
                  </>
                )}
              </>
            )}
            {crossSourceResult.ticketsOpened > 0
              ? ` · ${crossSourceResult.ticketsOpened} ticket${crossSourceResult.ticketsOpened === 1 ? '' : 's'} opened`
              : ''}
            {crossSourceResult.sampleErrors.length > 0 && (
              <> · {crossSourceResult.sampleErrors.length} fetch error
                {crossSourceResult.sampleErrors.length === 1 ? '' : 's'}</>
            )}
          </div>
        )}

        {crossSourceError && (
          <div className="mb-4 rounded-lg border border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] px-3 py-2 text-xs text-[var(--rag-red)]">
            {crossSourceError}
          </div>
        )}

        {initialCrossSource.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 bg-[var(--bg-secondary)]/50 p-6 text-sm text-white/55">
            No cross-source signals yet. Add directory profile URLs to your
            Brand Truth (Brand Truth editor →{' '}
            <code className="font-[family-name:var(--font-geist-mono)] text-[11px]">
              third_party_listings[]
            </code>
            , one entry per BBB / Super Lawyers / Avvo / Justia profile)
            and/or set <code className="font-[family-name:var(--font-geist-mono)] text-[11px]">source_url</code>{' '}
            on each award, then click <em>Run cross-source scan</em>.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-white/10">
            <table className="w-full text-sm">
              <thead className="border-b border-white/10 bg-white/[0.02]">
                <tr className="text-left text-[10px] uppercase tracking-widest text-white/40">
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">URL</th>
                  <th className="px-4 py-2 font-medium">Alignment</th>
                  <th className="px-4 py-2 font-medium">Distance</th>
                  <th className="px-4 py-2 font-medium">Badge</th>
                  <th className="px-4 py-2 font-medium">Last scan</th>
                </tr>
              </thead>
              <tbody>
                {initialCrossSource.map((row, i) => (
                  <CrossSourceRow key={`${row.source}-${i}`} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function CrossSourceRow({ row }: { row: CrossSourceHealthRow }) {
  const alignmentClass =
    row.alignment === 'divergent'
      ? 'text-[var(--rag-red)]'
      : row.alignment === 'drift'
        ? 'text-[var(--rag-yellow)]'
        : row.alignment === 'aligned'
          ? 'text-[var(--rag-green)]'
          : 'text-white/40';
  const badgeClass =
    row.badgeStatus === 'verified'
      ? 'text-[var(--rag-green)]'
      : row.badgeStatus === 'unverified'
        ? 'text-[var(--rag-red)]'
        : 'text-white/30';
  return (
    <tr className="border-b border-white/5 last:border-b-0">
      <td className="px-4 py-3 font-[family-name:var(--font-geist-mono)] text-xs text-white/85">
        {row.source}
        {row.awardName && (
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-white/40">
            <Award size={10} strokeWidth={1.5} />
            {row.awardName}
          </div>
        )}
      </td>
      <td className="max-w-[28rem] truncate px-4 py-3 font-[family-name:var(--font-geist-mono)] text-[11px] text-white/55">
        {row.url ? (
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-white"
          >
            {row.url} <ExternalLink size={10} strokeWidth={2} />
          </a>
        ) : (
          '—'
        )}
      </td>
      <td className={`px-4 py-3 text-xs font-semibold uppercase tracking-wider ${alignmentClass}`}>
        {row.alignment === 'never_scanned' ? '—' : row.alignment}
      </td>
      <td className="px-4 py-3 font-[family-name:var(--font-geist-mono)] text-xs text-white/70">
        {row.distance != null ? row.distance.toFixed(3) : '—'}
      </td>
      <td className={`px-4 py-3 text-xs ${badgeClass}`}>
        {row.badgeStatus === 'not_applicable' ? '—' : row.badgeStatus}
      </td>
      <td
        className="px-4 py-3 font-[family-name:var(--font-geist-mono)] text-[11px] text-white/40"
        suppressHydrationWarning
      >
        {row.scannedAt
          ? new Date(row.scannedAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
          : '—'}
      </td>
    </tr>
  );
}

function wikidataPrimary(status: EntityHealth['wikidata']['status']): string {
  switch (status) {
    case 'present':
      return 'Entity claimed';
    case 'ambiguous':
      return 'Multiple candidates';
    case 'missing':
      return 'Not in Wikidata';
    case 'error':
      return 'Probe error';
    case 'never_scanned':
    default:
      return 'Not scanned';
  }
}

function wikidataDetail(wd: EntityHealth['wikidata']): string {
  if (wd.status === 'missing') {
    return 'Create a Wikidata entry — LLMs use Wikidata QIDs as stable entity anchors.';
  }
  if (wd.status === 'ambiguous') {
    return `Disambiguate via headquarters city: ${wd.detail ?? ''}`;
  }
  if (wd.detail) return wd.detail;
  return 'Run a scan to check.';
}

function googleKgPrimary(status: EntityHealth['googleKg']['status']): string {
  switch (status) {
    case 'present':
      return 'Entity found';
    case 'missing':
      return 'Not in Google KG';
    case 'skipped_no_key':
      return 'KG API key not set';
    case 'error':
      return 'Probe error';
    case 'never_scanned':
    default:
      return 'Not scanned';
  }
}

function googleKgDetail(gk: EntityHealth['googleKg']): string {
  if (gk.status === 'skipped_no_key') {
    return 'Set GOOGLE_KG_API_KEY to enable this probe — free tier is plenty.';
  }
  if (gk.status === 'missing') {
    return 'Claim via Google Business Profile + verify schema on the home page.';
  }
  if (gk.detail) return gk.detail;
  return 'Run a scan to check.';
}

function HealthPanel({
  icon: Icon,
  title,
  state,
  primary,
  detail,
  linkUrl,
}: {
  icon: typeof Globe;
  title: string;
  state: 'ok' | 'warn' | 'bad' | 'idle';
  primary: string;
  detail: string;
  linkUrl?: string | null;
}) {
  const StateIcon =
    state === 'ok' ? CheckCircle2 : state === 'warn' ? AlertCircle : XCircle;
  const iconColor =
    state === 'ok'
      ? 'text-[var(--rag-green)]'
      : state === 'warn'
      ? 'text-[var(--rag-yellow)]'
      : state === 'bad'
      ? 'text-[var(--rag-red)]'
      : 'text-white/40';
  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon size={16} strokeWidth={1.5} className="text-white/55" />
          <h3 className="text-xs font-medium uppercase tracking-wider text-white/55">
            {title}
          </h3>
        </div>
        <StateIcon size={18} strokeWidth={1.5} className={iconColor} />
      </div>
      <div className="mt-3 font-[family-name:var(--font-jakarta)] text-lg font-bold text-white">
        {primary}
      </div>
      <div className="mt-2 text-xs text-white/55">{detail}</div>
      {linkUrl && (
        <a
          href={linkUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline"
        >
          View entity <ExternalLink size={12} strokeWidth={1.5} />
        </a>
      )}
    </div>
  );
}

function TypePill({
  type,
  tone,
}: {
  type: string;
  tone: 'ok' | 'warn' | 'bad';
}) {
  const styles =
    tone === 'ok'
      ? 'border-[var(--rag-green)]/30 bg-[var(--rag-green-bg)] text-[var(--rag-green)]'
      : tone === 'warn'
      ? 'border-[var(--rag-yellow)]/30 bg-[var(--rag-yellow-bg)] text-[var(--rag-yellow)]'
      : 'border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] text-[var(--rag-red)]';
  return (
    <span
      className={`rounded-full border px-3 py-1 font-[family-name:var(--font-geist-mono)] text-xs ${styles}`}
    >
      {type}
    </span>
  );
}

function PatchBlock({ patch }: { patch: EntityHealth['patches'][number] }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(patch.jsonLd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard failures are non-fatal — operator can still select + copy.
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)]">
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-[var(--accent)]/15 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-[var(--accent)]">
            {patch.type}
          </span>
          <span className="text-xs text-white/55">{patch.reason}</span>
        </div>
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-xs font-medium text-white/80 transition-colors hover:border-white/30 hover:bg-white/5"
        >
          <Copy size={12} strokeWidth={1.8} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-5 py-4 font-[family-name:var(--font-geist-mono)] text-[11px] leading-relaxed text-white/75">
        {patch.jsonLd}
      </pre>
    </div>
  );
}
