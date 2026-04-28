'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  Sparkles,
  XCircle,
} from 'lucide-react';
import {
  generateRewriteDraft,
  acceptRewriteDraft,
  rejectRewriteDraft,
  type SuppressionFindingDetail,
  type RewriteDraftStatus,
} from '../../../../actions/rewrite-draft-actions';

/**
 * Client shell for the finding-detail page.
 *
 * Responsibilities:
 *  - Trigger draft generation (initial + regenerate)
 *  - Render the side-by-side "was / will be" diff
 *  - Expose accept / reject buttons and mirror their effect in local state
 *    (so the operator sees status change without a hard refresh)
 *
 * Data flows one-way from the server: mutations call server actions which
 * call `revalidatePath`, so `router.refresh()` after success pulls the fresh
 * draft back into `initialDetail`. We keep a tiny piece of optimistic state
 * (status + error) for the in-between render.
 */

type Detail = SuppressionFindingDetail;

const STATUS_STYLES: Record<RewriteDraftStatus, string> = {
  draft: 'bg-white/10 text-white/70',
  accepted: 'bg-[var(--rag-green-bg)] text-[var(--rag-green)]',
  rejected: 'bg-[var(--rag-red-bg)] text-[var(--rag-red)]',
};

export function FindingDetailClient({ detail }: { detail: Detail }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Optimistic status — mirrors server state until the next refresh lands.
  const [statusOverride, setStatusOverride] = useState<RewriteDraftStatus | null>(
    null,
  );

  const effectiveStatus: RewriteDraftStatus | null =
    statusOverride ?? detail.draft?.status ?? null;

  const hasDraft = detail.draft !== null;
  const btvDrift =
    detail.draft &&
    detail.draft.currentBrandTruthVersionId &&
    detail.draft.brandTruthVersionId &&
    detail.draft.currentBrandTruthVersionId !== detail.draft.brandTruthVersionId;

  const handleGenerate = () => {
    setError(null);
    setStatusOverride(null);
    startTransition(async () => {
      const result = await generateRewriteDraft(
        detail.firmSlug,
        detail.finding.id,
      );
      if ('error' in result) {
        setError(result.error);
      } else {
        router.refresh();
      }
    });
  };

  const handleAccept = () => {
    setError(null);
    startTransition(async () => {
      const result = await acceptRewriteDraft(detail.firmSlug, detail.finding.id);
      if ('error' in result) {
        setError(result.error);
      } else {
        setStatusOverride('accepted');
        router.refresh();
      }
    });
  };

  const handleReject = () => {
    setError(null);
    startTransition(async () => {
      const result = await rejectRewriteDraft(detail.firmSlug, detail.finding.id);
      if ('error' in result) {
        setError(result.error);
      } else {
        setStatusOverride('rejected');
        router.refresh();
      }
    });
  };

  return (
    <>
      {/* Rationale banner */}
      {detail.finding.rationale && (
        <div className="mb-6 rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle
              size={16}
              strokeWidth={1.5}
              className="mt-0.5 shrink-0 text-[var(--rag-yellow)]"
            />
            <p className="text-sm text-white/70">{detail.finding.rationale}</p>
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60"
        >
          {isPending ? (
            <>
              <Loader2 size={16} strokeWidth={2} className="animate-spin" />
              {hasDraft ? 'Regenerating…' : 'Generating…'}
            </>
          ) : (
            <>
              <Sparkles size={16} strokeWidth={2} />
              {hasDraft ? 'Regenerate draft' : 'Generate rewrite draft'}
            </>
          )}
        </button>

        {hasDraft && (
          <>
            <button
              type="button"
              onClick={handleAccept}
              disabled={isPending || effectiveStatus === 'accepted'}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-transparent px-5 py-2.5 text-sm text-white transition-colors hover:border-[var(--rag-green)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CheckCircle2 size={14} strokeWidth={1.5} />
              Accept
            </button>
            <button
              type="button"
              onClick={handleReject}
              disabled={isPending || effectiveStatus === 'rejected'}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-transparent px-5 py-2.5 text-sm text-white transition-colors hover:border-[var(--rag-red)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <XCircle size={14} strokeWidth={1.5} />
              Reject
            </button>
          </>
        )}

        {effectiveStatus && (
          <span
            className={`rounded-full px-3 py-1 text-[10px] font-medium uppercase tracking-wider ${STATUS_STYLES[effectiveStatus]}`}
          >
            {effectiveStatus}
          </span>
        )}
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] p-4 text-sm text-[var(--rag-red)]">
          {error}
        </div>
      )}

      {btvDrift && (
        <div className="mb-6 rounded-xl border border-[var(--rag-yellow)]/30 bg-[var(--rag-yellow-bg)] p-4 text-sm text-[var(--rag-yellow)]">
          This draft was generated against an earlier Brand Truth version. The
          Brand Truth has been updated since — regenerate to align with the
          current version.
        </div>
      )}

      {!hasDraft ? (
        <EmptyDraftState isPending={isPending} />
      ) : (
        <DraftView detail={detail} />
      )}
    </>
  );
}

function EmptyDraftState({ isPending }: { isPending: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-[var(--bg-secondary)] py-16 text-center">
      <FileText size={32} strokeWidth={1.5} className="mb-3 text-white/30" />
      <h3 className="mb-2 text-lg font-semibold text-white/70">
        {isPending ? 'Generating a rewrite draft…' : 'No rewrite draft yet'}
      </h3>
      <p className="max-w-md text-sm text-white/40">
        {isPending
          ? 'Claude is rewriting this page against the current Brand Truth. Takes about 20-40 seconds.'
          : 'Click “Generate rewrite draft” to have Claude produce a Brand-Truth-aligned replacement for this page. The original entities (names, credentials, contact details) will be preserved.'}
      </p>
    </div>
  );
}

function DraftView({ detail }: { detail: Detail }) {
  if (!detail.draft) return null;
  const d = detail.draft;

  return (
    <div className="flex flex-col gap-6">
      {/* Change summary */}
      {d.changeSummary && (
        <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
          <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
            What changed
          </div>
          <p className="mt-2 text-sm text-white/80">{d.changeSummary}</p>
          <div
            className="mt-3 font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40"
            suppressHydrationWarning
          >
            {d.generatedByModel} · ${(d.costUsd ?? 0).toFixed(4)} · generated{' '}
            {new Date(d.generatedAt).toLocaleString()}
          </div>
        </div>
      )}

      {/* Side-by-side diff */}
      <div className="grid gap-4 lg:grid-cols-2">
        <DiffColumn
          heading="Current page"
          tone="warn"
          title={d.currentTitle ?? detail.page.title}
          body={d.currentExcerpt ?? detail.page.mainContent ?? '(no content captured)'}
          truncated={
            (d.currentExcerpt?.endsWith('…') ?? false) ||
            (detail.page.mainContent !== null &&
              (detail.page.mainContent.length ?? 0) > 600)
          }
        />
        <DiffColumn
          heading="Proposed rewrite"
          tone="ok"
          title={d.proposedTitle}
          body={d.proposedBody}
        />
      </div>

      {/* Review aids */}
      <div className="grid gap-4 lg:grid-cols-3">
        <ReviewList
          heading="Entities preserved"
          tone="neutral"
          items={d.entitiesPreserved}
          emptyLabel="None detected — review manually"
        />
        <ReviewList
          heading="Positioning fixes"
          tone="ok"
          items={d.positioningFixes}
          emptyLabel="No positioning changes flagged"
        />
        <ReviewList
          heading="Banned claims avoided"
          tone="warn"
          items={d.bannedClaimsAvoided}
          emptyLabel="None present in legacy page"
        />
      </div>
    </div>
  );
}

function DiffColumn({
  heading,
  tone,
  title,
  body,
  truncated,
}: {
  heading: string;
  tone: 'ok' | 'warn';
  title: string | null;
  body: string;
  truncated?: boolean;
}) {
  const borderClass =
    tone === 'ok' ? 'border-[var(--rag-green)]/20' : 'border-[var(--rag-yellow)]/20';
  const labelClass =
    tone === 'ok' ? 'text-[var(--rag-green)]' : 'text-[var(--rag-yellow)]';
  return (
    <div className={`rounded-xl border bg-[var(--bg-secondary)] p-5 ${borderClass}`}>
      <div
        className={`text-[10px] font-medium uppercase tracking-widest ${labelClass}`}
      >
        {heading}
      </div>
      {title ? (
        <h3 className="mt-2 font-[family-name:var(--font-jakarta)] text-lg font-semibold text-white">
          {title}
        </h3>
      ) : (
        <h3 className="mt-2 font-[family-name:var(--font-jakarta)] text-lg font-semibold text-white/40 italic">
          (no title)
        </h3>
      )}
      <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-white/80">
        {body}
      </div>
      {truncated && (
        <p className="mt-3 font-[family-name:var(--font-geist-mono)] text-[10px] text-white/30">
          Excerpt — full page content available at the URL above.
        </p>
      )}
    </div>
  );
}

function ReviewList({
  heading,
  tone,
  items,
  emptyLabel,
}: {
  heading: string;
  tone: 'ok' | 'warn' | 'neutral';
  items: string[];
  emptyLabel: string;
}) {
  const labelClass =
    tone === 'ok'
      ? 'text-[var(--rag-green)]'
      : tone === 'warn'
        ? 'text-[var(--rag-yellow)]'
        : 'text-white/55';
  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
      <div
        className={`text-[10px] font-medium uppercase tracking-widest ${labelClass}`}
      >
        {heading}
      </div>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-white/40">{emptyLabel}</p>
      ) : (
        <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-white/75">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
