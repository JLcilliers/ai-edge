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
} from 'lucide-react';
import {
  startEntityScan,
  getEntityScanStatus,
  type EntityHealth,
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
}: {
  firmSlug: string;
  initialHealth: EntityHealth | null;
  initialLatestRun: LatestRun;
}) {
  const [isPending, startTransition] = useTransition();
  const [runningId, setRunningId] = useState<string | null>(
    initialLatestRun?.status === 'running' ? initialLatestRun.id : null,
  );
  const [error, setError] = useState<string | null>(initialLatestRun?.error ?? null);
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

  const h = initialHealth;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={handleStartScan}
          disabled={isPending || !!runningId}
          className="rounded-full bg-[--accent] px-6 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[--accent-hover] disabled:opacity-50"
        >
          {isPending
            ? 'Starting...'
            : runningId
            ? 'Scan Running...'
            : 'Run Entity Scan'}
        </button>
        {initialLatestRun?.finishedAt && (
          <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
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
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-[--accent]/30 bg-[--accent]/10 px-4 py-3">
          <div className="h-3 w-3 animate-pulse rounded-full bg-[--accent]" />
          <span className="text-sm text-[--accent]">
            Probing schema + knowledge graphs... polling every 5s
          </span>
        </div>
      )}

      {!h && (
        <div className="mt-10 rounded-xl border border-white/10 bg-[--bg-secondary] p-6 text-sm text-white/55">
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
    </div>
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
      ? 'text-[--rag-green]'
      : state === 'warn'
      ? 'text-[--rag-yellow]'
      : state === 'bad'
      ? 'text-[--rag-red]'
      : 'text-white/40';
  return (
    <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
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
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[--accent] hover:underline"
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
      ? 'border-[--rag-green]/30 bg-[--rag-green-bg] text-[--rag-green]'
      : tone === 'warn'
      ? 'border-[--rag-yellow]/30 bg-[--rag-yellow-bg] text-[--rag-yellow]'
      : 'border-[--rag-red]/30 bg-[--rag-red-bg] text-[--rag-red]';
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
    <div className="rounded-xl border border-white/10 bg-[--bg-secondary]">
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-[--accent]/15 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-[--accent]">
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
