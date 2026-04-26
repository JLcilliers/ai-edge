import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  FileText,
  ClipboardCheck,
  MessageSquare,
  ArrowRight,
  Scale,
  Stethoscope,
  Megaphone,
  HelpCircle,
  Building2,
  Users,
  FileX,
  Database,
  ShieldCheck,
  FileBarChart,
  Eye,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  FlaskConical,
} from 'lucide-react';
import {
  getFirmBySlug,
  getFirmSummary,
  type FirmType,
} from '../../actions/firm-actions';
import {
  getAlignmentRegression,
  type AlignmentRegression,
} from '../../actions/visibility-actions';
import {
  getAlignmentTrend,
  getLatestScoringRunPair,
  type AlignmentTrendPoint,
} from '../../actions/audit-diff-actions';
import type { FirmBudgetStatus } from '../../lib/audit/budget';

export const dynamic = 'force-dynamic';

const FIRM_TYPE_LABEL: Record<FirmType, string> = {
  law_firm: 'Law Firm',
  dental_practice: 'Dental Practice',
  marketing_agency: 'Marketing Agency',
  other: 'Other',
};

const FIRM_TYPE_ICON: Record<FirmType, typeof Building2> = {
  law_firm: Scale,
  dental_practice: Stethoscope,
  marketing_agency: Megaphone,
  other: HelpCircle,
};

function formatDate(d: Date | null | undefined) {
  if (!d) return 'never';
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function FirmOverviewPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const [summary, regression, trend, runPair] = await Promise.all([
    getFirmSummary(firmSlug).catch(() => null),
    getAlignmentRegression(firmSlug).catch(() => null),
    getAlignmentTrend(firmSlug, { limit: 10 }).catch(() => [] as AlignmentTrendPoint[]),
    getLatestScoringRunPair(firmSlug).catch(() => ({
      latestRunId: null,
      previousRunId: null,
    })),
  ]);
  const Icon = FIRM_TYPE_ICON[firm.firm_type];

  return (
    <div>
      {/* Header */}
      <div className="mb-10 flex items-start gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-white/5">
          <Icon size={28} strokeWidth={1.5} className="text-[--accent]" />
        </div>
        <div className="flex-1">
          <div className="mb-2 flex items-center gap-3">
            <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
              {firm.name}
            </h1>
            <span className="rounded-full border border-white/10 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/55">
              {FIRM_TYPE_LABEL[firm.firm_type]}
            </span>
          </div>
          <p className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
            /{firm.slug} · added {formatDate(firm.created_at)}
          </p>
        </div>
      </div>

      {/* Alignment regression banner — only when red% moved ≥5pp in either direction. */}
      {regression ? (
        <OverviewRegressionBanner
          firmSlug={firmSlug}
          regression={regression}
          latestRunId={runPair.latestRunId}
          previousRunId={runPair.previousRunId}
        />
      ) : null}

      {/* Alignment trend sparkline — last 10 scoring runs */}
      {trend.length > 0 ? (
        <AlignmentTrendStrip firmSlug={firmSlug} trend={trend} />
      ) : null}

      {/* Headline stats */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Brand Truth"
          value={
            summary?.latestBrandTruthVersion
              ? `v${summary.latestBrandTruthVersion}`
              : 'not set'
          }
          detail={
            summary?.latestBrandTruthUpdatedAt
              ? `updated ${formatDate(summary.latestBrandTruthUpdatedAt)}`
              : 'configure to start auditing'
          }
        />
        <StatTile
          label="Last Audit"
          value={formatDate(summary?.lastAudit?.startedAt ?? null)}
          detail={summary?.lastAudit?.status ?? 'no runs yet'}
        />
        <StatTile
          label="Reddit Scan"
          value={formatDate(summary?.lastRedditScan?.startedAt ?? null)}
          detail={summary?.lastRedditScan?.status ?? 'no scans yet'}
        />
        <StatTile
          label="Reddit Mentions"
          value={String(summary?.redditMentionCount ?? 0)}
          detail="across all scans"
        />
        <BudgetTile budget={summary?.budget ?? null} />
      </div>

      {/* Module cards */}
      <h2 className="mb-4 font-[family-name:var(--font-jakarta)] text-sm font-semibold uppercase tracking-widest text-white/55">
        Modules
      </h2>
      <div className="grid gap-4 md:grid-cols-3">
        <ModuleCard
          href={`/dashboard/${firmSlug}/brand-truth`}
          icon={FileText}
          title="Brand Truth"
          description="How AI should describe this client. The source-of-truth payload every audit checks against."
          cta={
            summary?.latestBrandTruthVersion
              ? `Edit v${summary.latestBrandTruthVersion}`
              : 'Set up Brand Truth'
          }
        />
        <ModuleCard
          href={`/dashboard/${firmSlug}/audits`}
          icon={ClipboardCheck}
          title="Trust Alignment Audits"
          description="Run LLM prompts across GPT / Claude / Gemini and score how they describe this client vs Brand Truth."
          cta="Run & review audits"
        />
        <ModuleCard
          href={`/dashboard/${firmSlug}/visibility`}
          icon={Eye}
          title="Brand Visibility"
          description="Share-of-voice vs competitors, the domains LLMs cite as sources, and how citation sets drift between runs."
          cta="Explore visibility"
        />
        <ModuleCard
          href={`/dashboard/${firmSlug}/reddit`}
          icon={MessageSquare}
          title="Reddit Sentiment"
          description="What Redditors say about this client, and what prospects are asking. High-weight LLM citation source."
          cta="Scan & review mentions"
        />
        <ModuleCard
          href={`/dashboard/${firmSlug}/competitors`}
          icon={Users}
          title="Competitors"
          description="Track rival firms across audits — share-of-mention, praise asymmetry, and whose websites the LLMs cite instead of ours."
          cta="Manage roster"
        />
        <ModuleCard
          href={`/dashboard/${firmSlug}/suppression`}
          icon={FileX}
          title="Legacy Suppression"
          description="Find site pages that drift from the Brand Truth and queue them for rewrite or noindex. Drifting pages poison LLM alignment."
          cta="Scan & triage pages"
        />
        <ModuleCard
          href={`/dashboard/${firmSlug}/entity`}
          icon={Database}
          title="Entity & Schema"
          description="Check schema.org coverage + Wikidata / Google KG presence. Generate copy-paste JSON-LD patches for gaps."
          cta="Run entity scan"
        />
        <ModuleCard
          href={`/dashboard/${firmSlug}/compliance`}
          icon={ShieldCheck}
          title="Compliance Check"
          description="Paste remediation copy, an ad, or an email and flag banned claims from the jurisdictional rulebook + firm's own banned phrases."
          cta="Validate copy"
        />
        <ModuleCard
          href={`/dashboard/${firmSlug}/reports`}
          icon={FileBarChart}
          title="Monthly Reports"
          description="Per-firm month-in-review: audit RAG totals, reddit sentiment, competitor share, suppression queue, entity divergences. Downloadable JSON."
          cta="View & rebuild"
        />
        <ModuleCard
          href={`/dashboard/${firmSlug}/scenarios`}
          icon={FlaskConical}
          title="Scenario Lab"
          description="Predict directional rank impact of a proposed content change before you ship it. Calibrated against this firm's observed SERPs via PSO."
          cta="Run a scenario"
        />
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
      <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
        {label}
      </div>
      <div className="mt-2 font-[family-name:var(--font-jakarta)] text-xl font-bold text-white">
        {value}
      </div>
      <div className="mt-1 text-xs text-white/40">{detail}</div>
    </div>
  );
}

/**
 * Monthly LLM spend tile with over-cap / near-cap color state.
 *
 * over-cap  → red border + red value + "audits paused" detail (the crons
 *             skip over-cap firms; they need to notice)
 * near-cap  → amber border + amber value (within 10% of cap)
 * normal    → default styling
 */
function BudgetTile({ budget }: { budget: FirmBudgetStatus | null }) {
  if (!budget) {
    return (
      <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
        <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
          LLM Budget
        </div>
        <div className="mt-2 font-[family-name:var(--font-jakarta)] text-xl font-bold text-white">
          —
        </div>
        <div className="mt-1 text-xs text-white/40">unavailable</div>
      </div>
    );
  }

  const tone: 'danger' | 'warning' | 'normal' = budget.overBudget
    ? 'danger'
    : budget.nearCap
      ? 'warning'
      : 'normal';

  const borderClass =
    tone === 'danger'
      ? 'border-red-500/40'
      : tone === 'warning'
        ? 'border-amber-500/40'
        : 'border-white/10';

  const valueClass =
    tone === 'danger'
      ? 'text-red-300'
      : tone === 'warning'
        ? 'text-amber-300'
        : 'text-white';

  const detailText =
    tone === 'danger'
      ? 'over cap — audits paused'
      : tone === 'warning'
        ? 'within 10% of cap'
        : budget.source === 'firm'
          ? 'this month (firm cap)'
          : 'this month (default cap)';

  return (
    <div className={`rounded-xl border bg-[--bg-secondary] p-5 ${borderClass}`}>
      <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
        LLM Budget
      </div>
      <div
        className={`mt-2 font-[family-name:var(--font-jakarta)] text-xl font-bold ${valueClass}`}
      >
        ${budget.spentThisMonthUsd.toFixed(2)} / ${budget.monthlyCapUsd.toFixed(2)}
      </div>
      <div className="mt-1 text-xs text-white/40">{detailText}</div>
    </div>
  );
}

/**
 * Alignment-gap regression banner.
 *
 * Surfaces material movement in the red% of the last two completed scoring
 * runs (full or daily-priority). Hidden when severity is 'stable' or
 * 'insufficient_data' — no banner is better than a noisy banner.
 *
 * 'critical' (≥10pp worse) → red tone
 * 'warning'  (≥5pp worse)  → amber tone
 * 'improving' (≥5pp better) → green tone
 */
function OverviewRegressionBanner({
  firmSlug,
  regression,
  latestRunId,
  previousRunId,
}: {
  firmSlug: string;
  regression: AlignmentRegression;
  latestRunId: string | null;
  previousRunId: string | null;
}) {
  if (regression.severity === 'stable' || regression.severity === 'insufficient_data') {
    return null;
  }

  const config =
    regression.severity === 'critical'
      ? {
          border: 'border-red-500/40',
          bg: 'bg-red-500/10',
          text: 'text-red-200',
          label: 'Critical regression',
          Icon: AlertTriangle,
        }
      : regression.severity === 'warning'
        ? {
            border: 'border-amber-500/40',
            bg: 'bg-amber-500/10',
            text: 'text-amber-200',
            label: 'Alignment regression',
            Icon: TrendingUp,
          }
        : {
            border: 'border-emerald-500/40',
            bg: 'bg-emerald-500/10',
            text: 'text-emerald-200',
            label: 'Alignment improving',
            Icon: TrendingDown,
          };

  const delta = regression.redDeltaPp;
  const deltaLabel =
    regression.severity === 'improving'
      ? `${Math.abs(delta).toFixed(1)}pp lower red`
      : `${delta.toFixed(1)}pp higher red`;

  // Prefer a direct link to the diff view when we have both run IDs — that's
  // the fastest path from "something regressed" to "here's what regressed".
  // When only one run exists, fall back to Visibility (which also surfaces
  // the severity banner + citation drift context).
  const diffHref =
    latestRunId && previousRunId
      ? `/dashboard/${firmSlug}/audits/${latestRunId}/diff`
      : `/dashboard/${firmSlug}/visibility`;
  const ctaLabel =
    latestRunId && previousRunId
      ? 'See which queries moved →'
      : 'Open Visibility →';

  return (
    <Link
      href={diffHref}
      className={`mb-8 flex items-start gap-4 rounded-xl border p-4 transition-colors hover:brightness-110 ${config.border} ${config.bg}`}
    >
      <config.Icon size={20} strokeWidth={2} className={config.text} />
      <div className="flex-1">
        <div className={`text-sm font-semibold ${config.text}`}>
          {config.label} · {deltaLabel}
        </div>
        <div className="mt-1 text-xs text-white/55">
          Latest run {regression.latestRedPct.toFixed(1)}% red vs previous{' '}
          {regression.previousRedPct.toFixed(1)}% red
          {regression.latestRunStartedAt
            ? ` (${formatDate(regression.latestRunStartedAt)})`
            : ''}
          . {ctaLabel}
        </div>
      </div>
      <ArrowRight size={16} strokeWidth={2} className={config.text} />
    </Link>
  );
}

/**
 * Last-N-runs RAG mix strip. Each bar is one completed scoring run. Heights
 * are always full — we're communicating *mix*, not volume — and the three
 * segments (green/yellow/red) stack top-to-bottom. Click a bar to drill into
 * that run.
 *
 * We render inline via <div> stacks (not an SVG lib) because:
 *  - 10 bars, three segments each = 30 divs — trivial rendering cost
 *  - preserves the dashboard's Tailwind color tokens without theming a chart lib
 *  - keeps the overview server-component-only (no 'use client' tax)
 */
function AlignmentTrendStrip({
  firmSlug,
  trend,
}: {
  firmSlug: string;
  trend: AlignmentTrendPoint[];
}) {
  return (
    <div className="mb-8 rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
            Alignment Trend
          </div>
          <div className="mt-1 text-xs text-white/55">
            Last {trend.length} scoring run{trend.length === 1 ? '' : 's'} — left = oldest.
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-white/40">
          <LegendSwatch className="bg-[--rag-green]" label="green" />
          <LegendSwatch className="bg-[--rag-yellow]" label="yellow" />
          <LegendSwatch className="bg-[--rag-red]" label="red" />
        </div>
      </div>
      <div className="flex items-end gap-1.5" style={{ height: 80 }}>
        {trend.map((point) => (
          <Link
            key={point.runId}
            href={`/dashboard/${firmSlug}/audits/${point.runId}`}
            title={`${formatDate(point.startedAt)} · ${point.total} scored · ${point.redPct.toFixed(1)}% red`}
            className="group flex flex-1 flex-col overflow-hidden rounded transition-transform hover:-translate-y-0.5"
            style={{ height: '100%' }}
          >
            {/* green (top), yellow (middle), red (bottom) so "more red" visually weighs down */}
            <div
              className="w-full bg-[--rag-green] opacity-80 group-hover:opacity-100"
              style={{ height: `${point.greenPct}%` }}
            />
            <div
              className="w-full bg-[--rag-yellow] opacity-80 group-hover:opacity-100"
              style={{ height: `${point.yellowPct}%` }}
            />
            <div
              className="w-full bg-[--rag-red] opacity-80 group-hover:opacity-100"
              style={{ height: `${point.redPct}%` }}
            />
          </Link>
        ))}
      </div>
    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-2 w-2 rounded-sm ${className}`} />
      {label}
    </span>
  );
}

function ModuleCard({
  href,
  icon: Icon,
  title,
  description,
  cta,
}: {
  href: string;
  icon: typeof FileText;
  title: string;
  description: string;
  cta: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-3 rounded-xl border border-white/10 bg-[--bg-secondary] p-6 transition-colors hover:border-[--accent]/30"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/5">
        <Icon size={20} strokeWidth={1.5} className="text-[--accent]" />
      </div>
      <h3 className="font-[family-name:var(--font-jakarta)] text-lg font-bold text-white">
        {title}
      </h3>
      <p className="flex-1 text-sm text-white/55">{description}</p>
      <div className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-[--accent] transition-transform group-hover:translate-x-0.5">
        {cta}
        <ArrowRight size={14} strokeWidth={2} />
      </div>
    </Link>
  );
}
