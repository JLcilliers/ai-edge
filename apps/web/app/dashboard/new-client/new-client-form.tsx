'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Loader2 } from 'lucide-react';
import { createFirm, type FirmType } from '../../actions/firm-actions';
import { bootstrapBrandTruthForFirm } from '../../actions/brand-truth-actions';

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

/**
 * Trim a user-entered URL into something the bootstrap can use.
 * Accepts "reimerhvac.com" → "https://reimerhvac.com".
 * Returns "" for empty/invalid input so we can skip the bootstrap step
 * gracefully.
 */
function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  // Bare host → prepend https://
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withProtocol);
    return u.toString();
  } catch {
    return '';
  }
}

export function NewClientForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [firmType, setFirmType] = useState<FirmType>('law_firm');
  const [primaryUrl, setPrimaryUrl] = useState('');
  const [bootstrap, setBootstrap] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // What phase of the submit we're on. Drives the button label so the
  // operator knows the create-then-bootstrap step is taking ~30 seconds
  // (Claude long-context) and hasn't hung.
  const [phase, setPhase] = useState<'idle' | 'creating' | 'bootstrapping'>('idle');

  const effectiveSlug = slugTouched ? slug : deriveSlug(name);
  const normalizedUrl = normalizeUrl(primaryUrl);
  const canSubmit = name.trim().length > 0 && effectiveSlug.length > 0 && !isPending;

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(deriveSlug(value));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // If the operator wants bootstrap but provided no URL, surface that
    // up-front rather than racing past the new-client redirect.
    if (bootstrap && !normalizedUrl) {
      setError('Bootstrap is on — please provide the firm\'s website URL (or turn off bootstrap).');
      return;
    }

    startTransition(async () => {
      setPhase('creating');
      const result = await createFirm({
        name: name.trim(),
        firm_type: firmType,
        slug: effectiveSlug,
      });
      if (!result.ok) {
        setPhase('idle');
        setError(result.error);
        return;
      }

      // If the operator opted into bootstrap, run it here. Failures are
      // non-fatal — we land them in the Brand Truth editor either way,
      // with a ?bootstrap=failed flag the editor renders as a one-time
      // banner so the operator knows to author manually.
      if (bootstrap && normalizedUrl) {
        setPhase('bootstrapping');
        const bs = await bootstrapBrandTruthForFirm(result.slug, normalizedUrl);
        if (bs.ok) {
          router.push(`/dashboard/${result.slug}/brand-truth?bootstrap=ok`);
        } else {
          router.push(
            `/dashboard/${result.slug}/brand-truth?bootstrap=failed&reason=${encodeURIComponent(bs.reason ?? bs.error)}`,
          );
        }
        return;
      }

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

      {/* Primary URL + bootstrap toggle */}
      <div>
        <label
          htmlFor="client-url"
          className="mb-2 block text-xs font-medium uppercase tracking-widest text-white/55"
        >
          Website URL
        </label>
        <input
          id="client-url"
          type="text"
          value={primaryUrl}
          onChange={(e) => setPrimaryUrl(e.target.value)}
          placeholder="e.g. example.com or https://example.com"
          className="w-full rounded-lg border border-white/10 bg-black/30 px-4 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-[var(--accent)] focus:outline-none"
        />
        <p className="mt-1.5 text-xs text-white/40">
          Drives the suppression scan and the bootstrap pre-population below.
        </p>

        {/* Bootstrap toggle */}
        <label
          htmlFor="client-bootstrap"
          className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-black/20 p-3 transition-colors hover:border-white/20"
        >
          <input
            id="client-bootstrap"
            type="checkbox"
            checked={bootstrap}
            onChange={(e) => setBootstrap(e.target.checked)}
            className="mt-1 h-4 w-4 accent-[var(--accent)]"
          />
          <span className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
              <Sparkles size={14} strokeWidth={1.5} className="text-[var(--accent)]" />
              Bootstrap Brand Truth from the website
            </span>
            <span className="text-xs text-white/55">
              Scans the site + JSON-LD and pre-populates the Brand Truth v1. Takes ~30s and
              costs ~$0.05. You'll land in the editor with everything filled in for review.
            </span>
          </span>
        </label>
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
          className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {phase === 'bootstrapping' ? (
            <>
              <Loader2 size={14} strokeWidth={2} className="animate-spin" />
              Bootstrapping Brand Truth (~30s)…
            </>
          ) : phase === 'creating' ? (
            <>
              <Loader2 size={14} strokeWidth={2} className="animate-spin" />
              Creating client…
            </>
          ) : (
            'Create Client'
          )}
        </button>
      </div>
    </form>
  );
}
