'use client';

import { useState, useTransition, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Loader2,
  PlusCircle,
  Play,
  RefreshCw,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Database,
  ListPlus,
  Beaker,
  Lightbulb,
  Globe,
  Search,
} from 'lucide-react';
import {
  type ScenarioOverview,
  type SerpRow,
  type ScenarioRow,
  type BingCaptureUiOutcome,
  addManualSerp,
  deleteSerp,
  createScenario,
  recomputeScenario,
  deleteScenario,
  extractFeaturesForFirm,
  recrawlFeaturesViaHtml,
  captureSerpsViaBing,
  runFirmCalibration,
  previewScenario,
} from '../../../actions/scenarios-actions';

/**
 * Scenario Lab UI shell. Three tabs share a single component to keep the
 * action wiring obvious; tab switching is local state, not routing — the
 * URL stays at /scenarios and operators can come back to whatever tab they
 * were on after a server-action revalidation.
 *
 * Why a flat component (not nested files): the surface area is small (≈3
 * forms, 3 lists), each tab references shared data (overview), and the
 * action plumbing benefits from being co-located with the JSX it triggers.
 * If any tab grows past ~250 LOC, split into its own file.
 */

type Tab = 'scenarios' | 'calibration' | 'serps';

export function ScenariosClient({
  overview,
  serps,
  scenarios,
  pagesWithFeatures,
}: {
  overview: ScenarioOverview;
  serps: SerpRow[];
  scenarios: ScenarioRow[];
  pagesWithFeatures: Array<{ url: string; title: string | null; wordCount: number | null }>;
}) {
  const [tab, setTab] = useState<Tab>('scenarios');
  const tabs: Array<{ id: Tab; label: string; icon: typeof Beaker }> = [
    { id: 'scenarios', label: 'Scenarios', icon: Beaker },
    { id: 'calibration', label: 'Calibration', icon: FlaskConical },
    { id: 'serps', label: 'Observed SERPs', icon: Database },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Stat strip */}
      <StatStrip overview={overview} />

      {/* Tabs */}
      <div className="flex gap-1 rounded-xl bg-white/5 p-1">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? 'bg-[var(--bg-secondary)] text-white'
                  : 'text-white/55 hover:text-white/80'
              }`}
            >
              <Icon size={14} strokeWidth={1.5} />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'scenarios' && (
        <ScenariosTab
          firmSlug={overview.firmSlug}
          scenarios={scenarios}
          pagesWithFeatures={pagesWithFeatures}
          seedQueries={overview.seedQueries}
          serps={serps}
          weightsPresent={overview.latestWeights !== null}
        />
      )}
      {tab === 'calibration' && (
        <CalibrationTab firmSlug={overview.firmSlug} overview={overview} />
      )}
      {tab === 'serps' && (
        <SerpsTab firmSlug={overview.firmSlug} serps={serps} />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// Stat strip
// ═════════════════════════════════════════════════════════════

function StatStrip({ overview }: { overview: ScenarioOverview }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label="Scenarios"
        value={overview.scenarioCount}
        hint="Saved what-ifs"
      />
      <Tile
        label="Observed SERPs"
        value={overview.serpCount}
        hint="Calibration corpus"
      />
      <Tile
        label="Pages with features"
        value={overview.pageFeatureCount}
        hint="Extracted feature vectors"
      />
      <Tile
        label="Weights generation"
        value={overview.latestWeights?.generation ?? '—'}
        hint={
          overview.latestWeights
            ? `fitness ρ=${overview.latestWeights.fitness.toFixed(3)}`
            : 'never trained'
        }
        tone={
          !overview.latestWeights
            ? 'warn'
            : overview.latestWeights.fitness >= 0.4
              ? 'ok'
              : 'warn'
        }
      />
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'ok' | 'warn';
}) {
  const valueColor =
    tone === 'ok'
      ? 'text-[var(--rag-green)]'
      : tone === 'warn'
        ? 'text-[var(--rag-yellow)]'
        : 'text-white';
  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-4">
      <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
        {label}
      </div>
      <div className={`mt-1 font-[family-name:var(--font-jakarta)] text-xl font-bold ${valueColor}`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-white/40">{hint}</div>}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// Scenarios tab
// ═════════════════════════════════════════════════════════════

function ScenariosTab({
  firmSlug,
  scenarios,
  pagesWithFeatures,
  seedQueries,
  serps,
  weightsPresent,
}: {
  firmSlug: string;
  scenarios: ScenarioRow[];
  pagesWithFeatures: Array<{ url: string; title: string | null; wordCount: number | null }>;
  seedQueries: string[];
  serps: SerpRow[];
  weightsPresent: boolean;
}) {
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {!weightsPresent && (
        <div className="rounded-xl border border-[var(--rag-yellow)]/30 bg-[var(--rag-yellow-bg)] p-4 text-sm text-[var(--rag-yellow)]">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
            <div>
              No calibrated weights yet — every scenario will report Δscore=0
              until you run calibration. Add at least one observed SERP
              (Observed SERPs tab), extract page features (Calibration tab),
              then run calibration.
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-white/55">
          {scenarios.length === 0
            ? 'No scenarios yet. Create one to predict the directional impact of a content change.'
            : `${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}`}
        </p>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)]"
        >
          <PlusCircle size={14} strokeWidth={2} />
          {showForm ? 'Cancel' : 'New scenario'}
        </button>
      </div>

      {showForm && (
        <NewScenarioForm
          firmSlug={firmSlug}
          pagesWithFeatures={pagesWithFeatures}
          seedQueries={seedQueries}
          serps={serps}
          onClose={() => setShowForm(false)}
        />
      )}

      {scenarios.length === 0 ? (
        <EmptyHint
          icon={Beaker}
          headline="What a scenario does"
          body={
            <ul className="list-disc space-y-1 pl-5 text-sm text-white/55">
              <li>Pick a page on the firm&apos;s site (must have features extracted).</li>
              <li>Pick a target query (ideally one we have an observed SERP for).</li>
              <li>Choose a proposed change (add JSON-LD, +200 words, etc).</li>
              <li>The simulator scores baseline + competitors, applies your change, and reports Δscore + Δrank.</li>
            </ul>
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {scenarios.map((s) => (
            <ScenarioRowCard key={s.id} scenario={s} firmSlug={firmSlug} />
          ))}
        </div>
      )}
    </div>
  );
}

function ScenarioRowCard({
  scenario,
  firmSlug,
}: {
  scenario: ScenarioRow;
  firmSlug: string;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onRecompute = () => {
    setError(null);
    start(async () => {
      try {
        await recomputeScenario(firmSlug, scenario.id);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Recompute failed');
      }
    });
  };
  const onDelete = () => {
    if (!confirm(`Delete scenario "${scenario.name}"? This cannot be undone.`)) return;
    setError(null);
    start(async () => {
      try {
        await deleteScenario(firmSlug, scenario.id);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Delete failed');
      }
    });
  };

  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-[family-name:var(--font-jakarta)] text-base font-semibold text-white">
              {scenario.name}
            </h3>
            <ConfidencePill label={scenario.confidenceLabel} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-[family-name:var(--font-geist-mono)] text-[11px] text-white/40">
            <span className="truncate">{scenario.baselineUrl}</span>
            <span>·</span>
            <span>&ldquo;{scenario.query}&rdquo;</span>
            {scenario.weightsGenerationUsed != null && (
              <>
                <span>·</span>
                <span>weights gen {scenario.weightsGenerationUsed}</span>
              </>
            )}
          </div>
          {scenario.description && (
            <p className="mt-2 text-sm text-white/65">{scenario.description}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <DeltaPill
              label="Δrank"
              value={scenario.deltaRank}
              format={(n) => (n > 0 ? `+${n}` : `${n}`)}
              positiveIsGood
              suffix=""
            />
            <DeltaPill
              label="Δscore"
              value={scenario.deltaScore}
              format={(n) => (n >= 0 ? `+${n.toFixed(3)}` : `${n.toFixed(3)}`)}
              positiveIsGood
              suffix=""
            />
            {scenario.competitorCount != null && scenario.competitorCount > 0 && (
              <span className="font-[family-name:var(--font-geist-mono)] text-[11px] text-white/40">
                vs {scenario.competitorCount} competitors
              </span>
            )}
          </div>
          <ProposedChangeStrip change={scenario.proposedChange} />
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onRecompute}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/30 hover:text-white disabled:opacity-50"
            title="Re-run simulation against latest weights"
          >
            {isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} strokeWidth={2} />
            )}
            Recompute
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/55 transition-colors hover:border-[var(--rag-red)]/50 hover:text-[var(--rag-red)] disabled:opacity-50"
          >
            <Trash2 size={12} strokeWidth={2} />
          </button>
        </div>
      </div>
      {error && (
        <div className="mt-3 rounded-lg border border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] px-3 py-2 text-xs text-[var(--rag-red)]">
          {error}
        </div>
      )}
    </div>
  );
}

function ConfidencePill({ label }: { label: string | null }) {
  if (!label) return null;
  const map: Record<string, { tone: string; text: string }> = {
    directional: {
      tone: 'border-[var(--rag-green)]/30 bg-[var(--rag-green-bg)] text-[var(--rag-green)]',
      text: 'directional',
    },
    low_confidence: {
      tone: 'border-[var(--rag-yellow)]/30 bg-[var(--rag-yellow-bg)] text-[var(--rag-yellow)]',
      text: 'low confidence',
    },
    no_calibration: {
      tone: 'border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] text-[var(--rag-red)]',
      text: 'no calibration',
    },
  };
  const v = map[label] ?? map.low_confidence;
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${v?.tone ?? ''}`}
    >
      {v?.text ?? label}
    </span>
  );
}

function DeltaPill({
  label,
  value,
  format,
  positiveIsGood,
  suffix,
}: {
  label: string;
  value: number | null;
  format: (n: number) => string;
  positiveIsGood: boolean;
  suffix: string;
}) {
  if (value == null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-white/40">
        {label}: —
      </span>
    );
  }
  const positive = value > 0;
  const negative = value < 0;
  const Icon = positive ? ArrowUpRight : negative ? ArrowDownRight : Minus;
  const good = positiveIsGood ? positive : negative;
  const bad = positiveIsGood ? negative : positive;
  const tone = good
    ? 'border-[var(--rag-green)]/30 bg-[var(--rag-green-bg)] text-[var(--rag-green)]'
    : bad
      ? 'border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] text-[var(--rag-red)]'
      : 'border-white/10 bg-white/5 text-white/55';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-[family-name:var(--font-geist-mono)] text-[11px] font-semibold ${tone}`}
    >
      <Icon size={11} strokeWidth={2} />
      {label} {format(value)}
      {suffix}
    </span>
  );
}

function ProposedChangeStrip({
  change,
}: {
  change: Record<string, string | number | boolean>;
}) {
  const entries = Object.entries(change);
  if (entries.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {entries.map(([key, val]) => (
        <span
          key={key}
          className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-0.5 font-[family-name:var(--font-geist-mono)] text-[10px] text-white/55"
        >
          <span className="text-white/40">{key}</span>
          <span className="text-white/80">{String(val)}</span>
        </span>
      ))}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// New-scenario form
// ═════════════════════════════════════════════════════════════

interface ChangeTemplate {
  id: string;
  label: string;
  description: string;
  change: Record<string, string | boolean | number>;
}

const CHANGE_TEMPLATES: ChangeTemplate[] = [
  {
    id: 'add-legalservice',
    label: 'Add LegalService schema',
    description: 'Mark up the page with JSON-LD LegalService.',
    change: { has_jsonld_legalservice: true, jsonld_type_count_norm: '+0.15' },
  },
  {
    id: 'add-organization',
    label: 'Add Organization schema',
    description: 'Mark up the firm as an Organization entity.',
    change: { has_jsonld_organization: true, jsonld_type_count_norm: '+0.15' },
  },
  {
    id: 'add-faq',
    label: 'Add FAQ section + FAQPage schema',
    description: 'Author 5 FAQs at the bottom and emit FAQPage JSON-LD.',
    change: {
      has_jsonld_faqpage: true,
      faq_count_norm: '+0.5',
      jsonld_type_count_norm: '+0.15',
    },
  },
  {
    id: 'expand-content',
    label: 'Expand content (+800 words)',
    description: 'Deepen the page with 800 more words of substantive copy.',
    change: { word_count_log: '+0.2' },
  },
  {
    id: 'add-h1',
    label: 'Add a proper H1',
    description: "The page is missing a primary heading — add one tied to the query.",
    change: { has_h1: true, has_keyword_in_h1: true },
  },
  {
    id: 'add-internal-links',
    label: 'Add 10 internal links',
    description: 'Bump internal-link density to surface this page in the firm site graph.',
    change: { internal_link_density: '+0.4' },
  },
  {
    id: 'add-authoritative-citations',
    label: 'Cite 3 authoritative sources',
    description: 'Link out to .gov / state-bar / Justia equivalents.',
    change: { authoritative_external_links_norm: '+0.6' },
  },
  {
    id: 'refresh',
    label: 'Refresh the page (today)',
    description: 'Re-publish today; resets the freshness signal.',
    change: { freshness_score: '=1' },
  },
];

function NewScenarioForm({
  firmSlug,
  pagesWithFeatures,
  seedQueries,
  serps,
  onClose,
}: {
  firmSlug: string;
  pagesWithFeatures: Array<{ url: string; title: string | null; wordCount: number | null }>;
  seedQueries: string[];
  serps: SerpRow[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [baselineUrl, setBaselineUrl] = useState(pagesWithFeatures[0]?.url ?? '');
  const [query, setQuery] = useState(serps[0]?.query ?? seedQueries[0] ?? '');
  const [description, setDescription] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [customChange, setCustomChange] = useState<string>('{}');
  const [showCustom, setShowCustom] = useState(false);
  const [preview, setPreview] = useState<{
    deltaScore: number;
    deltaRank: number | null;
    confidenceLabel: string;
    competitorCount: number;
    topContributingFeatures: Array<{ feature: string; delta: number; contribution: number }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  // De-dup: SERPs queries take priority, then seed queries.
  const queryOptions = useMemo(() => {
    const set = new Set<string>();
    const out: Array<{ value: string; hint: string }> = [];
    for (const s of serps) {
      if (set.has(s.query)) continue;
      set.add(s.query);
      out.push({ value: s.query, hint: 'has SERP' });
    }
    for (const q of seedQueries) {
      if (set.has(q)) continue;
      set.add(q);
      out.push({ value: q, hint: 'no SERP yet' });
    }
    return out;
  }, [serps, seedQueries]);

  const proposedChange = useMemo(() => {
    if (showCustom) {
      try {
        const parsed = JSON.parse(customChange) as Record<string, string | number | boolean>;
        if (typeof parsed !== 'object' || parsed === null) return {};
        return parsed;
      } catch {
        return {};
      }
    }
    if (!selectedTemplate) return {};
    return CHANGE_TEMPLATES.find((t) => t.id === selectedTemplate)?.change ?? {};
  }, [selectedTemplate, customChange, showCustom]);

  const onPreview = () => {
    setError(null);
    if (!baselineUrl || !query) {
      setError('Pick a baseline URL and a query first.');
      return;
    }
    if (Object.keys(proposedChange).length === 0) {
      setError('Pick a change template (or enter custom JSON).');
      return;
    }
    start(async () => {
      try {
        const p = await previewScenario(firmSlug, {
          baselineUrl,
          query,
          proposedChange,
        });
        setPreview({
          deltaScore: p.deltaScore,
          deltaRank: p.deltaRank,
          confidenceLabel: p.confidenceLabel,
          competitorCount: p.competitorCount,
          topContributingFeatures: p.topContributingFeatures,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Preview failed');
      }
    });
  };

  const onSubmit = () => {
    setError(null);
    if (!name.trim()) {
      setError('Give the scenario a name.');
      return;
    }
    start(async () => {
      try {
        await createScenario(firmSlug, {
          name: name.trim(),
          baselineUrl,
          query,
          description: description.trim() || undefined,
          proposedChange,
        });
        onClose();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Save failed');
      }
    });
  };

  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
      <h3 className="mb-4 font-[family-name:var(--font-jakarta)] text-base font-semibold text-white">
        New scenario
      </h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Scenario name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Add LegalService schema to /personal-injury"
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[var(--accent)] focus:outline-none"
          />
        </Field>
        <Field label="Target query">
          <select
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="">— pick a query —</option>
            {queryOptions.map((q) => (
              <option key={q.value} value={q.value}>
                {q.value} ({q.hint})
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Baseline URL" className="mt-3">
        {pagesWithFeatures.length === 0 ? (
          <div className="rounded-lg border border-[var(--rag-yellow)]/30 bg-[var(--rag-yellow-bg)] px-3 py-2 text-xs text-[var(--rag-yellow)]">
            No pages with features yet. Run feature extraction (Calibration tab).
          </div>
        ) : (
          <select
            value={baselineUrl}
            onChange={(e) => setBaselineUrl(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
          >
            {pagesWithFeatures.map((p) => (
              <option key={p.url} value={p.url}>
                {p.title ? `${p.title} — ${p.url}` : p.url}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="Description (optional)" className="mt-3">
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Why are you running this scenario?"
          className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[var(--accent)] focus:outline-none"
        />
      </Field>

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[10px] font-semibold uppercase tracking-widest text-white/55">
            Proposed change
          </h4>
          <button
            type="button"
            onClick={() => {
              setShowCustom((v) => !v);
              setSelectedTemplate(null);
            }}
            className="text-[11px] text-white/40 hover:text-white/70"
          >
            {showCustom ? '← back to templates' : 'use custom JSON →'}
          </button>
        </div>
        {showCustom ? (
          <textarea
            value={customChange}
            onChange={(e) => setCustomChange(e.target.value)}
            rows={5}
            placeholder='{"has_jsonld_legalservice": true, "word_count_log": "+0.15"}'
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-[family-name:var(--font-geist-mono)] text-xs text-white placeholder:text-white/30 focus:border-[var(--accent)] focus:outline-none"
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {CHANGE_TEMPLATES.map((t) => {
              const active = t.id === selectedTemplate;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedTemplate(active ? null : t.id)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    active
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                      : 'border-white/10 bg-black/20 hover:border-white/20'
                  }`}
                >
                  <div className="text-sm font-medium text-white">{t.label}</div>
                  <div className="mt-0.5 text-[11px] text-white/55">
                    {t.description}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {preview && (
        <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-white/55">
              Simulation preview
            </span>
            <ConfidencePill label={preview.confidenceLabel} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <DeltaPill
              label="Δrank"
              value={preview.deltaRank}
              format={(n) => (n > 0 ? `+${n}` : `${n}`)}
              positiveIsGood
              suffix=""
            />
            <DeltaPill
              label="Δscore"
              value={preview.deltaScore}
              format={(n) => (n >= 0 ? `+${n.toFixed(3)}` : `${n.toFixed(3)}`)}
              positiveIsGood
              suffix=""
            />
            <span className="font-[family-name:var(--font-geist-mono)] text-[11px] text-white/40">
              vs {preview.competitorCount} competitors
            </span>
          </div>
          {preview.topContributingFeatures.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-widest text-white/40">
                Top contributing features
              </div>
              <div className="flex flex-col gap-1">
                {preview.topContributingFeatures.map((c) => (
                  <div
                    key={c.feature}
                    className="flex items-center justify-between gap-2 font-[family-name:var(--font-geist-mono)] text-[11px]"
                  >
                    <span className="text-white/55">{c.feature}</span>
                    <span
                      className={
                        c.contribution > 0
                          ? 'text-[var(--rag-green)]'
                          : c.contribution < 0
                            ? 'text-[var(--rag-red)]'
                            : 'text-white/40'
                      }
                    >
                      {c.contribution >= 0 ? '+' : ''}
                      {c.contribution.toFixed(4)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] px-3 py-2 text-xs text-[var(--rag-red)]">
          {error}
        </div>
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={isPending}
          className="rounded-full border border-white/10 px-4 py-2 text-sm text-white/55 transition-colors hover:border-white/30 hover:text-white"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onPreview}
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-sm text-white transition-colors hover:border-white/30 disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Lightbulb size={14} strokeWidth={2} />
          )}
          Preview
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={isPending || !name.trim()}
          className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <CheckCircle2 size={14} strokeWidth={2} />
          )}
          Save scenario
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-white/55">
        {label}
      </label>
      {children}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// Calibration tab
// ═════════════════════════════════════════════════════════════

function CalibrationTab({
  firmSlug,
  overview,
}: {
  firmSlug: string;
  overview: ScenarioOverview;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [extractResult, setExtractResult] = useState<{
    extracted: number;
    skipped: number;
    total: number;
  } | null>(null);
  const [calibResult, setCalibResult] = useState<{
    generation: number;
    fitness: number;
    observationCount: number;
    resultsConsidered: number;
    resultsSkippedNoFeatures: number;
  } | null>(null);
  const [recrawlResult, setRecrawlResult] = useState<{
    pagesScanned: number;
    pagesWithFullFeatures: number;
    pagesSkippedNetworkError: number;
    pagesSkippedNoUrl: number;
    sampleErrors: Array<{ url: string; error: string }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onExtract = () => {
    setError(null);
    setExtractResult(null);
    setRecrawlResult(null);
    start(async () => {
      try {
        const r = await extractFeaturesForFirm(firmSlug);
        setExtractResult(r);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Extraction failed');
      }
    });
  };
  const onRecrawl = () => {
    setError(null);
    setRecrawlResult(null);
    setExtractResult(null);
    start(async () => {
      try {
        const r = await recrawlFeaturesViaHtml(firmSlug);
        setRecrawlResult(r);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Recrawl failed');
      }
    });
  };
  const onCalibrate = () => {
    setError(null);
    setCalibResult(null);
    start(async () => {
      try {
        const r = await runFirmCalibration(firmSlug);
        setCalibResult(r);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Calibration failed');
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Step 1 — Extract features */}
      <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="font-[family-name:var(--font-jakarta)] text-base font-semibold text-white">
              Step 1 · Extract page features
            </h3>
            <p className="mt-1 text-sm text-white/55">
              Two paths. <strong className="font-semibold text-white/80">Fast</strong>{' '}
              reads <code className="font-[family-name:var(--font-geist-mono)] text-[11px]">pages.main_content</code>{' '}
              and fills word-count, freshness, query/keyword, URL, and centroid features —
              schema/heading/link features stay 0. <strong className="font-semibold text-white/80">Full HTML</strong>{' '}
              re-fetches every page and runs the rich extractor — fills all 22
              dimensions (JSON-LD type presence, H1/H2 counts, internal/external/authoritative
              link densities, FAQ count). Slower (one HTTP request per page, ~250ms politeness
              gap) but the calibration math actually has signal across every feature.
            </p>
            <p className="mt-2 font-[family-name:var(--font-geist-mono)] text-[11px] text-white/40">
              Currently {overview.pageFeatureCount} page
              {overview.pageFeatureCount === 1 ? '' : 's'} indexed.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2">
            <button
              type="button"
              onClick={onExtract}
              disabled={isPending}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 px-4 py-2 text-sm text-white transition-colors hover:border-white/30 disabled:opacity-50"
              title="Fast path — uses stored main_content; schema features default to 0"
            >
              {isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Database size={14} strokeWidth={2} />
              )}
              Fast extract
            </button>
            <button
              type="button"
              onClick={onRecrawl}
              disabled={isPending}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
              title="Re-fetches each page's HTML — slower but fills all 22 features"
            >
              {isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Globe size={14} strokeWidth={2} />
              )}
              Recrawl (full HTML)
            </button>
          </div>
        </div>
        {extractResult && (
          <div className="mt-3 rounded-lg border border-[var(--rag-green)]/30 bg-[var(--rag-green-bg)] px-3 py-2 text-xs text-[var(--rag-green)]">
            Fast extracted {extractResult.extracted} of {extractResult.total} pages
            {extractResult.skipped > 0
              ? ` (${extractResult.skipped} skipped — no main_content)`
              : ''}
            . Schema/heading/link features default to 0 on this path —
            run a full recrawl to fill them.
          </div>
        )}
        {recrawlResult && (
          <div className="mt-3 flex flex-col gap-2">
            <div className="rounded-lg border border-[var(--rag-green)]/30 bg-[var(--rag-green-bg)] px-3 py-2 text-xs text-[var(--rag-green)]">
              Recrawled {recrawlResult.pagesWithFullFeatures} of{' '}
              {recrawlResult.pagesScanned} pages with full feature vectors
              {recrawlResult.pagesSkippedNetworkError > 0
                ? ` · ${recrawlResult.pagesSkippedNetworkError} skipped (network)`
                : ''}
              {recrawlResult.pagesSkippedNoUrl > 0
                ? ` · ${recrawlResult.pagesSkippedNoUrl} skipped (no URL)`
                : ''}
              .
            </div>
            {recrawlResult.sampleErrors.length > 0 && (
              <details className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-white/55">
                <summary className="cursor-pointer">
                  {recrawlResult.sampleErrors.length} sample error
                  {recrawlResult.sampleErrors.length === 1 ? '' : 's'}
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5 font-[family-name:var(--font-geist-mono)]">
                  {recrawlResult.sampleErrors.map((e, i) => (
                    <li key={i}>
                      <span className="text-white/70">{e.url}</span>:{' '}
                      <span className="text-white/55">{e.error}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      {/* Step 2 — Run calibration */}
      <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-[family-name:var(--font-jakarta)] text-base font-semibold text-white">
              Step 2 · Run calibration (PSO)
            </h3>
            <p className="mt-1 text-sm text-white/55">
              Particle Swarm Optimization fits the linear ranker&apos;s
              weight vector against your observed SERPs. Maximizes mean
              Spearman ρ between predicted and observed ranks. Deterministic
              given the same corpus + seed (~5 seconds for typical inputs).
            </p>
            <p className="mt-2 font-[family-name:var(--font-geist-mono)] text-[11px] text-white/40">
              Corpus: {overview.serpCount} SERP
              {overview.serpCount === 1 ? '' : 's'} · {overview.pageFeatureCount}{' '}
              page features
            </p>
          </div>
          <button
            type="button"
            onClick={onCalibrate}
            disabled={isPending || overview.serpCount === 0}
            className="inline-flex shrink-0 items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Play size={14} strokeWidth={2} />
            )}
            Run calibration
          </button>
        </div>
        {calibResult && (
          <div className="mt-3 rounded-lg border border-[var(--rag-green)]/30 bg-[var(--rag-green-bg)] px-3 py-2 text-xs text-[var(--rag-green)]">
            Trained generation {calibResult.generation} · ρ={calibResult.fitness.toFixed(3)} ·{' '}
            {calibResult.observationCount} observations ·{' '}
            {calibResult.resultsConsidered} ranked URLs
            {calibResult.resultsSkippedNoFeatures > 0
              ? ` (${calibResult.resultsSkippedNoFeatures} skipped — no features)`
              : ''}
          </div>
        )}
      </div>

      {/* Latest weights summary */}
      {overview.latestWeights && (
        <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
          <h3 className="mb-3 font-[family-name:var(--font-jakarta)] text-base font-semibold text-white">
            Current weights (generation {overview.latestWeights.generation})
          </h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <Tile
              label="Fitness (ρ)"
              value={overview.latestWeights.fitness.toFixed(3)}
              hint="Spearman correlation"
              tone={overview.latestWeights.fitness >= 0.4 ? 'ok' : 'warn'}
            />
            <Tile
              label="Observations"
              value={overview.latestWeights.observationCount}
              hint="SERPs used in calibration"
            />
            <Tile
              label="Trained"
              value={daysAgo(overview.latestWeights.trainedAt)}
              hint="ago"
            />
          </div>
          <p className="mt-3 font-[family-name:var(--font-geist-mono)] text-[11px] text-white/40">
            ρ ≥ 0.4 = directional confidence · ρ &lt; 0.1 = noise-floor (add more SERPs).
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] p-4 text-sm text-[var(--rag-red)]">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
            <div>{error}</div>
          </div>
        </div>
      )}

      <EmptyHint
        icon={Lightbulb}
        headline="Calibration corpus tips"
        body={
          <ul className="list-disc space-y-1 pl-5 text-sm text-white/55">
            <li>Aim for ≥10 SERPs covering distinct queries the firm wants to win.</li>
            <li>Each SERP should have ≥5 results so the rank correlation has signal.</li>
            <li>Re-calibrate after every meaningful corpus addition — the weights generation bumps.</li>
            <li>Phase B will replace the manual paste-in with a DataForSEO/SerpAPI cron.</li>
          </ul>
        }
      />
    </div>
  );
}

function daysAgo(d: Date): string {
  const ms = Date.now() - new Date(d).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  return `${days}d`;
}

// ═════════════════════════════════════════════════════════════
// SERPs tab
// ═════════════════════════════════════════════════════════════

function SerpsTab({
  firmSlug,
  serps,
}: {
  firmSlug: string;
  serps: SerpRow[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [isPending, start] = useTransition();
  const [bingResult, setBingResult] = useState<BingCaptureUiOutcome | null>(null);
  const [bingError, setBingError] = useState<string | null>(null);

  const onDelete = (id: string) => {
    if (!confirm('Delete this SERP snapshot? Calibration will lose this evidence.')) return;
    start(async () => {
      try {
        await deleteSerp(firmSlug, id);
        router.refresh();
      } catch {
        // best-effort; UI keeps row until refresh
      }
    });
  };

  const onCaptureLive = () => {
    setBingError(null);
    setBingResult(null);
    start(async () => {
      try {
        const r = await captureSerpsViaBing(firmSlug, { maxQueries: 5, count: 10 });
        setBingResult(r);
        router.refresh();
      } catch (e) {
        setBingError(e instanceof Error ? e.message : 'Capture failed');
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-white/55">
          {serps.length === 0
            ? 'No observed SERPs yet. Paste manually OR capture live via Bing to start calibration.'
            : `${serps.length} SERP${serps.length === 1 ? '' : 's'} observed`}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onCaptureLive}
            disabled={isPending}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-sm text-white transition-colors hover:border-white/30 disabled:opacity-50"
            title="Captures top 10 results from Bing Web Search v7 for the firm's seed_query_intents (top 5 queries). Free tier: 1,000 queries/month."
          >
            {isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Search size={14} strokeWidth={2} />
            )}
            Capture live (Bing)
          </button>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)]"
          >
            <ListPlus size={14} strokeWidth={2} />
            {showForm ? 'Cancel' : 'Add SERP'}
          </button>
        </div>
      </div>

      {bingResult && (
        <div className="rounded-lg border border-[var(--rag-green)]/30 bg-[var(--rag-green-bg)] px-3 py-2 text-xs text-[var(--rag-green)]">
          Bing capture: {bingResult.succeeded} succeeded · {bingResult.skipped} skipped
          {bingResult.failed > 0 ? ` · ${bingResult.failed} failed` : ''}
          {bingResult.skipped > 0 && (
            <span className="mt-1 block text-white/70">
              Skipped reasons: {Array.from(new Set(bingResult.perQuery.filter((p) => !p.ok).map((p) => p.reason ?? 'unknown'))).slice(0, 3).join(', ')}
            </span>
          )}
        </div>
      )}
      {bingError && (
        <div className="rounded-lg border border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] px-3 py-2 text-xs text-[var(--rag-red)]">
          {bingError}
        </div>
      )}

      {showForm && (
        <NewSerpForm firmSlug={firmSlug} onClose={() => setShowForm(false)} />
      )}

      {serps.length === 0 ? (
        <EmptyHint
          icon={Database}
          headline="What goes here"
          body={
            <ul className="list-disc space-y-1 pl-5 text-sm text-white/55">
              <li>Paste the top 10 results from a Google / Bing search the firm wants to win.</li>
              <li>One URL per line, optionally `1[tab]https://example.com[tab]Title`.</li>
              <li>Each SERP becomes a calibration observation; more SERPs → tighter weights.</li>
            </ul>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="border-b border-white/10 bg-white/[0.02]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-white/40">
                <th className="px-4 py-2 font-medium">Query</th>
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 font-medium">Results</th>
                <th className="px-4 py-2 font-medium">Captured</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {serps.map((s) => (
                <tr key={s.id} className="border-b border-white/5 last:border-b-0">
                  <td className="px-4 py-3 text-white">{s.query}</td>
                  <td className="px-4 py-3 font-[family-name:var(--font-geist-mono)] text-xs text-white/60">
                    {s.provider}
                  </td>
                  <td className="px-4 py-3 font-[family-name:var(--font-geist-mono)] text-xs text-white/80">
                    {s.resultCount}
                  </td>
                  <td
                    className="px-4 py-3 font-[family-name:var(--font-geist-mono)] text-[11px] text-white/40"
                    suppressHydrationWarning
                  >
                    {new Date(s.fetchedAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onDelete(s.id)}
                      disabled={isPending}
                      className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-1 text-[11px] text-white/55 transition-colors hover:border-[var(--rag-red)]/50 hover:text-[var(--rag-red)] disabled:opacity-50"
                    >
                      <Trash2 size={10} strokeWidth={2} />
                      Delete
                    </button>
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

function NewSerpForm({
  firmSlug,
  onClose,
}: {
  firmSlug: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [pasted, setPasted] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  const onSubmit = () => {
    setError(null);
    if (!query.trim() || !pasted.trim()) {
      setError('Enter both a query and pasted SERP results.');
      return;
    }
    start(async () => {
      try {
        await addManualSerp(firmSlug, {
          query: query.trim(),
          pasted: pasted,
          notes: notes.trim() || undefined,
        });
        onClose();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Save failed');
      }
    });
  };

  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
      <h3 className="mb-3 font-[family-name:var(--font-jakarta)] text-base font-semibold text-white">
        Paste an observed SERP
      </h3>
      <Field label="Query">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. personal injury lawyer melbourne fl"
          className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[var(--accent)] focus:outline-none"
        />
      </Field>
      <Field label="SERP results (one URL per line)" className="mt-3">
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          rows={8}
          placeholder={`1\thttps://example.com/page\n2\thttps://another.com\nhttps://no-rank-line.com`}
          className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-[family-name:var(--font-geist-mono)] text-xs text-white placeholder:text-white/30 focus:border-[var(--accent)] focus:outline-none"
        />
        <p className="mt-1 text-[11px] text-white/40">
          Format: `position[TAB]url[TAB]title` or `1. url` or just URL per line. Position auto-numbers if omitted.
        </p>
      </Field>
      <Field label="Notes (optional)" className="mt-3">
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Where was this captured? incognito Google, Brave, etc."
          className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[var(--accent)] focus:outline-none"
        />
      </Field>

      {error && (
        <div className="mt-3 rounded-lg border border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] px-3 py-2 text-xs text-[var(--rag-red)]">
          {error}
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={isPending}
          className="rounded-full border border-white/10 px-4 py-2 text-sm text-white/55 transition-colors hover:border-white/30 hover:text-white"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <CheckCircle2 size={14} strokeWidth={2} />
          )}
          Save SERP
        </button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// Empty-state hint
// ═════════════════════════════════════════════════════════════

function EmptyHint({
  icon: Icon,
  headline,
  body,
}: {
  icon: typeof Beaker;
  headline: string;
  body: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-white/10 bg-[var(--bg-secondary)]/50 p-6">
      <div className="flex items-start gap-3">
        <Icon size={20} strokeWidth={1.5} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <h4 className="font-[family-name:var(--font-jakarta)] text-sm font-semibold text-white">
            {headline}
          </h4>
          <div className="mt-2">{body}</div>
        </div>
      </div>
    </div>
  );
}
