'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { BrandTruth } from '@ai-edge/shared';
import { saveBrandTruth, getBrandTruthVersion } from '../../../actions/brand-truth-actions';

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
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-white hover:bg-[var(--bg-tertiary)]/50"
      >
        {title}
        <span className="text-white/55">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="border-t border-white/10 px-4 py-4">{children}</div>}
    </div>
  );
}

// ── Simple Input ──────────────────────────────────────────
function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-white/55">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 block w-full rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-[var(--accent)] focus:outline-none"
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
              className="flex-1 rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
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
  firmSlug,
  initialPayload,
  currentVersion,
  versions,
}: {
  firmSlug: string;
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
      const result = await saveBrandTruth(firmSlug, data);
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
          {/*
            Primary URL is the canonical homepage. The Suppression and Entity
            scanners read it via `resolveFirmSiteUrl` — without it, both throw
            "Brand Truth missing a primary URL". Bind to '' to keep the input
            controlled; coerce empty back to undefined so we don't persist a
            blank string that would fail the schema's `.url()` validation.
          */}
          <Field
            label="Primary URL"
            value={data.primary_url ?? ''}
            onChange={(v) => {
              const trimmed = v.trim();
              set('primary_url', trimmed === '' ? undefined : v);
            }}
            placeholder="https://www.example.com"
          />
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

      {/* Practice Areas (law_firm / dental_practice — required, min 1) */}
      {(data.firm_type === 'law_firm' || data.firm_type === 'dental_practice') && (
        <Section title="Practice Areas" defaultOpen>
          <StringArray
            label="Practice Areas"
            items={data.practice_areas ?? []}
            onChange={(v) => set('practice_areas', v)}
          />
        </Section>
      )}

      {/* Geographies Served (law_firm / dental_practice — required, min 1) */}
      {(data.firm_type === 'law_firm' || data.firm_type === 'dental_practice') && (
        <Section title="Geographies Served" defaultOpen>
          <p className="mb-3 text-xs text-white/55">
            Each entry must have a city and 2–3 letter state. Radius is a positive integer in miles (max 500).
          </p>
          {(data.geographies_served ?? []).map((g: any, i: number) => (
            <div key={i} className="mb-3 rounded border border-white/10 p-3">
              <div className="grid gap-2 sm:grid-cols-4">
                <input
                  placeholder="City"
                  value={g.city ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.geographies_served ?? [])];
                    copy[i] = { ...copy[i], city: e.target.value };
                    set('geographies_served', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  placeholder="State (e.g. FL)"
                  value={g.state ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.geographies_served ?? [])];
                    copy[i] = { ...copy[i], state: e.target.value };
                    set('geographies_served', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  placeholder="Country (2-letter)"
                  value={g.country ?? 'US'}
                  onChange={(e) => {
                    const copy = [...(data.geographies_served ?? [])];
                    copy[i] = { ...copy[i], country: e.target.value };
                    set('geographies_served', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  type="number"
                  placeholder="Radius (mi)"
                  value={g.radius_mi ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.geographies_served ?? [])];
                    const n = Number(e.target.value);
                    copy[i] = { ...copy[i], radius_mi: Number.isFinite(n) && n > 0 ? n : undefined };
                    set('geographies_served', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={() =>
                  set(
                    'geographies_served',
                    (data.geographies_served ?? []).filter((_: any, j: number) => j !== i),
                  )
                }
                className="mt-2 text-xs text-red-400 hover:text-red-300"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              set('geographies_served', [
                ...(data.geographies_served ?? []),
                { city: '', state: '', country: 'US', radius_mi: 25 },
              ])
            }
            className="rounded-lg border border-dashed border-white/10 px-3 py-1 text-xs text-white/55 hover:border-white/20 hover:text-white"
          >
            + Add Geography
          </button>
        </Section>
      )}

      {/* Attorney Bios (law_firm) */}
      {data.firm_type === 'law_firm' && (
        <Section title="Attorney Bios">
          {(data.attorney_bios ?? []).map((ab: any, i: number) => (
            <div key={i} className="mb-3 rounded border border-white/10 p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  placeholder="Name"
                  value={ab.name ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.attorney_bios ?? [])];
                    copy[i] = { ...copy[i], name: e.target.value };
                    set('attorney_bios', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  placeholder="Role"
                  value={ab.role ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.attorney_bios ?? [])];
                    copy[i] = { ...copy[i], role: e.target.value };
                    set('attorney_bios', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  placeholder="Bar Number"
                  value={ab.bar_number ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.attorney_bios ?? [])];
                    copy[i] = { ...copy[i], bar_number: e.target.value };
                    set('attorney_bios', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  placeholder="Photo URL"
                  value={ab.photo_url ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.attorney_bios ?? [])];
                    // Coerce empty input to undefined so the persisted JSON
                    // doesn't carry empty strings (the schema permits '' as
                    // a safety net but undefined is the cleaner shape).
                    const trimmed = e.target.value.trim();
                    copy[i] = { ...copy[i], photo_url: trimmed === '' ? undefined : e.target.value };
                    set('attorney_bios', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
              <textarea
                placeholder="Bio"
                value={ab.bio ?? ''}
                onChange={(e) => {
                  const copy = [...(data.attorney_bios ?? [])];
                  copy[i] = { ...copy[i], bio: e.target.value };
                  set('attorney_bios', copy);
                }}
                rows={2}
                className="mt-2 w-full rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
              />
              <button
                type="button"
                onClick={() =>
                  set(
                    'attorney_bios',
                    (data.attorney_bios ?? []).filter((_: any, j: number) => j !== i),
                  )
                }
                className="mt-1 text-xs text-red-400 hover:text-red-300"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              set('attorney_bios', [
                ...(data.attorney_bios ?? []),
                { name: '', role: '', credentials: [], bio: '', bar_number: '', photo_url: '' },
              ])
            }
            className="rounded-lg border border-dashed border-white/10 px-3 py-1 text-xs text-white/55 hover:border-white/20 hover:text-white"
          >
            + Add Attorney
          </button>
        </Section>
      )}

      {/* Notable Cases (law_firm) */}
      {data.firm_type === 'law_firm' && (
        <Section title="Notable Cases">
          {(data.notable_cases ?? []).map((nc: any, i: number) => (
            <div key={i} className="mb-3 rounded border border-white/10 p-3">
              <textarea
                placeholder="Summary"
                value={nc.summary ?? ''}
                onChange={(e) => {
                  const copy = [...(data.notable_cases ?? [])];
                  copy[i] = { ...copy[i], summary: e.target.value };
                  set('notable_cases', copy);
                }}
                rows={2}
                className="w-full rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
              />
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <input
                  placeholder="Outcome"
                  value={nc.outcome ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.notable_cases ?? [])];
                    copy[i] = { ...copy[i], outcome: e.target.value };
                    set('notable_cases', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  placeholder="Jurisdiction"
                  value={nc.jurisdiction ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.notable_cases ?? [])];
                    copy[i] = { ...copy[i], jurisdiction: e.target.value };
                    set('notable_cases', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  placeholder="Source URL"
                  value={nc.source_url ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.notable_cases ?? [])];
                    copy[i] = { ...copy[i], source_url: e.target.value };
                    set('notable_cases', copy);
                  }}
                  className="col-span-2 rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={() =>
                  set(
                    'notable_cases',
                    (data.notable_cases ?? []).filter((_: any, j: number) => j !== i),
                  )
                }
                className="mt-1 text-xs text-red-400 hover:text-red-300"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              set('notable_cases', [
                ...(data.notable_cases ?? []),
                { summary: '', outcome: '', jurisdiction: '', source_url: '' },
              ])
            }
            className="rounded-lg border border-dashed border-white/10 px-3 py-1 text-xs text-white/55 hover:border-white/20 hover:text-white"
          >
            + Add Notable Case
          </button>
        </Section>
      )}

      {/* Provider Bios (dental_practice) */}
      {data.firm_type === 'dental_practice' && (
        <Section title="Provider Bios">
          {(data.provider_bios ?? []).map((pb: any, i: number) => (
            <div key={i} className="mb-3 rounded border border-white/10 p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  placeholder="Name"
                  value={pb.name ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.provider_bios ?? [])];
                    copy[i] = { ...copy[i], name: e.target.value };
                    set('provider_bios', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  placeholder="Role"
                  value={pb.role ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.provider_bios ?? [])];
                    copy[i] = { ...copy[i], role: e.target.value };
                    set('provider_bios', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  placeholder="License Number"
                  value={pb.license_number ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.provider_bios ?? [])];
                    copy[i] = { ...copy[i], license_number: e.target.value };
                    set('provider_bios', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  placeholder="Photo URL"
                  value={pb.photo_url ?? ''}
                  onChange={(e) => {
                    const copy = [...(data.provider_bios ?? [])];
                    const trimmed = e.target.value.trim();
                    copy[i] = { ...copy[i], photo_url: trimmed === '' ? undefined : e.target.value };
                    set('provider_bios', copy);
                  }}
                  className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
              <textarea
                placeholder="Bio"
                value={pb.bio ?? ''}
                onChange={(e) => {
                  const copy = [...(data.provider_bios ?? [])];
                  copy[i] = { ...copy[i], bio: e.target.value };
                  set('provider_bios', copy);
                }}
                rows={2}
                className="mt-2 w-full rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
              />
              <button
                type="button"
                onClick={() =>
                  set(
                    'provider_bios',
                    (data.provider_bios ?? []).filter((_: any, j: number) => j !== i),
                  )
                }
                className="mt-1 text-xs text-red-400 hover:text-red-300"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              set('provider_bios', [
                ...(data.provider_bios ?? []),
                { name: '', role: '', credentials: [], bio: '', license_number: '', photo_url: '' },
              ])
            }
            className="rounded-lg border border-dashed border-white/10 px-3 py-1 text-xs text-white/55 hover:border-white/20 hover:text-white"
          >
            + Add Provider
          </button>
        </Section>
      )}

      {/* Service Offerings (marketing_agency / other) */}
      {(data.firm_type === 'marketing_agency' || data.firm_type === 'other') && (
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
              className="w-40 rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
            />
            <input
              placeholder="Scope"
              value={so.scope ?? ''}
              onChange={(e) => {
                const copy = [...(data.service_offerings ?? [])];
                copy[i] = { ...copy[i], scope: e.target.value };
                set('service_offerings', copy);
              }}
              className="flex-1 rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
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
      )}

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
                className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
              />
              <input
                placeholder="Source Rule"
                value={bc.source_rule ?? ''}
                onChange={(e) => {
                  const copy = [...(data.banned_claims ?? [])];
                  copy[i] = { ...copy[i], source_rule: e.target.value };
                  set('banned_claims', copy);
                }}
                className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
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
              className="mt-2 w-full rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
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

      {/* Key Clients (Public) — marketing_agency only */}
      {data.firm_type === 'marketing_agency' && (
      <Section title="Key Clients (Public)">
        {(data.key_clients_public ?? []).map((kc: any, i: number) => (
          <div key={i} className="mb-3 rounded border border-white/10 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <input placeholder="Client Name" value={kc.name ?? ''} onChange={(e) => { const copy = [...(data.key_clients_public ?? [])]; copy[i] = { ...copy[i], name: e.target.value }; set('key_clients_public', copy); }} className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none" />
              <input placeholder="Vertical" value={kc.vertical ?? ''} onChange={(e) => { const copy = [...(data.key_clients_public ?? [])]; copy[i] = { ...copy[i], vertical: e.target.value }; set('key_clients_public', copy); }} className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none" />
              <input placeholder="Location" value={kc.location ?? ''} onChange={(e) => { const copy = [...(data.key_clients_public ?? [])]; copy[i] = { ...copy[i], location: e.target.value }; set('key_clients_public', copy); }} className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none" />
              <input placeholder="Attribution" value={kc.attribution ?? ''} onChange={(e) => { const copy = [...(data.key_clients_public ?? [])]; copy[i] = { ...copy[i], attribution: e.target.value }; set('key_clients_public', copy); }} className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none" />
              <input placeholder="Source URL" value={kc.source_url ?? ''} onChange={(e) => { const copy = [...(data.key_clients_public ?? [])]; copy[i] = { ...copy[i], source_url: e.target.value }; set('key_clients_public', copy); }} className="col-span-2 rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none" />
            </div>
            <textarea placeholder="Testimonial Quote" value={kc.testimonial_quote ?? ''} onChange={(e) => { const copy = [...(data.key_clients_public ?? [])]; copy[i] = { ...copy[i], testimonial_quote: e.target.value }; set('key_clients_public', copy); }} rows={2} className="mt-2 w-full rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none" />
            <button type="button" onClick={() => set('key_clients_public', (data.key_clients_public ?? []).filter((_: any, j: number) => j !== i))} className="mt-1 text-xs text-red-400 hover:text-red-300">Remove</button>
          </div>
        ))}
        <button type="button" onClick={() => set('key_clients_public', [...(data.key_clients_public ?? []), { name: '', vertical: '', location: '', testimonial_quote: '', attribution: '', source_url: '' }])} className="rounded-lg border border-dashed border-white/10 px-3 py-1 text-xs text-white/55 hover:border-white/20 hover:text-white">+ Add Client</button>
      </Section>
      )}

      {/* Awards & Badges */}
      <Section title="Awards & Badges">
        {(data.awards ?? []).map((aw: any, i: number) => (
          <div key={i} className="mb-3 rounded border border-white/10 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <input placeholder="Award Name" value={aw.name ?? ''} onChange={(e) => { const copy = [...(data.awards ?? [])]; copy[i] = { ...copy[i], name: e.target.value }; set('awards', copy); }} className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none" />
              <select value={aw.verification_status ?? 'unverified_at_ingestion'} onChange={(e) => { const copy = [...(data.awards ?? [])]; copy[i] = { ...copy[i], verification_status: e.target.value }; set('awards', copy); }} className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none">
                <option value="unverified_at_ingestion">Unverified</option>
                <option value="verified">Verified</option>
                <option value="pending">Pending</option>
              </select>
              <input placeholder="Source URL" value={aw.source_url ?? ''} onChange={(e) => { const copy = [...(data.awards ?? [])]; copy[i] = { ...copy[i], source_url: e.target.value }; set('awards', copy); }} className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none" />
              <label className="flex items-center gap-2 text-xs text-white/55">
                <input type="checkbox" checked={aw.source_required ?? true} onChange={(e) => { const copy = [...(data.awards ?? [])]; copy[i] = { ...copy[i], source_required: e.target.checked }; set('awards', copy); }} className="rounded border-neutral-600" />
                Source Required
              </label>
            </div>
            <textarea placeholder="Notes" value={aw.notes ?? ''} onChange={(e) => { const copy = [...(data.awards ?? [])]; copy[i] = { ...copy[i], notes: e.target.value }; set('awards', copy); }} rows={2} className="mt-2 w-full rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none" />
            <button type="button" onClick={() => set('awards', (data.awards ?? []).filter((_: any, j: number) => j !== i))} className="mt-1 text-xs text-red-400 hover:text-red-300">Remove</button>
          </div>
        ))}
        <button type="button" onClick={() => set('awards', [...(data.awards ?? []), { name: '', source_url: '', source_required: true, verification_status: 'unverified_at_ingestion', notes: '' }])} className="rounded-lg border border-dashed border-white/10 px-3 py-1 text-xs text-white/55 hover:border-white/20 hover:text-white">+ Add Award</button>
      </Section>

      {/* Third-Party Listings — drives the cross-source vector alignment scan
          (BBB / Super Lawyers / Avvo / Justia / Findlaw / Healthgrades / etc.).
          Each entry is fetched, embedded, and compared to the Brand Truth
          centroid; divergent listings open a remediation ticket. The
          `source` value should match what entity_signal expects so admin
          aggregations stay consistent. */}
      <Section title="Third-Party Directory Listings">
        <p className="mb-2 text-xs text-white/55">
          One entry per BBB / Super Lawyers / Avvo / Justia / Findlaw / Healthgrades /
          Zocdoc / Yelp / Clutch / G2 profile page. The cross-source scan checks each
          for vector alignment with this Brand Truth.
        </p>
        {(data.third_party_listings ?? []).map((tl: any, i: number) => (
          <div key={i} className="mb-3 rounded border border-white/10 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                placeholder="Source (e.g. bbb, superlawyers, avvo)"
                value={tl.source ?? ''}
                onChange={(e) => {
                  const copy = [...(data.third_party_listings ?? [])];
                  copy[i] = { ...copy[i], source: e.target.value };
                  set('third_party_listings', copy);
                }}
                className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
              />
              <input
                placeholder="Profile URL"
                value={tl.url ?? ''}
                onChange={(e) => {
                  const copy = [...(data.third_party_listings ?? [])];
                  copy[i] = { ...copy[i], url: e.target.value };
                  set('third_party_listings', copy);
                }}
                className="rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
              />
            </div>
            <input
              placeholder="Notes (optional)"
              value={tl.notes ?? ''}
              onChange={(e) => {
                const copy = [...(data.third_party_listings ?? [])];
                copy[i] = { ...copy[i], notes: e.target.value };
                set('third_party_listings', copy);
              }}
              className="mt-2 w-full rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-white focus:border-[var(--accent)] focus:outline-none"
            />
            <button
              type="button"
              onClick={() =>
                set(
                  'third_party_listings',
                  (data.third_party_listings ?? []).filter((_: any, j: number) => j !== i),
                )
              }
              className="mt-1 text-xs text-red-400 hover:text-red-300"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            set('third_party_listings', [
              ...(data.third_party_listings ?? []),
              { source: '', url: '', notes: '' },
            ])
          }
          className="rounded-lg border border-dashed border-white/10 px-3 py-1 text-xs text-white/55 hover:border-white/20 hover:text-white"
        >
          + Add Listing
        </button>
      </Section>

      {/* Service Areas + Compliance
          - Service Areas (strings) only live on marketing_agency / other schemas.
          - Compliance Jurisdictions is a base field and always available. */}
      <Section title="Service Areas & Compliance">
        {(data.firm_type === 'marketing_agency' || data.firm_type === 'other') && (
          <StringArray label="Service Areas" items={data.service_areas ?? []} onChange={(v) => set('service_areas', v)} />
        )}
        <div className={(data.firm_type === 'marketing_agency' || data.firm_type === 'other') ? 'mt-4' : ''}>
          <StringArray label="Compliance Jurisdictions" items={data.compliance_jurisdictions ?? []} onChange={(v) => set('compliance_jurisdictions', v)} />
        </div>
      </Section>

      {/* Save (hidden in read-only mode) */}
      {!isReadOnly && (
        <div className="sticky bottom-0 flex items-center gap-4 border-t border-white/10 bg-[var(--bg-primary)] py-4">
          <button
            type="submit"
            disabled={isPending}
            className="rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-black transition hover:bg-[var(--accent-hover)] disabled:opacity-50"
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
      <h2 className="text-sm font-semibold text-white/55">Version History</h2>
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
              className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition hover:border-[var(--accent)]/30 ${
                (viewingVersion === null && v.version === currentVersion) || viewingVersion === v.version
                  ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                  : 'border-white/10 text-white/55'
              }`}
            >
              <span className="font-medium">v{v.version}</span>
              {v.version === currentVersion && <span className="ml-1 text-white/40">(latest)</span>}
              {/*
                `toLocaleDateString` with hour/minute options is locale + TZ
                sensitive — the server (UTC) and the client (the operator's
                local TZ) produce different strings, which throws React #418
                hydration mismatches. We *want* the local time on the client,
                so suppress the warning at this exact span. React will swap
                the server's UTC string for the client's local string on
                first render. The visible flicker is acceptable for a
                version-history sidebar.
              */}
              <span className="ml-2" suppressHydrationWarning>
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
