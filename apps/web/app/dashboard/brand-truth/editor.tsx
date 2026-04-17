'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { BrandTruth } from '@ai-edge/shared';
import { saveBrandTruth, getBrandTruthVersion } from '../../actions/brand-truth-actions';

// ── Collapsible Section ───────────────────────────────────
function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-white/10 bg-[--bg-secondary]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-black hover:bg-[--bg-tertiary]/50"
      >
        {title}
        <span className="text-white/55">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="border-t border-white/10 px-4 py-4">{children}</div>}
    </div>
  );
}

// ── Simple Input ──────────────────────────────────────────
function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs text-white/55">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-[--accent] focus:outline-none"
      />
    </label>
  );
}

// ── String Array Editor ───────────────────────────────────
function StringArray({
  label,
  items,
  onChange,
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
}) {
  return (
    <div>
      <span className="text-xs text-white/55">{label}</span>
      <div className="mt-1 flex flex-col gap-1">
        {items.map((item, i) => (
          <div key={i} className="flex gap-2">
            <input
              type="text"
              value={item}
              onChange={(e) => {
                const copy = [...items];
                copy[i] = e.target.value;
                onChange(copy);
              }}
              className="flex-1 rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              className="rounded px-2 text-xs text-red-400 hover:bg-red-950/30"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...items, ''])}
        className="mt-2 rounded-lg border border-dashed border-white/10 px-3 py-1 text-xs text-white/55 hover:border-white/20 hover:text-white"
      >
        + Add Item
      </button>
    </div>
  );
}

// ── Main Editor ───────────────────────────────────────────
export function BrandTruthEditor({
  initialPayload,
  currentVersion,
  versions,
}: {
  initialPayload: BrandTruth;
  currentVersion: number;
  versions: Array<{ id: string; version: number; createdAt: Date }>;
}) {
  const [data, setData] = useState<Record<string, any>>(initialPayload as any);
  const [isPending, startTransition] = useTransition();
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [complianceViolations, setComplianceViolations] = useState<Array<{ jurisdiction: string; match: string; reason: string }>>([]);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null); // null = editing latest
  const [isLoadingVersion, setIsLoadingVersion] = useState(false);
  const router = useRouter();

  const isReadOnly = viewingVersion !== null;

  const handleViewVersion = async (versionId: string, versionNum: number) => {
    setIsLoadingVersion(true);
    const result = await getBrandTruthVersion(versionId);
    if (result) {
      setData(result.payload as any);
      setViewingVersion(versionNum);
    }
    setIsLoadingVersion(false);
  };

  const handleBackToCurrent = () => {
    setData(initialPayload as any);
    setViewingVersion(null);
  };

  const set = (key: string, value: any) => setData((prev) => ({ ...prev, [key]: value }));

  const handleSave = () => {
    setSaveResult(null);
    setComplianceViolations([]);
    startTransition(async () => {
      const result = await saveBrandTruth(data);
      if (result.success) {
        setSaveResult(`Saved as version ${result.version}`);
        router.refresh();
      } else {
        setSaveResult(`Error: ${result.error}`);
        if ('complianceViolations' in result && result.complianceViolations) {
          setComplianceViolations(result.complianceViolations);
        }
      }
    });
  };

  return (
    <div className="mt-6 flex gap-6">
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!isReadOnly) handleSave();
      }}
      className={`flex flex-1 flex-col gap-4 ${isReadOnly ? 'opacity-80' : ''}`}
    >
      {/* Read-only banner */}
      {isReadOnly && (
        <div className="flex items-center justify-between rounded-xl border border-yellow-500/30 bg-yellow-500/15 px-4 py-3">
          <span className="text-sm text-yellow-400">Viewing version {viewingVersion} (read-only)</span>
          <button type="button" onClick={handleBackToCurrent} className="rounded-lg bg-yellow-500 px-3 py-1 text-xs font-medium text-black hover:bg-yellow-400">Back to Current Version</button>
        </div>
      )}
      {/* Core identity */}
      <Section title="Core Identity" defaultOpen>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Firm Name" value={data.firm_name ?? ''} onChange={(v) => set('firm_name', v)} />
          <Field label="Firm Type" value={data.firm_type ?? ''} onChange={(v) => set('firm_type', v)} />
          <Field label="Legal Entity" value={data.legal_entity ?? ''} onChange={(v) => set('legal_entity', v)} />
        </div>
        <div className="mt-4">
          <StringArray label="Name Variants" items={data.name_variants ?? []} onChange={(v) => set('name_variants', v)} />
        </div>
        <div className="mt-4">
          <StringArray label="Common Misspellings" items={data.common_misspellings ?? []} onChange={(v) => set('common_misspellings', v)} />
        </div>
      </Section>

      {/* Headquarters */}
      <Section title="Headquarters">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Street" value={data.headquarters?.street ?? ''} onChange={(v) => set('headquarters', { ...data.headquarters, street: v })} />
          <Field label="City" value={data.headquarters?.city ?? ''} onChange={(v) => set('headquarters', { ...data.headquarters, city: v })} />
          <Field label="Region / State" value={data.headquarters?.region ?? ''} onChange={(v) => set('headquarters', { ...data.headquarters, region: v })} />
          <Field label="Postal Code" value={data.headquarters?.postal_code ?? ''} onChange={(v) => set('headquarters', { ...data.headquarters, postal_code: v })} />
          <Field label="Country (2-letter)" value={data.headquarters?.country ?? 'US'} onChange={(v) => set('headquarters', { ...data.headquarters, country: v })} />
          <Field label="Phone" value={data.headquarters?.phone ?? ''} onChange={(v) => set('headquarters', { ...data.headquarters, phone: v })} />
          <Field label="Email" value={data.headquarters?.email ?? ''} onChange={(v) => set('headquarters', { ...data.headquarters, email: v })} />
        </div>
      </Section>

      {/* Service Offerings (marketing_agency) */}
      <Section title="Service Offerings">
        {(data.service_offerings ?? []).map((so: any, i: number) => (
          <div key={i} className="mb-3 flex gap-2">
            <input
              placeholder="Name"
              value={so.name ?? ''}
              onChange={(e) => {
                const copy = [...(data.service_offerings ?? [])];
                copy[i] = { ...copy[i], name: e.target.value };
                set('service_offerings', copy);
              }}
              className="w-40 rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none"
            />
            <input
              placeholder="Scope"
              value={so.scope ?? ''}
              onChange={(e) => {
                const copy = [...(data.service_offerings ?? [])];
                copy[i] = { ...copy[i], scope: e.target.value };
                set('service_offerings', copy);
              }}
              className="flex-1 rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => set('service_offerings', (data.service_offerings ?? []).filter((_: any, j: number) => j !== i))}
              className="rounded px-2 text-xs text-red-400 hover:bg-red-950/30"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => set('service_offerings', [...(data.service_offerings ?? []), { name: '', scope: '' }])}
          className="rounded-lg border border-dashed border-white/10 px-3 py-1 text-xs text-white/55 hover:border-white/20 hover:text-white"
        >
          + Add Service Offering
        </button>
      </Section>

      {/* Positioning */}
      <Section title="Positioning & Differentiators">
        <StringArray label="Unique Differentiators" items={data.unique_differentiators ?? []} onChange={(v) => set('unique_differentiators', v)} />
        <div className="mt-4">
          <StringArray label="Required Positioning Phrases" items={data.required_positioning_phrases ?? []} onChange={(v) => set('required_positioning_phrases', v)} />
        </div>
        <div className="mt-4">
          <StringArray label="Brand Values" items={data.brand_values ?? []} onChange={(v) => set('brand_values', v)} />
        </div>
      </Section>

      {/* Banned Claims */}
      <Section title="Banned Claims">
        {(data.banned_claims ?? []).map((bc: any, i: number) => (
          <div key={i} className="mb-3 rounded border border-white/10 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                placeholder="Claim"
                value={bc.claim ?? ''}
                onChange={(e) => {
                  const copy = [...(data.banned_claims ?? [])];
                  copy[i] = { ...copy[i], claim: e.target.value };
                  set('banned_claims', copy);
                }}
                className="rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none"
              />
              <input
                placeholder="Source Rule"
                value={bc.source_rule ?? ''}
                onChange={(e) => {
                  const copy = [...(data.banned_claims ?? [])];
                  copy[i] = { ...copy[i], source_rule: e.target.value };
                  set('banned_claims', copy);
                }}
                className="rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none"
              />
            </div>
            <textarea
              placeholder="Reason"
              value={bc.reason ?? ''}
              onChange={(e) => {
                const copy = [...(data.banned_claims ?? [])];
                copy[i] = { ...copy[i], reason: e.target.value };
                set('banned_claims', copy);
              }}
              rows={2}
              className="mt-2 w-full rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => set('banned_claims', (data.banned_claims ?? []).filter((_: any, j: number) => j !== i))}
              className="mt-1 text-xs text-red-400 hover:text-red-300"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => set('banned_claims', [...(data.banned_claims ?? []), { claim: '', reason: '', source_rule: '' }])}
          className="rounded-lg border border-dashed border-white/10 px-3 py-1 text-xs text-white/55 hover:border-white/20 hover:text-white"
        >
          + Add Banned Claim
        </button>
      </Section>

      {/* Tone Guidelines */}
      <Section title="Tone Guidelines">
        <Field label="Voice" value={data.tone_guidelines?.voice ?? ''} onChange={(v) => set('tone_guidelines', { ...data.tone_guidelines, voice: v })} />
        <div className="mt-3">
          <Field label="Register" value={data.tone_guidelines?.register ?? ''} onChange={(v) => set('tone_guidelines', { ...data.tone_guidelines, register: v })} />
        </div>
        <div className="mt-3">
          <StringArray label="Avoid" items={data.tone_guidelines?.avoid ?? []} onChange={(v) => set('tone_guidelines', { ...data.tone_guidelines, avoid: v })} />
        </div>
      </Section>

      {/* Audience */}
      <Section title="Target Audience">
        <StringArray label="Primary Verticals" items={data.target_audience?.primary_verticals ?? []} onChange={(v) => set('target_audience', { ...data.target_audience, primary_verticals: v })} />
        <div className="mt-3">
          <StringArray label="Secondary Verticals" items={data.target_audience?.secondary_verticals ?? []} onChange={(v) => set('target_audience', { ...data.target_audience, secondary_verticals: v })} />
        </div>
        <div className="mt-3">
          <Field label="Firmographic" value={data.target_audience?.firmographic ?? ''} onChange={(v) => set('target_audience', { ...data.target_audience, firmographic: v })} />
        </div>
      </Section>

      {/* Competitors & Queries */}
      <Section title="Competitors & Seed Queries">
        <StringArray label="Competitors for LLM Monitoring" items={data.competitors_for_llm_monitoring ?? []} onChange={(v) => set('competitors_for_llm_monitoring', v)} />
        <div className="mt-4">
          <StringArray label="Seed Query Intents" items={data.seed_query_intents ?? []} onChange={(v) => set('seed_query_intents', v)} />
        </div>
      </Section>

      {/* Key Clients (Public) */}
      <Section title="Key Clients (Public)">
        {(data.key_clients_public ?? []).map((kc: any, i: number) => (
          <div key={i} className="mb-3 rounded border border-white/10 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <input placeholder="Client Name" value={kc.name ?? ''} onChange={(e) => { const copy = [...(data.key_clients_public ?? [])]; copy[i] = { ...copy[i], name: e.target.value }; set('key_clients_public', copy); }} className="rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none" />
              <input placeholder="Vertical" value={kc.vertical ?? ''} onChange={(e) => { const copy = [...(data.key_clients_public ?? [])]; copy[i] = { ...copy[i], vertical: e.target.value }; set('key_clients_public', copy); }} className="rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none" />
              <input placeholder="Location" value={kc.location ?? ''} onChange={(e) => { const copy = [...(data.key_clients_public ?? [])]; copy[i] = { ...copy[i], location: e.target.value }; set('key_clients_public', copy); }} className="rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none" />
              <input placeholder="Attribution" value={kc.attribution ?? ''} onChange={(e) => { const copy = [...(data.key_clients_public ?? [])]; copy[i] = { ...copy[i], attribution: e.target.value }; set('key_clients_public', copy); }} className="rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none" />
              <input placeholder="Source URL" value={kc.source_url ?? ''} onChange={(e) => { const copy = [...(data.key_clients_public ?? [])]; copy[i] = { ...copy[i], source_url: e.target.value }; set('key_clients_public', copy); }} className="col-span-2 rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none" />
            </div>
            <textarea placeholder="Testimonial Quote" value={kc.testimonial_quote ?? ''} onChange={(e) => { const copy = [...(data.key_clients_public ?? [])]; copy[i] = { ...copy[i], testimonial_quote: e.target.value }; set('key_clients_public', copy); }} rows={2} className="mt-2 w-full rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none" />
            <button type="button" onClick={() => set('key_clients_public', (data.key_clients_public ?? []).filter((_: any, j: number) => j !== i))} className="mt-1 text-xs text-red-400 hover:text-red-300">Remove</button>
          </div>
        ))}
        <button type="button" onClick={() => set('key_clients_public', [...(data.key_clients_public ?? []), { name: '', vertical: '', location: '', testimonial_quote: '', attribution: '', source_url: '' }])} className="rounded-lg border border-dashed border-white/10 px-3 py-1 text-xs text-white/55 hover:border-white/20 hover:text-white">+ Add Client</button>
      </Section>

      {/* Awards & Badges */}
      <Section title="Awards & Badges">
        {(data.awards ?? []).map((aw: any, i: number) => (
          <div key={i} className="mb-3 rounded border border-white/10 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <input placeholder="Award Name" value={aw.name ?? ''} onChange={(e) => { const copy = [...(data.awards ?? [])]; copy[i] = { ...copy[i], name: e.target.value }; set('awards', copy); }} className="rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none" />
              <select value={aw.verification_status ?? 'unverified_at_ingestion'} onChange={(e) => { const copy = [...(data.awards ?? [])]; copy[i] = { ...copy[i], verification_status: e.target.value }; set('awards', copy); }} className="rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none">
                <option value="unverified_at_ingestion">Unverified</option>
                <option value="verified">Verified</option>
                <option value="pending">Pending</option>
              </select>
              <input placeholder="Source URL" value={aw.source_url ?? ''} onChange={(e) => { const copy = [...(data.awards ?? [])]; copy[i] = { ...copy[i], source_url: e.target.value }; set('awards', copy); }} className="rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none" />
              <label className="flex items-center gap-2 text-xs text-white/55">
                <input type="checkbox" checked={aw.source_required ?? true} onChange={(e) => { const copy = [...(data.awards ?? [])]; copy[i] = { ...copy[i], source_required: e.target.checked }; set('awards', copy); }} className="rounded border-neutral-600" />
                Source Required
              </label>
            </div>
            <textarea placeholder="Notes" value={aw.notes ?? ''} onChange={(e) => { const copy = [...(data.awards ?? [])]; copy[i] = { ...copy[i], notes: e.target.value }; set('awards', copy); }} rows={2} className="mt-2 w-full rounded-lg border border-white/10 bg-[--bg-tertiary] px-3 py-1.5 text-sm text-white focus:border-[--accent] focus:outline-none" />
            <button type="button" onClick={() => set('awards', (data.awards ?? []).filter((_: any, j: number) => j !== i))} className="mt-1 text-xs text-red-400 hover:text-red-300">Remove</button>
          </div>
        ))}
        <button type="button" onClick={() => set('awards', [...(data.awards ?? []), { name: '', source_url: '', source_required: true, verification_status: 'unverified_at_ingestion', notes: '' }])} className="rounded-lg border border-dashed border-white/10 px-3 py-1 text-xs text-white/55 hover:border-white/20 hover:text-white">+ Add Award</button>
      </Section>

      {/* Service Areas */}
      <Section title="Service Areas & Compliance">
        <StringArray label="Service Areas" items={data.service_areas ?? []} onChange={(v) => set('service_areas', v)} />
        <div className="mt-4">
          <StringArray label="Compliance Jurisdictions" items={data.compliance_jurisdictions ?? []} onChange={(v) => set('compliance_jurisdictions', v)} />
        </div>
      </Section>

      {/* Save (hidden in read-only mode) */}
      {!isReadOnly && (
        <div className="sticky bottom-0 flex items-center gap-4 border-t border-white/10 bg-[--bg-primary] py-4">
          <button
            type="submit"
            disabled={isPending}
            className="rounded-full bg-[--accent] px-6 py-2.5 text-sm font-semibold text-black transition hover:bg-[--accent-hover] disabled:opacity-50"
          >
            {isPending ? 'Saving...' : 'Save New Version'}
          </button>
          {saveResult && (
            <span className={`text-sm ${saveResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
              {saveResult}
            </span>
          )}
        </div>
      )}

      {/* Compliance violations */}
      {complianceViolations.length > 0 && (
        <div className="rounded-xl border border-red-800 bg-red-950/30 p-4">
          <h3 className="text-sm font-medium text-red-300">Compliance Violations Detected</h3>
          <p className="mt-1 text-xs text-red-400">Fix these before saving. The following text matches banned-claim patterns:</p>
          <ul className="mt-2 flex flex-col gap-2">
            {complianceViolations.map((v, i) => (
              <li key={i} className="rounded border border-red-900 bg-red-950/50 p-2 text-xs">
                <span className="font-medium text-red-300">Match: &quot;{v.match}&quot;</span>
                <span className="ml-2 text-white/55">[{v.jurisdiction}]</span>
                <p className="mt-1 text-red-400">{v.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>

    {/* Version history sidebar */}
    <aside className="w-64 shrink-0">
      <h2 className="text-sm font-semibold text-black/55">Version History</h2>
      {isLoadingVersion && <p className="mt-2 text-xs text-white/40 animate-pulse">Loading version...</p>}
      <div className="mt-3 flex flex-col gap-1">
        {versions.length === 0 ? (
          <p className="text-xs text-white/40">No versions saved yet.</p>
        ) : (
          versions.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                if (v.version === currentVersion && viewingVersion !== null) {
                  handleBackToCurrent();
                } else if (v.version !== currentVersion) {
                  handleViewVersion(v.id, v.version);
                }
              }}
              className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition hover:border-[--accent]/30 ${
                (viewingVersion === null && v.version === currentVersion) || viewingVersion === v.version
                  ? 'border-[--accent] bg-[--accent]/10 text-[--accent]'
                  : 'border-white/10 text-white/55'
              }`}
            >
              <span className="font-medium">v{v.version}</span>
              {v.version === currentVersion && <span className="ml-1 text-white/40">(latest)</span>}
              <span className="ml-2">
                {v.createdAt.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
    </div>
  );
}
