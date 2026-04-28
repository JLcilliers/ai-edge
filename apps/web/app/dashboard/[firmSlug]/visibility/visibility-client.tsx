'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDownRight,
  ArrowUpRight,
  AlertTriangle,
  CheckCircle2,
  Minus,
  ExternalLink,
  TrendingUp,
  Globe,
  GitCompare,
  Sparkles,
  Loader2,
  Search,
  LineChart,
} from 'lucide-react';
import type {
  ShareOfVoiceResult,
  CitationSourceGraph,
  CitationDriftRow,
  AlignmentRegression,
} from '../../../actions/visibility-actions';
import {
  triggerAioCapture,
  type AioCaptureRow,
  type AioCaptureUiOutcome,
} from '../../../actions/aio-actions';
import type { VisibilityCorrelation } from '../../../actions/visibility-correlation-actions';

type Tab = 'share' | 'sources' | 'drift' | 'aio' | 'correlation';

function formatDate(d: Date | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateTime(d: Date): string {
  return new Date(d).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function VisibilityClient({
  firmSlug,
  firmName,
  shareOfVoice,
  sourceGraph,
  driftHistory,
  regression,
  aioCaptures,
  aioProvider,
  correlation,
}: {
  firmSlug: string;
  firmName: string;
  shareOfVoice: ShareOfVoiceResult;
  sourceGraph: CitationSourceGraph;
  driftHistory: CitationDriftRow[];
  regression: AlignmentRegression;
  aioCaptures: AioCaptureRow[];
  aioProvider: string;
  correlation: VisibilityCorrelation | null;
}) {
  const [tab, setTab] = useState<Tab>('share');

  const hasRuns = regression.latestRunId !== null;

  return (
    <>
      {/* Regression banner — only surfaces when we have enough data to compare */}
      {hasRuns && <RegressionBanner regression={regression} />}

      {/* Empty state when no audits have ever run */}
      {!hasRuns && (
        <div className="mb-6 rounded-xl border border-dashed border-white/10 bg-[--bg-secondary] p-10 text-center">
          <TrendingUp
            size={28}
            strokeWidth={1.5}
            className="mx-auto mb-3 text-white/30"
          />
          <p className="text-sm text-white/55">
            No completed audit runs yet. Once the weekly or daily audit cron
            has produced at least one run, share-of-voice and citation data
            will surface here.
          </p>
          <Link
            href={`/dashboard/${firmSlug}/audits`}
            className="mt-3 inline-flex items-center gap-1.5 text-sm text-[--accent] hover:underline"
          >
            Go to Audits
            <ExternalLink size={12} />
          </Link>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-4 flex gap-2 border-b border-white/10">
        <TabButton active={tab === 'share'} onClick={() => setTab('share')} icon={TrendingUp}>
          Share of Voice
        </TabButton>
        <TabButton active={tab === 'sources'} onClick={() => setTab('sources')} icon={Globe}>
          Citation Sources
        </TabButton>
        <TabButton active={tab === 'drift'} onClick={() => setTab('drift')} icon={GitCompare}>
          Drift
        </TabButton>
        <TabButton active={tab === 'aio'} onClick={() => setTab('aio')} icon={Sparkles}>
          AI Overviews
        </TabButton>
        <TabButton
          active={tab === 'correlation'}
          onClick={() => setTab('correlation')}
          icon={LineChart}
        >
          Correlation
        </TabButton>
      </div>

      {tab === 'share' && (
        <ShareOfVoiceView firmSlug={firmSlug} firmName={firmName} data={shareOfVoice} />
      )}
      {tab === 'sources' && <CitationSourcesView data={sourceGraph} />}
      {tab === 'drift' && <DriftView history={driftHistory} firmSlug={firmSlug} />}
      {tab === 'aio' && (
        <AioView
          firmSlug={firmSlug}
          captures={aioCaptures}
          provider={aioProvider}
        />
      )}
      {tab === 'correlation' && <CorrelationView correlation={correlation} />}
    </>
  );
}

// ─── AIO view (Phase B #7) ──────────────────────────────────
function AioView({
  firmSlug,
  captures,
  provider,
}: {
  firmSlug: string;
  captures: AioCaptureRow[];
  provider: string;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [result, setResult] = useState<AioCaptureUiOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onCapture = () => {
    setError(null);
    setResult(null);
    start(async () => {
      try {
        const r = await triggerAioCapture(firmSlug, { maxQueries: 5 });
        setResult(r);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Capture failed');
      }
    });
  };

  const providerLabel =
    provider === 'dataforseo'
      ? 'DataForSEO (primary, paid)'
      : provider === 'playwright'
        ? 'Playwright fallback (remote worker)'
        : 'none configured';
  const providerTone = provider === 'none' ? 'warn' : 'ok';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-white/10 bg-[--bg-secondary] p-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-[family-name:var(--font-jakarta)] text-base font-semibold text-white">
            Google AI Overview capture
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-white/55">
            Captures the AIO panel Google renders for the firm&apos;s
            seed query intents and tracks whether the firm appears in the
            cited sources. Different from the audit pipeline (which queries
            the Gemini model directly) — this catches the AIO product
            surface itself, including which sources Google chose to cite.
          </p>
          <p className="mt-2 font-[family-name:var(--font-geist-mono)] text-[11px] text-white/40">
            Provider:{' '}
            <span
              className={
                providerTone === 'warn'
                  ? 'text-[--rag-yellow]'
                  : 'text-[--rag-green]'
              }
            >
              {providerLabel}
            </span>
            {provider === 'none' && (
              <>
                {' — '}set <code>DATAFORSEO_LOGIN</code> +{' '}
                <code>DATAFORSEO_PASSWORD</code> for the primary path, or
                deploy <code>infra/playwright-aio-worker/</code> on Fly.io
                and set <code>PLAYWRIGHT_AIO_WORKER_URL</code> +{' '}
                <code>PLAYWRIGHT_AIO_WORKER_SECRET</code> for the fallback.
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onCapture}
          disabled={isPending}
          className="inline-flex shrink-0 items-center gap-2 rounded-full bg-[--accent] px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-[--accent-hover] disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Search size={14} strokeWidth={2} />
          )}
          Capture now
        </button>
      </div>

      {result && (
        <div className="rounded-lg border border-[--rag-green]/30 bg-[--rag-green-bg] px-3 py-2 text-xs text-[--rag-green]">
          Attempted {result.attempted} ·{' '}
          <span>{result.hasAio} had AIO</span>
          {result.firmCited > 0 && (
            <>
              {' · '}
              <span className="font-semibold">{result.firmCited} cited the firm</span>
            </>
          )}
          {result.errors > 0 && (
            <>
              {' · '}
              <span className="text-[--rag-red]">{result.errors} errors</span>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-[--rag-red]/30 bg-[--rag-red-bg] px-3 py-2 text-xs text-[--rag-red]">
          {error}
        </div>
      )}

      {captures.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 bg-[--bg-secondary]/50 p-6 text-sm text-white/55">
          No AIO captures yet. Click <em>Capture now</em> to run an
          ad-hoc capture, or wait for the weekly cron (Tuesday 10:00 UTC).
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="border-b border-white/10 bg-white/[0.02]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-white/40">
                <th className="px-4 py-2 font-medium">Query</th>
                <th className="px-4 py-2 font-medium">AIO</th>
                <th className="px-4 py-2 font-medium">Firm cited</th>
                <th className="px-4 py-2 font-medium">Sources</th>
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-4 py-2 font-medium">Captured</th>
              </tr>
            </thead>
            <tbody>
              {captures.map((c) => (
                <tr key={c.id} className="border-b border-white/5 last:border-b-0">
                  <td className="px-4 py-3 text-white">{c.query}</td>
                  <td className="px-4 py-3 text-xs">
                    {c.hasAio ? (
                      <span className="text-[--rag-green]">yes</span>
                    ) : (
                      <span className="text-white/40">no</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {c.firmCited ? (
                      <span className="font-semibold text-[--rag-green]">cited</span>
                    ) : (
                      <span className="text-white/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-[family-name:var(--font-geist-mono)] text-xs text-white/70">
                    {c.sourceCount}
                  </td>
                  <td className="px-4 py-3 font-[family-name:var(--font-geist-mono)] text-xs text-white/55">
                    {c.provider}
                  </td>
                  <td
                    className="px-4 py-3 font-[family-name:var(--font-geist-mono)] text-[11px] text-white/40"
                    suppressHydrationWarning
                  >
                    {new Date(c.fetchedAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Regression banner ──────────────────────────────────────
function RegressionBanner({ regression }: { regression: AlignmentRegression }) {
  const { severity, redDeltaPp, latestRedPct, previousRedPct } = regression;

  if (severity === 'insufficient_data') {
    return (
      <div className="mb-6 flex items-start gap-3 rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
        <Minus size={20} strokeWidth={1.5} className="mt-0.5 shrink-0 text-white/40" />
        <div>
          <p className="font-semibold text-white/80">Regression check needs more data</p>
          <p className="mt-1 text-sm text-white/55">
            Two completed audit runs are required to compare red-rate movement.
            Run one more audit to activate the alert.
          </p>
        </div>
      </div>
    );
  }

  const config = {
    critical: {
      border: 'border-red-500/40',
      iconColor: 'text-red-300',
      textColor: 'text-red-300',
      Icon: AlertTriangle,
      label: 'Critical regression',
      subLabel: `Red rose ${redDeltaPp.toFixed(1)}pp since the previous run.`,
    },
    warning: {
      border: 'border-amber-500/40',
      iconColor: 'text-amber-300',
      textColor: 'text-amber-300',
      Icon: AlertTriangle,
      label: 'Red-rate rising',
      subLabel: `Red rose ${redDeltaPp.toFixed(1)}pp since the previous run.`,
    },
    improving: {
      border: 'border-[--rag-green]/30',
      iconColor: 'text-[--rag-green]',
      textColor: 'text-[--rag-green]',
      Icon: ArrowDownRight,
      label: 'Alignment improving',
      subLabel: `Red fell ${Math.abs(redDeltaPp).toFixed(1)}pp since the previous run.`,
    },
    stable: {
      border: 'border-white/10',
      iconColor: 'text-white/60',
      textColor: 'text-white/80',
      Icon: CheckCircle2,
      label: 'Alignment stable',
      subLabel: 'Red rate moved less than 5pp between the last two runs.',
    },
  }[severity];

  const C = config;
  return (
    <div className={`mb-6 flex items-start gap-3 rounded-xl border bg-[--bg-secondary] p-5 ${C.border}`}>
      <C.Icon size={20} strokeWidth={1.5} className={`mt-0.5 shrink-0 ${C.iconColor}`} />
      <div>
        <p className={`font-semibold ${C.textColor}`}>{C.label}</p>
        <p className="mt-1 text-sm text-white/55">{C.subLabel}</p>
        <p
          className="mt-2 font-[family-name:var(--font-geist-mono)] text-xs text-white/40"
          suppressHydrationWarning
        >
          Latest red: {latestRedPct.toFixed(1)}% · Previous red: {previousRedPct.toFixed(1)}%
          {' · '}
          Last run {formatDate(regression.latestRunStartedAt)}
        </p>
      </div>
    </div>
  );
}

// ─── Tab button ─────────────────────────────────────────────
function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof TrendingUp;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
        active
          ? 'border-[--accent] text-white'
          : 'border-transparent text-white/55 hover:text-white/80'
      }`}
    >
      <Icon size={14} strokeWidth={1.5} />
      {children}
    </button>
  );
}

// ─── Share of Voice view ────────────────────────────────────
function ShareOfVoiceView({
  firmSlug,
  firmName,
  data,
}: {
  firmSlug: string;
  firmName: string;
  data: ShareOfVoiceResult;
}) {
  if (data.totalMentions === 0) {
    return (
      <EmptyTab
        message={`No mentions detected across ${data.windowDescription}. Either the firm isn't appearing yet, or there are no queries in the audit seed. Check the Brand Truth seed queries.`}
        cta={{ href: `/dashboard/${firmSlug}/brand-truth`, label: 'Open Brand Truth' }}
      />
    );
  }

  const selfEntity = data.entities.find((e) => e.isSelf);
  const selfShare = selfEntity?.sharePct ?? 0;

  return (
    <div className="space-y-6">
      {/* Headline metric */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Our share"
          value={`${selfShare.toFixed(1)}%`}
          detail={`${selfEntity?.mentions ?? 0} mentions`}
          tone={selfShare >= 50 ? 'good' : selfShare >= 25 ? 'neutral' : 'bad'}
        />
        <StatTile
          label="Competitors tracked"
          value={String(data.entities.filter((e) => !e.isSelf).length)}
          detail="with mentions in window"
        />
        <StatTile
          label="Window"
          value={data.windowDescription}
          detail={`${data.totalMentions} total mentions`}
        />
      </div>

      {/* Bar chart */}
      <div className="overflow-hidden rounded-xl border border-white/10 bg-[--bg-secondary]">
        <div className="border-b border-white/5 px-5 py-3 text-xs font-medium uppercase tracking-widest text-white/55">
          Share breakdown
        </div>
        <div className="divide-y divide-white/5">
          {data.entities.map((e) => (
            <div key={e.id} className="flex items-center gap-4 px-5 py-4">
              <div className="w-40 min-w-0">
                <p className="truncate text-sm text-white/90">
                  {e.isSelf ? firmName : e.name}
                  {e.isSelf && (
                    <span className="ml-2 rounded-full border border-[--accent]/40 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-[--accent]">
                      You
                    </span>
                  )}
                </p>
              </div>
              <div className="flex-1">
                <div className="h-2 overflow-hidden rounded-full bg-white/5">
                  <div
                    className={e.isSelf ? 'bg-[--accent]' : 'bg-white/40'}
                    style={{
                      width: `${Math.max(e.sharePct, 1)}%`,
                      height: '100%',
                    }}
                  />
                </div>
              </div>
              <div className="w-24 text-right font-[family-name:var(--font-geist-mono)] text-xs text-white/60">
                {e.sharePct.toFixed(1)}%
              </div>
              <div className="w-16 text-right font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
                {e.mentions}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Citation Sources view ──────────────────────────────────
function CitationSourcesView({ data }: { data: CitationSourceGraph }) {
  if (data.rows.length === 0) {
    return (
      <EmptyTab message={`No citations recorded across ${data.windowDescription}. Citations are extracted by the alignment scorer from each model's response.`} />
    );
  }

  const topTotal = data.rows[0]?.total ?? 1;

  return (
    <div className="space-y-6">
      <p className="text-sm text-white/55">
        Top cited domains across {data.windowDescription}. Prioritize these
        for link or PR effort — they are the sources LLMs trust when
        describing the firm.
      </p>

      <div className="overflow-hidden rounded-xl border border-white/10 bg-[--bg-secondary]">
        <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b border-white/5 bg-[--bg-tertiary] px-5 py-3 text-[10px] font-medium uppercase tracking-widest text-white/55">
          <span>Domain</span>
          <span>Citations</span>
          <span>Queries</span>
          <span>Last seen</span>
        </div>

        {data.rows.map((row) => {
          const barPct = Math.round((row.total / topTotal) * 100);
          return (
            <div
              key={row.domain}
              className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b border-white/5 px-5 py-3 last:border-b-0"
            >
              <div className="flex items-center gap-3 min-w-0">
                <a
                  href={`https://${row.domain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-sm text-white/80 hover:text-[--accent] hover:underline"
                  title={row.domain}
                >
                  {row.domain}
                </a>
                <div className="hidden flex-1 sm:block">
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
                    <div
                      className="h-full bg-[--accent]/60"
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                </div>
              </div>
              <span className="w-20 text-right font-[family-name:var(--font-geist-mono)] text-sm text-white/80">
                {row.total}
              </span>
              <span className="w-20 text-right font-[family-name:var(--font-geist-mono)] text-xs text-white/60">
                {row.uniqueQueries}
              </span>
              <span
                className="w-24 text-right font-[family-name:var(--font-geist-mono)] text-xs text-white/40"
                suppressHydrationWarning
              >
                {formatDate(row.lastSeenAt)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Drift view ─────────────────────────────────────────────
function DriftView({ history, firmSlug }: { history: CitationDriftRow[]; firmSlug: string }) {
  if (history.length === 0) {
    return (
      <EmptyTab
        message="No drift rows yet. The nightly citation-diff cron needs at least two completed audit runs per firm to compute a diff. Give it another day or two."
        cta={{ href: `/dashboard/${firmSlug}/audits`, label: 'Open Audits' }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {history.map((row) => (
        <div
          key={row.id}
          className="rounded-xl border border-white/10 bg-[--bg-secondary] p-5"
        >
          <div className="mb-3 flex items-center justify-between gap-4">
            <div
              className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40"
              suppressHydrationWarning
            >
              detected {formatDateTime(row.detectedAt)}
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1 text-[--rag-green]">
                <ArrowUpRight size={12} />
                {row.gainedCount} gained
              </span>
              <span className="flex items-center gap-1 text-[--rag-red]">
                <ArrowDownRight size={12} />
                {row.lostCount} lost
              </span>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <DomainList label="Gained" color="green" domains={row.gained} />
            <DomainList label="Lost" color="red" domains={row.lost} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Correlation view (Phase B #6 visualization) ───────────
function CorrelationView({
  correlation,
}: {
  correlation: VisibilityCorrelation | null;
}) {
  if (!correlation) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 bg-[--bg-secondary] p-10 text-center text-sm text-white/55">
        Could not load correlation data — check the GSC and AIO crons in the
        admin dashboard.
      </div>
    );
  }

  const c = correlation;

  // Empty state when neither side is connected. We render a single banner
  // explaining the chart's purpose so the operator knows what they're
  // missing rather than seeing a blank canvas.
  if (!c.gscConnected && !c.hasAioCaptures) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 bg-[--bg-secondary] p-10 text-sm text-white/55">
        <h3 className="mb-2 font-[family-name:var(--font-jakarta)] text-base font-semibold text-white">
          What this chart will show
        </h3>
        <p className="max-w-2xl">
          Daily organic clicks/impressions from Search Console plotted alongside
          AI Overview capture markers — so you can see whether Google&apos;s AIO
          panel triggering correlates with drops in organic traffic for this
          firm&apos;s queries. Connect Search Console (Settings → Search Console)
          and let the AIO cron run for at least a week to populate this view.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Tile row — totals over the requested window */}
      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile
          label="Clicks (30d)"
          value={c.totalClicks.toLocaleString('en-US')}
          detail={c.gscConnected ? 'sum across all queries' : 'GSC not connected'}
          tone={c.totalClicks > 0 ? 'good' : 'neutral'}
        />
        <StatTile
          label="Impressions (30d)"
          value={c.totalImpressions.toLocaleString('en-US')}
          detail={
            c.avgPosition != null
              ? `avg position ${c.avgPosition.toFixed(1)}`
              : c.gscConnected
                ? 'no impressions yet'
                : 'GSC not connected'
          }
          tone={c.totalImpressions > 0 ? 'good' : 'neutral'}
        />
        <StatTile
          label="AIO triggers"
          value={`${c.totalAioTriggered} / ${c.totalAioCaptures}`}
          detail={
            c.totalAioCaptures === 0
              ? 'no captures yet'
              : `${Math.round((c.totalAioTriggered / Math.max(1, c.totalAioCaptures)) * 100)}% of captures had AIO`
          }
          tone={c.totalAioTriggered > 0 ? 'bad' : 'neutral'}
        />
        <StatTile
          label="AIO firm cited"
          value={String(c.totalAioFirmCited)}
          detail={
            c.totalAioTriggered === 0
              ? 'no AIO triggers'
              : c.totalAioFirmCited > 0
                ? `cited in ${Math.round((c.totalAioFirmCited / c.totalAioTriggered) * 100)}% of AIO triggers`
                : 'firm not cited in any AIO yet'
          }
          tone={c.totalAioFirmCited > 0 ? 'good' : 'bad'}
        />
      </div>

      {/* Connection-state banners */}
      {!c.gscConnected && (
        <div className="rounded-xl border border-[--rag-yellow]/30 bg-[--rag-yellow-bg] px-4 py-3 text-sm text-[--rag-yellow]">
          GSC isn&apos;t connected — clicks/impressions will read 0. Connect
          Search Console from <strong>Settings → Search Console</strong> to
          light up the GSC line on this chart.
        </div>
      )}
      {!c.hasAioCaptures && c.gscConnected && (
        <div className="rounded-xl border border-white/10 bg-[--bg-secondary] px-4 py-3 text-sm text-white/55">
          No AIO captures in the last 30 days. The weekly capture cron runs
          Tuesdays 10:00 UTC; you can also trigger ad-hoc captures from the
          <strong> AI Overviews </strong> tab.
        </div>
      )}

      {/* The chart itself */}
      <CorrelationChart daily={c.daily} />

      {/* Honest framing footer */}
      <p className="font-[family-name:var(--font-geist-mono)] text-[11px] text-white/40">
        Daily clicks line is computed from <code>gsc_daily_metric</code> (UTC
        days). AIO markers are bucketed by capture <code>fetched_at</code> —
        sparse by design (one capture per query per scheduled run). Not a
        causal model: a coincident click drop and AIO trigger doesn&apos;t mean
        AIO ate the clicks; it&apos;s a useful prompt for an investigation.
      </p>
    </div>
  );
}

function CorrelationChart({
  daily,
}: {
  daily: VisibilityCorrelation['daily'];
}) {
  // Chart geometry. Use viewBox-based SVG so it scales responsively.
  const W = 1200;
  const H = 280;
  const PAD_L = 50;
  const PAD_R = 16;
  const PAD_T = 16;
  const PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  if (daily.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-6 text-sm text-white/55">
        No daily rows in the requested window.
      </div>
    );
  }

  const maxClicks = Math.max(1, ...daily.map((d) => d.clicks));
  const maxImpressions = Math.max(1, ...daily.map((d) => d.impressions));

  const xFor = (i: number) =>
    PAD_L + (innerW * i) / Math.max(1, daily.length - 1);
  const yForClicks = (v: number) =>
    PAD_T + innerH * (1 - v / maxClicks);
  const yForImpressions = (v: number) =>
    PAD_T + innerH * (1 - v / maxImpressions);

  // Build the line paths
  const clicksPath = daily
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yForClicks(d.clicks).toFixed(1)}`)
    .join(' ');
  const impressionsPath = daily
    .map(
      (d, i) =>
        `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yForImpressions(d.impressions).toFixed(1)}`,
    )
    .join(' ');

  // Y-axis tick positions (left axis = clicks; right unused in v1).
  const tickValues = [0, 0.25, 0.5, 0.75, 1].map((p) => p * maxClicks);

  // X-axis labels — pick ~6 evenly spaced dates so we don't crowd.
  const xLabelStep = Math.max(1, Math.floor(daily.length / 6));

  return (
    <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs">
        <LegendDot color="rgba(250, 204, 21, 0.95)" label="Daily clicks (left axis)" />
        <LegendDot color="rgba(255,255,255,0.35)" label="Daily impressions (scaled)" />
        <LegendDot color="rgba(248, 113, 113, 0.9)" label="AIO triggered" shape="square" />
        <LegendDot color="rgba(34, 197, 94, 0.95)" label="AIO firm cited" shape="square" />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img">
        {/* Grid */}
        {tickValues.map((tv, i) => {
          const y = yForClicks(tv);
          return (
            <g key={`g-${i}`}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y}
                y2={y}
                stroke="rgba(255,255,255,0.06)"
                strokeWidth={1}
              />
              <text
                x={PAD_L - 6}
                y={y + 4}
                textAnchor="end"
                fontSize="10"
                fill="rgba(255,255,255,0.45)"
                fontFamily="ui-monospace, Consolas, monospace"
              >
                {Math.round(tv).toLocaleString('en-US')}
              </text>
            </g>
          );
        })}

        {/* Impressions line (faint background) */}
        <path
          d={impressionsPath}
          stroke="rgba(255,255,255,0.18)"
          strokeWidth="1.5"
          fill="none"
          strokeDasharray="3 3"
        />

        {/* Clicks line (foreground) */}
        <path
          d={clicksPath}
          stroke="rgba(250, 204, 21, 0.95)"
          strokeWidth="2"
          fill="none"
        />

        {/* AIO markers — small squares above the chart base for any day with captures */}
        {daily.map((d, i) => {
          if (d.aioCaptureCount === 0) return null;
          const x = xFor(i);
          // Triggered = red square; firm cited = green square overlapping;
          // we render both so an "AIO triggered AND we got cited" day looks
          // like the green dot.
          return (
            <g key={`aio-${i}`}>
              {d.aioTriggeredCount > 0 && (
                <rect
                  x={x - 4}
                  y={PAD_T - 2}
                  width={8}
                  height={8}
                  fill="rgba(248, 113, 113, 0.9)"
                  rx={1.5}
                />
              )}
              {d.aioFirmCitedCount > 0 && (
                <rect
                  x={x - 3}
                  y={PAD_T - 1}
                  width={6}
                  height={6}
                  fill="rgba(34, 197, 94, 0.95)"
                  rx={1}
                />
              )}
            </g>
          );
        })}

        {/* X-axis tick labels */}
        {daily.map((d, i) => {
          if (i % xLabelStep !== 0 && i !== daily.length - 1) return null;
          const x = xFor(i);
          // YYYY-MM-DD → MM-DD for compactness
          const label = d.date.slice(5);
          return (
            <text
              key={`x-${i}`}
              x={x}
              y={H - PAD_B + 16}
              textAnchor="middle"
              fontSize="10"
              fill="rgba(255,255,255,0.45)"
              fontFamily="ui-monospace, Consolas, monospace"
            >
              {label}
            </text>
          );
        })}

        {/* Axis lines */}
        <line
          x1={PAD_L}
          x2={W - PAD_R}
          y1={H - PAD_B}
          y2={H - PAD_B}
          stroke="rgba(255,255,255,0.15)"
          strokeWidth={1}
        />
        <line
          x1={PAD_L}
          x2={PAD_L}
          y1={PAD_T}
          y2={H - PAD_B}
          stroke="rgba(255,255,255,0.15)"
          strokeWidth={1}
        />
      </svg>
    </div>
  );
}

function LegendDot({
  color,
  label,
  shape = 'circle',
}: {
  color: string;
  label: string;
  shape?: 'circle' | 'square';
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-white/55">
      <span
        className="inline-block"
        style={{
          width: 10,
          height: 10,
          background: color,
          borderRadius: shape === 'circle' ? '50%' : 2,
        }}
      />
      {label}
    </span>
  );
}

function DomainList({
  label,
  color,
  domains,
}: {
  label: string;
  color: 'green' | 'red';
  domains: string[];
}) {
  const accent = color === 'green' ? 'text-[--rag-green]' : 'text-[--rag-red]';
  return (
    <div>
      <p className={`mb-2 text-xs font-medium uppercase tracking-widest ${accent}`}>
        {label}
      </p>
      {domains.length === 0 ? (
        <p className="text-sm text-white/30">—</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {domains.map((d) => (
            <li key={d}>
              <a
                href={`https://${d}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-[family-name:var(--font-geist-mono)] text-white/70 hover:text-white/90 hover:underline"
              >
                {d}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Shared mini-components ─────────────────────────────────
function StatTile({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'good' | 'bad' | 'neutral';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-[--rag-green]'
      : tone === 'bad'
        ? 'text-[--rag-red]'
        : 'text-white';
  return (
    <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
      <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
        {label}
      </div>
      <div className={`mt-2 font-[family-name:var(--font-jakarta)] text-xl font-bold ${toneClass}`}>
        {value}
      </div>
      <div className="mt-1 text-xs text-white/40">{detail}</div>
    </div>
  );
}

function EmptyTab({
  message,
  cta,
}: {
  message: string;
  cta?: { href: string; label: string };
}) {
  return (
    <div className="rounded-xl border border-dashed border-white/10 bg-[--bg-secondary] p-10 text-center">
      <p className="text-sm text-white/55">{message}</p>
      {cta && (
        <Link
          href={cta.href}
          className="mt-3 inline-flex items-center gap-1.5 text-sm text-[--accent] hover:underline"
        >
          {cta.label}
          <ExternalLink size={12} />
        </Link>
      )}
    </div>
  );
}
