'use client';

import { useState } from 'react';
import { Copy, ExternalLink, Check, ChevronDown, ChevronUp, AlertOctagon, Sparkles } from 'lucide-react';
import type { ExecutionTask } from '../../../actions/sop-actions';

/**
 * Single row in the phase page's execution-task list.
 *
 * Renders the title + priority + tier badge + the right action button:
 *   auto   → green [Apply] button (server action wiring lands in the
 *            next iteration once the per-platform integrations are
 *            tested)
 *   assist → yellow [Open <Platform> →] button + Copy button for
 *            remediation_copy + expandable validation steps
 *   manual → red [Why manual?] expander + manual_reason quote
 *
 * Expanded view always shows: description, remediation_copy (when
 * present), validation_steps, evidence links.
 */
export function ExecutionTaskRow({ task }: { task: ExecutionTask }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const tierBadge = (() => {
    if (task.automationTier === 'auto') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--rag-green)]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--rag-green)]">
          <Sparkles size={9} strokeWidth={2.5} />
          Auto
        </span>
      );
    }
    if (task.automationTier === 'assist') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--rag-yellow-bg)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--rag-yellow)]">
          Assist
        </span>
      );
    }
    if (task.automationTier === 'manual') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--rag-red-bg)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--rag-red)]">
          <AlertOctagon size={9} strokeWidth={2.5} />
          Manual
        </span>
      );
    }
    return null;
  })();

  const handleCopy = async () => {
    if (!task.remediationCopy) return;
    try {
      await navigator.clipboard.writeText(task.remediationCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable — fall through */
    }
  };

  return (
    <article className="rounded-lg border border-white/10 bg-black/20 px-3.5 py-3 transition-colors hover:border-white/20">
      <header className="flex items-start gap-2.5">
        {/* Priority rank */}
        {task.priorityRank != null && (
          <span className="mt-0.5 inline-flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-white/10 px-1.5 font-[family-name:var(--font-geist-mono)] text-[10px] font-semibold text-white/70">
            #{task.priorityRank}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setExpanded((x) => !x)}
            className="block w-full text-left"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 text-sm font-semibold text-white">
                {task.title}
              </div>
              {tierBadge}
              {expanded ? (
                <ChevronUp size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-white/40" />
              ) : (
                <ChevronDown size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-white/40" />
              )}
            </div>
            {task.description && !expanded && (
              <div className="mt-0.5 line-clamp-1 text-xs text-white/55">{task.description}</div>
            )}
          </button>
        </div>
        {/* Action button */}
        {task.automationTier === 'auto' && (
          <button
            type="button"
            // Server action wiring per platform lands in the next
            // iteration. Keeping the button disabled with a clear
            // tooltip beats showing it as live and erroring at click.
            disabled
            title="Auto-apply integration wires in the next iteration — until then, use the assist flow"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--rag-green)]/20 px-3 py-1.5 text-[11px] font-semibold text-[var(--rag-green)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Sparkles size={11} strokeWidth={2.5} />
            Apply
          </button>
        )}
        {task.automationTier === 'assist' && task.executeUrl && (
          <a
            href={task.executeUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-white/80 transition-colors hover:border-white/30 hover:text-white"
          >
            <ExternalLink size={11} strokeWidth={2.5} />
            {task.executeLabel ?? 'Open'}
          </a>
        )}
      </header>

      {expanded && (
        <div className="mt-3 flex flex-col gap-3 border-t border-white/5 pt-3">
          {task.description && (
            <p className="text-xs text-white/65">{task.description}</p>
          )}

          {task.automationTier === 'manual' && task.manualReason && (
            <div className="rounded-md border border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)]/40 p-2.5">
              <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--rag-red)]">
                <AlertOctagon size={10} strokeWidth={2.5} />
                Why this is manual
              </div>
              <p className="text-[11px] text-white/80">{task.manualReason}</p>
            </div>
          )}

          {task.remediationCopy && (
            <div className="rounded-md border border-white/10 bg-black/40 p-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-white/55">
                  Remediation copy
                </span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-0.5 text-[10px] font-medium text-white/70 transition-colors hover:border-white/30 hover:text-white"
                >
                  {copied ? <Check size={9} strokeWidth={2.5} /> : <Copy size={9} strokeWidth={2.5} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-[family-name:var(--font-geist-mono)] text-[11px] text-white/85">
                {task.remediationCopy}
              </pre>
            </div>
          )}

          {task.validationSteps && task.validationSteps.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/55">
                Validation steps
              </div>
              <ul className="ml-4 list-decimal space-y-0.5 text-[11px] text-white/70">
                {task.validationSteps.map((v, i) => (
                  <li key={i}>{v.description}</li>
                ))}
              </ul>
            </div>
          )}

          {task.evidenceLinks && task.evidenceLinks.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/55">
                Evidence
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {task.evidenceLinks.map((e, i) => (
                  <li key={i}>
                    <a
                      href={e.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-white/70 transition-colors hover:border-white/20 hover:text-white"
                      title={e.description}
                    >
                      <ExternalLink size={9} strokeWidth={2.5} />
                      {(() => {
                        try {
                          return new URL(e.url).hostname.replace(/^www\./, '');
                        } catch {
                          return e.url.slice(0, 40);
                        }
                      })()}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 text-[10px] text-white/40">
            {task.owner && <span>Owner: {task.owner}</span>}
            {!task.owner && <span>Owner: unassigned</span>}
            {task.dueAt && <span>Due: {new Date(task.dueAt).toLocaleDateString()}</span>}
            {task.status && <span>Status: {task.status}</span>}
          </div>
        </div>
      )}
    </article>
  );
}
