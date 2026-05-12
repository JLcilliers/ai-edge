'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, Loader2, AlertTriangle } from 'lucide-react';
import { deleteFirmFromAdmin } from '../../actions/admin-actions';

/**
 * Inline delete-account control for the admin firm-health table.
 *
 * Idle state: small ghost trash button on the right of each row.
 * Active state: inline confirmation panel below the row asking the
 * operator to type the firm name. Server action only runs when the
 * typed name matches exactly — same gate as the per-firm Danger Zone
 * in Settings.
 *
 * On success the page revalidates and the row disappears. On failure
 * the error renders inline so the operator sees why the delete didn't
 * happen.
 */
export function DeleteFirmButton({
  firmId,
  firmName,
}: {
  firmId: string;
  firmName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setTyped('');
          setError(null);
        }}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-transparent text-white/40 transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-300"
        title={`Delete ${firmName} (cannot be undone)`}
        aria-label={`Delete ${firmName}`}
      >
        <Trash2 size={14} strokeWidth={2} />
      </button>
    );
  }

  const canSubmit = typed.trim() === firmName && !isPending;

  return (
    <div className="flex max-w-md flex-col gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-red-300" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-red-200">
            Delete {firmName} permanently?
          </div>
          <p className="mt-1 text-[11px] text-white/55">
            Removes the firm and every row scoped to it: audit history, Brand
            Truth versions, suppression findings, rewrite drafts, competitor
            roster, Reddit mentions, monthly reports, SOP runs. There is no
            undo. Cascades are enforced at the database layer.
          </p>
        </div>
      </div>
      <input
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={`Type "${firmName}" to confirm`}
        autoFocus
        className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white placeholder:text-white/30 focus:border-red-500/50 focus:outline-none"
      />
      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-200">
          {error}
        </div>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setTyped('');
            setError(null);
          }}
          disabled={isPending}
          className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-white/55 transition-colors hover:border-white/30 hover:text-white disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => {
            setError(null);
            start(async () => {
              const r = await deleteFirmFromAdmin({
                firmId,
                confirmationName: typed,
              });
              if (r.ok) {
                // Page server component will re-fetch firm health on
                // refresh; the row disappears.
                router.refresh();
              } else {
                setError(r.error);
              }
            });
          }}
          className="inline-flex items-center gap-1.5 rounded-full bg-red-500 px-3 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Trash2 size={11} strokeWidth={2} />
          )}
          Delete firm permanently
        </button>
      </div>
    </div>
  );
}
