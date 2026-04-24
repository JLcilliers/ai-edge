'use client';

import Link from 'next/link';
import { useState } from 'react';
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
} from 'lucide-react';
import type {
  ShareOfVoiceResult,
  CitationSourceGraph,
  CitationDriftRow,
  AlignmentRegression,
} from '../../../actions/visibility-actions';

type Tab = 'share' | 'sources' | 'drift';

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
}: {
  firmSlug: string;
  firmName: string;
  shareOfVoice: ShareOfVoiceResult;
  sourceGraph: CitationSourceGraph;
  driftHistory: CitationDriftRow[];
  regression: AlignmentRegression;
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
      </div>

      {tab === 'share' && (
        <ShareOfVoiceView firmSlug={firmSlug} firmName={firmName} data={shareOfVoice} />
      )}
      {tab === 'sources' && <CitationSourcesView data={sourceGraph} />}
      {tab === 'drift' && <DriftView history={driftHistory} firmSlug={firmSlug} />}
    </>
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
        <p className="mt-2 font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
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
              <span className="w-24 text-right font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
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
            <div className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
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
