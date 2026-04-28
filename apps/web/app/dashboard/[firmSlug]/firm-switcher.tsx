'use client';

import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { ChevronsUpDown, Plus, Check, Scale, Stethoscope, Megaphone, HelpCircle, Building2 } from 'lucide-react';
import type { FirmRow, FirmType } from '../../actions/firm-actions';

const FIRM_TYPE_ICON: Record<FirmType, typeof Building2> = {
  law_firm: Scale,
  dental_practice: Stethoscope,
  marketing_agency: Megaphone,
  other: HelpCircle,
};

export function FirmSwitcher({
  current,
  firms,
}: {
  current: FirmRow;
  firms: FirmRow[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const CurrentIcon = FIRM_TYPE_ICON[current.firm_type];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-[var(--bg-secondary)] px-3 py-2.5 text-left transition-colors hover:border-white/20"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/5">
          <CurrentIcon size={16} strokeWidth={1.5} className="text-[var(--accent)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-[family-name:var(--font-jakarta)] text-sm font-semibold text-white">
            {current.name}
          </div>
          <div className="truncate font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40">
            /{current.slug}
          </div>
        </div>
        <ChevronsUpDown size={14} strokeWidth={1.5} className="shrink-0 text-white/40" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-xl border border-white/10 bg-[var(--bg-secondary)] shadow-xl"
        >
          <div className="max-h-64 overflow-y-auto py-1">
            {firms.map((f) => {
              const Icon = FIRM_TYPE_ICON[f.firm_type];
              const isActive = f.slug === current.slug;
              return (
                <Link
                  key={f.id}
                  href={`/dashboard/${f.slug}`}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-white/[0.04] ${
                    isActive ? 'bg-white/[0.03]' : ''
                  }`}
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/5">
                    <Icon size={14} strokeWidth={1.5} className="text-[var(--accent)]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-white/90">{f.name}</div>
                    <div className="truncate font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40">
                      /{f.slug}
                    </div>
                  </div>
                  {isActive && (
                    <Check size={14} strokeWidth={2} className="shrink-0 text-[var(--accent)]" />
                  )}
                </Link>
              );
            })}
          </div>
          <Link
            href="/dashboard/new-client"
            onClick={() => setOpen(false)}
            className="flex items-center gap-3 border-t border-white/10 px-3 py-2.5 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10"
          >
            <Plus size={14} strokeWidth={2} />
            Add Client
          </Link>
        </div>
      )}
    </div>
  );
}
