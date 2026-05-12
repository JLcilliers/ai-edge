'use client';

import { useState, useTransition } from 'react';
import { Download, FileSpreadsheet, FileText, Loader2, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';
import { exportTicketsXlsx, exportAuditDelivery } from '../../../actions/export-actions';

/**
 * Client-side export toolbar. Two buttons:
 *   - Download tickets (.xlsx)  → exportTicketsXlsx server action
 *   - Build audit delivery deck → exportAuditDelivery server action
 *
 * Both actions return a Vercel Blob URL when storage is configured. We
 * show the URL inline (with an Open link) on success so operators can
 * download immediately. Errors render in red.
 *
 * Used on both /tickets and /client-services pages — the two routes
 * operators land on when they need to hand artifacts to a client.
 */

type Banner =
  | { tone: 'ok'; text: string; url: string | null }
  | { tone: 'error'; text: string; url: null }
  | null;

export function ExportToolbar({ firmSlug }: { firmSlug: string }) {
  const [isPending, start] = useTransition();
  const [banner, setBanner] = useState<Banner>(null);

  const handleTicketsXlsx = () => {
    setBanner(null);
    start(async () => {
      const res = await exportTicketsXlsx(firmSlug);
      if (!res.ok) {
        setBanner({ tone: 'error', text: res.error, url: null });
        return;
      }
      const phaseSummary = Object.entries(res.ticketsByPhase)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([p, n]) => `P${p}:${n}`)
        .join(' · ');
      setBanner({
        tone: 'ok',
        text: `Exported ${res.totalTickets} open ticket${res.totalTickets === 1 ? '' : 's'} (${phaseSummary || 'all phases empty'})`,
        url: res.blobUrl,
      });
    });
  };

  const handleAuditDelivery = () => {
    setBanner(null);
    start(async () => {
      const res = await exportAuditDelivery(firmSlug);
      if (!res.ok) {
        setBanner({ tone: 'error', text: res.error, url: null });
        return;
      }
      setBanner({
        tone: 'ok',
        text: `Audit delivery compiled from ${res.ticketTotal} ticket${res.ticketTotal === 1 ? '' : 's'} · headline: ${res.headlineFinding.slice(0, 90)}${res.headlineFinding.length > 90 ? '…' : ''}`,
        url: res.blobUrl,
      });
    });
  };

  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Download size={14} strokeWidth={2.5} className="text-[var(--accent)]" />
          <span className="text-xs font-semibold uppercase tracking-widest text-white/55">
            Client exports
          </span>
        </div>

        <button
          type="button"
          onClick={handleTicketsXlsx}
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-3.5 py-1.5 text-[11px] font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <FileSpreadsheet size={12} strokeWidth={2.5} />
          )}
          Open tickets (.xlsx)
        </button>

        <button
          type="button"
          onClick={handleAuditDelivery}
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-[11px] font-semibold text-white/85 transition-colors hover:border-white/30 hover:text-white disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <FileText size={12} strokeWidth={2.5} />
          )}
          Audit delivery deck (.md)
        </button>

        <span className="ml-auto text-[10px] text-white/40">
          Persists to deliverables · re-export anytime
        </span>
      </div>

      {banner && (
        <div
          className={`mt-3 flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-[11px] ${
            banner.tone === 'ok'
              ? 'border-[var(--rag-green)]/30 bg-[var(--rag-green-bg)] text-[var(--rag-green)]'
              : 'border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] text-[var(--rag-red)]'
          }`}
        >
          {banner.tone === 'ok' ? (
            <CheckCircle2 size={12} strokeWidth={2.5} className="mt-0.5 shrink-0" />
          ) : (
            <AlertCircle size={12} strokeWidth={2.5} className="mt-0.5 shrink-0" />
          )}
          <span className="break-words">{banner.text}</span>
          {banner.url && (
            <a
              href={banner.url}
              target="_blank"
              rel="noreferrer noopener"
              className="ml-auto inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-white transition-colors hover:bg-white/20"
            >
              <ExternalLink size={10} strokeWidth={2.5} />
              Download
            </a>
          )}
        </div>
      )}
    </div>
  );
}
