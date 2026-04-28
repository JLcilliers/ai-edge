'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createFirm, type FirmType } from '../../actions/firm-actions';

const FIRM_TYPE_OPTIONS: { value: FirmType; label: string; hint: string }[] = [
  { value: 'law_firm', label: 'Law Firm', hint: 'Solo / boutique / multi-office' },
  { value: 'dental_practice', label: 'Dental Practice', hint: 'Single or group practice' },
  { value: 'marketing_agency', label: 'Marketing Agency', hint: 'In-house brand or agency' },
  { value: 'other', label: 'Other', hint: 'Anything else' },
];

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function NewClientForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [firmType, setFirmType] = useState<FirmType>('law_firm');
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugTouched ? slug : deriveSlug(name);
  const canSubmit = name.trim().length > 0 && effectiveSlug.length > 0 && !isPending;

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(deriveSlug(value));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createFirm({
        name: name.trim(),
        firm_type: firmType,
        slug: effectiveSlug,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Land the user on Brand Truth so they can configure the new client immediately.
      router.push(`/dashboard/${result.slug}/brand-truth`);
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {/* Name */}
      <div>
        <label
          htmlFor="client-name"
          className="mb-2 block text-xs font-medium uppercase tracking-widest text-white/55"
        >
          Client name
        </label>
        <input
          id="client-name"
          type="text"
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="e.g. Smith &amp; Partners Law"
          autoFocus
          required
          className="w-full rounded-lg border border-white/10 bg-black/30 px-4 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-[var(--accent)] focus:outline-none"
        />
      </div>

      {/* Slug */}
      <div>
        <label
          htmlFor="client-slug"
          className="mb-2 block text-xs font-medium uppercase tracking-widest text-white/55"
        >
          URL slug
        </label>
        <div className="flex items-center gap-0 rounded-lg border border-white/10 bg-black/30 focus-within:border-[var(--accent)]">
          <span className="pl-4 font-[family-name:var(--font-geist-mono)] text-sm text-white/40">
            /dashboard/
          </span>
          <input
            id="client-slug"
            type="text"
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
            }}
            placeholder="smith-partners"
            pattern="[a-z0-9-]+"
            className="flex-1 bg-transparent px-2 py-2.5 font-[family-name:var(--font-geist-mono)] text-sm text-white placeholder:text-white/30 focus:outline-none"
          />
        </div>
        <p className="mt-1.5 text-xs text-white/40">
          Lowercase letters, numbers, and dashes. Used in every URL.
        </p>
      </div>

      {/* Firm type */}
      <div>
        <label className="mb-2 block text-xs font-medium uppercase tracking-widest text-white/55">
          Client type
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          {FIRM_TYPE_OPTIONS.map((opt) => {
            const selected = firmType === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setFirmType(opt.value)}
                className={`flex flex-col gap-0.5 rounded-lg border px-4 py-3 text-left transition-colors ${
                  selected
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                    : 'border-white/10 bg-black/20 hover:border-white/20'
                }`}
              >
                <span className="text-sm font-semibold text-white">{opt.label}</span>
                <span className="text-xs text-white/40">{opt.hint}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-xs text-white/40">
          Drives the Brand Truth schema and default compliance jurisdictions.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/15 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="mt-2 flex items-center justify-end gap-3">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {isPending ? 'Creating...' : 'Create Client'}
        </button>
      </div>
    </form>
  );
}
