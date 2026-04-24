'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  BadgeDollarSign,
  Building2,
  CheckCircle2,
  Loader2,
  Save,
  Trash2,
  TrendingUp,
  Wand2,
} from 'lucide-react';
import {
  deleteFirm,
  updateFirmBudget,
  updateFirmMetadata,
  type FirmSettingsBundle,
} from '../../../actions/settings-actions';
import type { FirmType } from '../../../actions/firm-actions';
import type { CostBreakdown } from '../../../lib/cost/telemetry';

/**
 * Client shell for the Settings page.
 *
 * State model:
 *   - `bundle` is the source of truth; every successful mutation updates it
 *     locally and then calls `router.refresh()` to pick up anything we
 *     didn't mirror (e.g., budget status recomputation).
 *   - Each section has its own `savedAt` so we can show a transient
 *     confirmation without interfering with the other sections.
 *   - The delete form is separate from the metadata form because its
 *     confirmation requirement (type the firm name exactly) differs
 *     materially from the name-edit flow.
 */

const FIRM_TYPE_OPTIONS: Array<{ value: FirmType; label: string }> = [
  { value: 'law_firm', label: 'Law Firm' },
  { value: 'dental_practice', label: 'Dental Practice' },
  { value: 'marketing_agency', label: 'Marketing Agency' },
  { value: 'other', label: 'Other' },
];

export function SettingsClient({
  firmSlug,
  initialBundle,
}: {
  firmSlug: string;
  initialBundle: FirmSettingsBundle;
}) {
  const [bundle, setBundle] = useState(initialBundle);

  return (
    <div className="flex flex-col gap-8">
      <BudgetSection
        firmSlug={firmSlug}
        bundle={bundle}
        onSaved={(next) =>
          setBundle((b) => ({ ...b, budget: next.budget, budgetNote: next.budgetNote }))
        }
      />
      <CostTelemetrySection bundle={bundle} />
      <MetadataSection
        firmSlug={firmSlug}
        bundle={bundle}
        onSaved={(firm) => setBundle((b) => ({ ...b, firm }))}
      />
      <DangerZoneSection firmSlug={firmSlug} bundle={bundle} />
    </div>
  );
}

// ─── Budget ────────────────────────────────────────────────────────────────

function BudgetSection({
  firmSlug,
  bundle,
  onSaved,
}: {
  firmSlug: string;
  bundle: FirmSettingsBundle;
  onSaved: (next: { budget: FirmSettingsBundle['budget']; budgetNote: string | null }) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [cap, setCap] = useState<string>(
    bundle.budget.source === 'firm' ? String(bundle.budget.monthlyCapUsd) : '',
  );
  const [note, setNote] = useState<string>(bundle.budgetNote ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setError(null);
    setSaved(false);
    const raw = cap.trim();
    // Empty cap = "reset to env default" (the backend treats `null` as delete).
    const capUsd = raw === '' ? null : Number.parseFloat(raw);
    if (capUsd !== null && (!Number.isFinite(capUsd) || capUsd < 0)) {
      setError('Monthly cap must be a non-negative number, or blank to reset to default.');
      return;
    }
    startTransition(async () => {
      const result = await updateFirmBudget(firmSlug, capUsd, note.trim() || null);
      if (!('ok' in result) || !result.ok) {
        setError('error' in result ? result.error : 'Failed to update budget');
        return;
      }
      onSaved({ budget: result.budget, budgetNote: note.trim() || null });
      setSaved(true);
      router.refresh();
    });
  };

  const b = bundle.budget;
  const tone = b.overBudget ? 'danger' : b.nearCap ? 'warning' : 'normal';
  const toneBorder =
    tone === 'danger'
      ? 'border-red-500/40'
      : tone === 'warning'
        ? 'border-amber-500/40'
        : 'border-white/10';
  const toneValue =
    tone === 'danger'
      ? 'text-red-300'
      : tone === 'warning'
        ? 'text-amber-300'
        : 'text-white';

  const percent = b.monthlyCapUsd > 0
    ? Math.min(100, Math.round((b.spentThisMonthUsd / b.monthlyCapUsd) * 100))
    : 0;

  return (
    <SectionCard
      icon={BadgeDollarSign}
      title="Monthly LLM Budget"
      description="Caps total spend on audits and rewrite drafts per UTC month. Cron schedulers skip any firm already over cap. Leave blank to fall back to the workspace default."
    >
      <div className={`mb-5 rounded-xl border bg-[--bg-secondary] p-5 ${toneBorder}`}>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
              This month
            </div>
            <div className={`mt-1 font-[family-name:var(--font-jakarta)] text-2xl font-bold ${toneValue}`}>
              ${b.spentThisMonthUsd.toFixed(2)}{' '}
              <span className="text-sm font-normal text-white/50">
                / ${b.monthlyCapUsd.toFixed(2)}
              </span>
            </div>
            <div className="mt-1 text-xs text-white/40">
              {b.source === 'firm' ? 'firm cap' : 'default cap'} ·{' '}
              {b.overBudget
                ? 'over cap — audits paused'
                : b.nearCap
                  ? 'within 10% of cap'
                  : `$${b.remainingUsd.toFixed(2)} remaining`}
            </div>
          </div>
          <div className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
            {percent}%
          </div>
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/5">
          <div
            className={`h-full rounded-full transition-all ${
              tone === 'danger'
                ? 'bg-red-500'
                : tone === 'warning'
                  ? 'bg-amber-500'
                  : 'bg-[--accent]'
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <LabeledInput
          label="Monthly cap (USD)"
          helper="Blank = reset to default"
          type="number"
          step="1"
          min="0"
          value={cap}
          onChange={setCap}
          placeholder="e.g. 100"
        />
        <LabeledInput
          label="Note (optional)"
          helper="Who set this and why"
          type="text"
          value={note}
          onChange={setNote}
          placeholder="e.g. Paid pilot — approved by J."
          wide
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <PrimaryButton onClick={handleSave} pending={isPending} icon={Save}>
          Save budget
        </PrimaryButton>
        {saved && !isPending && (
          <span className="inline-flex items-center gap-1.5 text-xs text-[--rag-green]">
            <CheckCircle2 size={14} strokeWidth={1.5} />
            Saved
          </span>
        )}
      </div>

      {error && <ErrorBanner message={error} />}
    </SectionCard>
  );
}

// ─── Cost telemetry ────────────────────────────────────────────────────────

function CostTelemetrySection({ bundle }: { bundle: FirmSettingsBundle }) {
  const { monthToDate, trailingYear } = bundle;

  // Chart uses the max total across the window for the y-axis so we don't
  // over-emphasize tiny month-to-month variation in a new firm.
  const maxTotal = useMemo(
    () => Math.max(1, ...trailingYear.map((m) => m.total)),
    [trailingYear],
  );

  return (
    <SectionCard
      icon={TrendingUp}
      title="Cost Telemetry"
      description="Month-to-date breakdown plus the trailing twelve UTC months. Audits are scheduler-driven (weekly + daily top-20); rewrites are operator-initiated from the Suppression queue."
    >
      {/* MTD tiles */}
      <div className="grid gap-3 sm:grid-cols-3">
        <CostTile
          icon={BadgeDollarSign}
          label="Total this month"
          value={monthToDate.total}
          tone="accent"
        />
        <CostTile
          icon={TrendingUp}
          label="Audits"
          value={monthToDate.audits}
          tone="neutral"
        />
        <CostTile
          icon={Wand2}
          label="Rewrite drafts"
          value={monthToDate.rewrites}
          tone="neutral"
        />
      </div>

      {/* 12-month stacked bar chart */}
      <div className="mt-6 rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
            12-month spend
          </div>
          <div className="flex items-center gap-3 text-[10px] text-white/55">
            <LegendSwatch color="bg-[--accent]" label="Audits" />
            <LegendSwatch color="bg-purple-400" label="Rewrites" />
          </div>
        </div>
        <div className="flex h-40 items-end gap-1">
          {trailingYear.map((m) => (
            <BarColumn key={m.month} month={m} maxTotal={maxTotal} />
          ))}
        </div>
        <div className="mt-2 flex justify-between font-[family-name:var(--font-geist-mono)] text-[10px] text-white/30">
          <span>{trailingYear[0]?.month ?? ''}</span>
          <span>{trailingYear[trailingYear.length - 1]?.month ?? ''}</span>
        </div>
      </div>
    </SectionCard>
  );
}

function CostTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof BadgeDollarSign;
  label: string;
  value: number;
  tone: 'accent' | 'neutral';
}) {
  const valueClass = tone === 'accent' ? 'text-[--accent]' : 'text-white';
  return (
    <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-widest text-white/40">
        <Icon size={12} strokeWidth={1.5} />
        {label}
      </div>
      <div className={`mt-2 font-[family-name:var(--font-jakarta)] text-2xl font-bold ${valueClass}`}>
        ${value.toFixed(2)}
      </div>
    </div>
  );
}

function BarColumn({ month, maxTotal }: { month: CostBreakdown; maxTotal: number }) {
  // Two stacked segments per month: audits (bottom) + rewrites (top). Empty
  // months render as a faint baseline so the viewer can see the axis.
  const auditsPct = (month.audits / maxTotal) * 100;
  const rewritesPct = (month.rewrites / maxTotal) * 100;
  const hasSpend = month.total > 0;
  return (
    <div className="group flex flex-1 flex-col items-center gap-1">
      <div className="relative flex h-full w-full flex-col justify-end">
        {/* Invisible wrapper gives the tooltip something to anchor against */}
        <div className="pointer-events-none absolute -top-10 left-1/2 z-10 -translate-x-1/2 rounded-md border border-white/10 bg-black/80 px-2 py-1 text-[10px] font-[family-name:var(--font-geist-mono)] text-white/90 opacity-0 transition-opacity group-hover:opacity-100">
          {month.month}: ${month.total.toFixed(2)}
        </div>
        {hasSpend ? (
          <>
            <div
              className="w-full rounded-t-sm bg-purple-400"
              style={{ height: `${rewritesPct}%` }}
              title={`Rewrites: $${month.rewrites.toFixed(2)}`}
            />
            <div
              className={`w-full bg-[--accent] ${rewritesPct === 0 ? 'rounded-t-sm' : ''}`}
              style={{ height: `${auditsPct}%` }}
              title={`Audits: $${month.audits.toFixed(2)}`}
            />
          </>
        ) : (
          <div className="h-[2px] w-full bg-white/10" />
        )}
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-sm ${color}`} />
      {label}
    </span>
  );
}

// ─── Metadata ──────────────────────────────────────────────────────────────

function MetadataSection({
  firmSlug,
  bundle,
  onSaved,
}: {
  firmSlug: string;
  bundle: FirmSettingsBundle;
  onSaved: (firm: FirmSettingsBundle['firm']) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(bundle.firm.name);
  const [firmType, setFirmType] = useState<FirmType>(bundle.firm.firm_type);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateFirmMetadata(firmSlug, {
        name,
        firm_type: firmType,
      });
      if (!('ok' in result) || !result.ok) {
        setError('error' in result ? result.error : 'Failed to save');
        return;
      }
      onSaved(result.firm);
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <SectionCard
      icon={Building2}
      title="Firm Metadata"
      description="Display name and firm type. The URL slug is immutable — changing it would break bookmarks, cron references, and outbound links."
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <LabeledInput
          label="Display name"
          type="text"
          value={name}
          onChange={setName}
          wide
        />
        <div className="flex-1">
          <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-widest text-white/40">
            Firm type
          </label>
          <select
            value={firmType}
            onChange={(e) => setFirmType(e.target.value as FirmType)}
            className="w-full rounded-lg border border-white/10 bg-[--bg-secondary] px-3 py-2 text-sm text-white focus:border-[--accent] focus:outline-none"
          >
            {FIRM_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[10px] text-white/30">
            Drives Brand Truth editor rendering.
          </p>
        </div>
      </div>

      <div className="mt-3 font-[family-name:var(--font-geist-mono)] text-xs text-white/30">
        slug: /{bundle.firm.slug} (immutable)
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <PrimaryButton onClick={handleSave} pending={isPending} icon={Save}>
          Save metadata
        </PrimaryButton>
        {saved && !isPending && (
          <span className="inline-flex items-center gap-1.5 text-xs text-[--rag-green]">
            <CheckCircle2 size={14} strokeWidth={1.5} />
            Saved
          </span>
        )}
      </div>

      {error && <ErrorBanner message={error} />}
    </SectionCard>
  );
}

// ─── Danger Zone ───────────────────────────────────────────────────────────

function DangerZoneSection({
  firmSlug,
  bundle,
}: {
  firmSlug: string;
  bundle: FirmSettingsBundle;
}) {
  const [confirm, setConfirm] = useState('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const canDelete = confirm.trim() === bundle.firm.name;

  const handleDelete = () => {
    if (!canDelete) {
      setError(`Type "${bundle.firm.name}" exactly to confirm.`);
      return;
    }
    setError(null);
    startTransition(async () => {
      // `deleteFirm` redirects on success. We only get a return value on
      // failure, so successful deletion simply never resolves this promise
      // from the client's perspective.
      const result = await deleteFirm(firmSlug, confirm.trim()).catch(() => null);
      if (result && 'error' in result) setError(result.error);
    });
  };

  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-5">
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle size={16} strokeWidth={1.5} className="text-red-400" />
        <h3 className="font-[family-name:var(--font-jakarta)] text-lg font-semibold text-red-200">
          Danger Zone
        </h3>
      </div>
      <p className="mb-4 text-sm text-white/70">
        Permanently deletes this firm and every row scoped to it: audit
        history, Brand Truth versions, suppression findings, rewrite drafts,
        competitor roster, Reddit mentions, monthly reports. There is no
        undo. Cascades are configured at the database layer.
      </p>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <LabeledInput
          label="Type the firm name to confirm"
          helper={`Must match exactly: "${bundle.firm.name}"`}
          type="text"
          value={confirm}
          onChange={setConfirm}
          placeholder={bundle.firm.name}
          wide
        />
        <button
          type="button"
          onClick={handleDelete}
          disabled={!canDelete || isPending}
          className="inline-flex items-center gap-2 whitespace-nowrap rounded-full bg-red-500/20 px-5 py-2.5 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
          ) : (
            <Trash2 size={14} strokeWidth={1.5} />
          )}
          Delete firm permanently
        </button>
      </div>

      {error && <ErrorBanner message={error} tone="danger" />}
    </div>
  );
}

// ─── Shared atoms ──────────────────────────────────────────────────────────

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof BadgeDollarSign;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[--bg-secondary]/40 p-6">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/5">
          <Icon size={18} strokeWidth={1.5} className="text-[--accent]" />
        </div>
        <div>
          <h2 className="font-[family-name:var(--font-jakarta)] text-lg font-semibold text-white">
            {title}
          </h2>
          <p className="mt-1 text-sm text-white/55">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function LabeledInput({
  label,
  helper,
  wide,
  onChange,
  type,
  step,
  min,
  value,
  placeholder,
}: {
  label: string;
  helper?: string;
  wide?: boolean;
  onChange: (v: string) => void;
  type: string;
  step?: string;
  min?: string;
  value: string;
  placeholder?: string;
}) {
  return (
    <div className={wide ? 'flex-[2_1_0%]' : 'flex-1'}>
      <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-widest text-white/40">
        {label}
      </label>
      <input
        type={type}
        step={step}
        min={min}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-[--bg-secondary] px-3 py-2 text-sm text-white placeholder-white/30 focus:border-[--accent] focus:outline-none"
      />
      {helper && <p className="mt-1 text-[10px] text-white/30">{helper}</p>}
    </div>
  );
}

function PrimaryButton({
  onClick,
  pending,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  pending: boolean;
  icon: typeof Save;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="inline-flex items-center gap-2 rounded-full bg-[--accent] px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[--accent-hover] disabled:opacity-60"
    >
      {pending ? (
        <Loader2 size={14} strokeWidth={2} className="animate-spin" />
      ) : (
        <Icon size={14} strokeWidth={2} />
      )}
      {children}
    </button>
  );
}

function ErrorBanner({
  message,
  tone = 'warning',
}: {
  message: string;
  tone?: 'warning' | 'danger';
}) {
  const cls =
    tone === 'danger'
      ? 'border-red-500/30 bg-red-500/10 text-red-300'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return (
    <div className={`mt-4 rounded-lg border px-4 py-3 text-sm ${cls}`}>
      {message}
    </div>
  );
}
