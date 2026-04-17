'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { BrandTruth } from '@ai-edge/shared';
import { saveBrandTruth } from '../../actions/brand-truth-actions';

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
    <div className="rounded-lg border border-neutral-800 bg-neutral-900">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-neutral-200 hover:bg-neutral-800/50"
      >
        {title}
        <span className="text-neutral-500">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="border-t border-neutral-800 px-4 py-4">{children}</div>}
    </div>
  );
}

// ── Simple Input ──────────────────────────────────────────
function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs text-neutral-500">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-blue-600 focus:outline-none"
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
      <span className="text-xs text-neutral-500">{label}</span>
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
              className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 focus:border-blue-600 focus:outline-none"
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
        className="mt-2 rounded-md border border-dashed border-neutral-700 px-3 py-1 text-xs text-neutral-500 hover:border-neutral-500 hover:text-neutral-300"
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
}: {
  initialPayload: BrandTruth;
  currentVersion: number;
}) {
  const [data, setData] = useState<Record<string, any>>(initialPayload as any);
  const [isPending, startTransition] = useTransition();
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const router = useRouter();

  const set = (key: string, value: any) => setData((prev) => ({ ...prev, [key]: value }));

  const handleSave = () => {
    setSaveResult(null);
    startTransition(async () => {
      const result = await saveBrandTruth(data);
      if (result.success) {
        setSaveResult(`Saved as version ${result.version}`);
        router.refresh();
      } else {
        setSaveResult(`Error: ${result.error}`);
      }
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        handleSave();
      }}
      className="mt-6 flex flex-col gap-4"
    >
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
              className="w-40 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 focus:border-blue-600 focus:outline-none"
            />
            <input
              placeholder="Scope"
              value={so.scope ?? ''}
              onChange={(e) => {
                const copy = [...(data.service_offerings ?? [])];
                copy[i] = { ...copy[i], scope: e.target.value };
                set('service_offerings', copy);
              }}
              className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 focus:border-blue-600 focus:outline-none"
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
          className="rounded-md border border-dashed border-neutral-700 px-3 py-1 text-xs text-neutral-500 hover:border-neutral-500 hover:text-neutral-300"
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
          <div key={i} className="mb-3 rounded border border-neutral-800 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                placeholder="Claim"
                value={bc.claim ?? ''}
                onChange={(e) => {
                  const copy = [...(data.banned_claims ?? [])];
                  copy[i] = { ...copy[i], claim: e.target.value };
                  set('banned_claims', copy);
                }}
                className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 focus:border-blue-600 focus:outline-none"
              />
              <input
                placeholder="Source Rule"
                value={bc.source_rule ?? ''}
                onChange={(e) => {
                  const copy = [...(data.banned_claims ?? [])];
                  copy[i] = { ...copy[i], source_rule: e.target.value };
                  set('banned_claims', copy);
                }}
                className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 focus:border-blue-600 focus:outline-none"
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
              className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 focus:border-blue-600 focus:outline-none"
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
          className="rounded-md border border-dashed border-neutral-700 px-3 py-1 text-xs text-neutral-500 hover:border-neutral-500 hover:text-neutral-300"
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

      {/* Service Areas */}
      <Section title="Service Areas & Compliance">
        <StringArray label="Service Areas" items={data.service_areas ?? []} onChange={(v) => set('service_areas', v)} />
        <div className="mt-4">
          <StringArray label="Compliance Jurisdictions" items={data.compliance_jurisdictions ?? []} onChange={(v) => set('compliance_jurisdictions', v)} />
        </div>
      </Section>

      {/* Save */}
      <div className="sticky bottom-0 flex items-center gap-4 border-t border-neutral-800 bg-neutral-950 py-4">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
        >
          {isPending ? 'Saving...' : 'Save New Version'}
        </button>
        {saveResult && (
          <span className={`text-sm ${saveResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
            {saveResult}
          </span>
        )}
      </div>
    </form>
  );
}
