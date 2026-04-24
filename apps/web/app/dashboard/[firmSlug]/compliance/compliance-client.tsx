'use client';

import { useState, useTransition, useMemo } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import {
  checkCopyCompliance,
  type ComplianceHitDto,
} from '../../../actions/compliance-actions';

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'result'; hits: ComplianceHitDto[]; checkedAt: number }
  | { kind: 'error'; message: string };

export function ComplianceClient({ firmSlug }: { firmSlug: string }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<CheckState>({ kind: 'idle' });
  const [isPending, startTransition] = useTransition();

  const runCheck = () => {
    const payload = text.trim();
    if (!payload) {
      setState({ kind: 'idle' });
      return;
    }
    setState({ kind: 'checking' });
    startTransition(async () => {
      try {
        const res = await checkCopyCompliance(firmSlug, payload);
        setState({
          kind: 'result',
          hits: res.hits,
          checkedAt: Date.now(),
        });
      } catch (err) {
        setState({ kind: 'error', message: String(err) });
      }
    });
  };

  // Build an annotated copy of the text with hit spans highlighted — we
  // render the text with inline <mark> tags so reviewers can see exactly
  // where each violation lives.
  const annotated = useMemo(() => {
    if (state.kind !== 'result' || state.hits.length === 0) return null;
    const sorted = [...state.hits].sort((a, b) => a.index - b.index);
    const parts: Array<{ text: string; hit?: ComplianceHitDto }> = [];
    let cursor = 0;
    for (const h of sorted) {
      // Clamp in case two hits overlap — take the first one wins.
      if (h.index < cursor) continue;
      if (h.index > cursor) {
        parts.push({ text: text.slice(cursor, h.index) });
      }
      parts.push({ text: text.slice(h.index, h.index + h.match.length), hit: h });
      cursor = h.index + h.match.length;
    }
    if (cursor < text.length) parts.push({ text: text.slice(cursor) });
    return parts;
  }, [state, text]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Input */}
      <div className="flex flex-col">
        <label
          htmlFor="compliance-text"
          className="mb-2 text-xs font-medium uppercase tracking-widest text-white/55"
        >
          Copy to check
        </label>
        <textarea
          id="compliance-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste remediation copy, an ad, an email draft, or landing-page text here…"
          className="h-72 rounded-xl border border-white/10 bg-[--bg-secondary] p-4 font-[family-name:var(--font-geist-mono)] text-sm text-white/80 outline-none transition focus:border-[--accent]/50"
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-white/40">
            {text.length.toLocaleString()} chars
          </span>
          <button
            type="button"
            onClick={runCheck}
            disabled={!text.trim() || isPending}
            className="flex items-center gap-2 rounded-full bg-[--accent] px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isPending || state.kind === 'checking' ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Checking…
              </>
            ) : (
              'Check compliance'
            )}
          </button>
        </div>
      </div>

      {/* Results */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-widest text-white/55">
            Results
          </span>
          {state.kind === 'result' && (
            <span className="font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40">
              checked {new Date(state.checkedAt).toLocaleTimeString()}
            </span>
          )}
        </div>

        <ResultsPanel state={state} annotated={annotated} />
      </div>
    </div>
  );
}

function ResultsPanel({
  state,
  annotated,
}: {
  state: CheckState;
  annotated: Array<{ text: string; hit?: ComplianceHitDto }> | null;
}) {
  if (state.kind === 'idle' || state.kind === 'checking') {
    return (
      <div className="flex h-72 items-center justify-center rounded-xl border border-dashed border-white/10 bg-[--bg-secondary] p-6 text-center">
        <p className="text-sm text-white/40">
          {state.kind === 'checking'
            ? 'Scanning against jurisdictional rulebook + firm banned phrases…'
            : 'Paste copy and click "Check compliance" to scan.'}
        </p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="rounded-xl border border-red-500/40 bg-[--bg-secondary] p-5">
        <p className="font-semibold text-red-300">Check failed</p>
        <p className="mt-1 font-[family-name:var(--font-geist-mono)] text-xs text-white/60">
          {state.message}
        </p>
      </div>
    );
  }

  // state.kind === 'result'
  if (state.hits.length === 0) {
    return (
      <div className="rounded-xl border border-[--rag-green]/30 bg-[--bg-secondary] p-5">
        <div className="flex items-start gap-3">
          <CheckCircle2
            size={20}
            strokeWidth={1.5}
            className="mt-0.5 shrink-0 text-[--rag-green]"
          />
          <div>
            <p className="font-semibold text-[--rag-green]">
              No violations detected
            </p>
            <p className="mt-1 text-sm text-white/60">
              Copy passes every active jurisdictional rule and the
              firm&apos;s own banned-phrase list. Final ethics-counsel
              sign-off still required before external publication.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-red-500/40 bg-[--bg-secondary] p-5">
        <div className="flex items-start gap-3">
          <AlertCircle
            size={20}
            strokeWidth={1.5}
            className="mt-0.5 shrink-0 text-red-300"
          />
          <div>
            <p className="font-semibold text-red-300">
              {state.hits.length} violation
              {state.hits.length === 1 ? '' : 's'} found
            </p>
            <p className="mt-1 text-sm text-white/60">
              Do not ship this copy to a client-facing surface without
              fixing each flagged phrase.
            </p>
          </div>
        </div>
      </div>

      {annotated && (
        <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-4">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-widest text-white/40">
            Annotated copy
          </div>
          <div className="whitespace-pre-wrap font-[family-name:var(--font-geist-mono)] text-sm leading-relaxed text-white/80">
            {annotated.map((p, i) =>
              p.hit ? (
                <mark
                  key={i}
                  className="rounded bg-red-500/30 px-0.5 text-red-200"
                  title={`${p.hit.jurisdiction}: ${p.hit.reason}`}
                >
                  {p.text}
                </mark>
              ) : (
                <span key={i}>{p.text}</span>
              ),
            )}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-[--bg-secondary]">
        <div className="grid grid-cols-[auto_1fr_auto] gap-4 border-b border-white/5 bg-[--bg-tertiary] px-5 py-3 text-[10px] font-medium uppercase tracking-widest text-white/55">
          <span>Source</span>
          <span>Phrase</span>
          <span>Reason</span>
        </div>
        {state.hits.map((h, i) => (
          <div
            key={i}
            className="grid grid-cols-[auto_1fr_auto] items-start gap-4 border-b border-white/5 px-5 py-3 text-sm last:border-b-0"
          >
            <span
              className={`rounded-full border px-2 py-0.5 font-[family-name:var(--font-geist-mono)] text-[10px] uppercase tracking-wider ${
                h.jurisdiction.startsWith('firm:')
                  ? 'border-amber-500/40 text-amber-300'
                  : 'border-white/10 text-white/70'
              }`}
            >
              {h.jurisdiction.replace('firm:', '')}
            </span>
            <span className="font-[family-name:var(--font-geist-mono)] text-red-300">
              {h.match}
            </span>
            <span className="max-w-sm text-right text-xs text-white/55">
              {h.reason}
              {h.sourceUrl && (
                <>
                  {' '}
                  <a
                    href={h.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[--accent] underline"
                  >
                    ref
                  </a>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
