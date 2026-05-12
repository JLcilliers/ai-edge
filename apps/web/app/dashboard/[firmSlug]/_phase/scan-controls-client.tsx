'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, AlertCircle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import {
  runContentGenerationScan,
  runContentOptimizationScan,
  runTechnicalImplementationScan,
} from '../../../actions/content-scan-actions';

/**
 * The "Run scan" strip at the top of each phase page.
 *
 * Three trigger modes per phase:
 *   - 'route' — the existing scanner UI lives at another URL (Phase 1's
 *               /audits, Phase 4's /entity). Button does a router.push.
 *   - 'action' — phase has a direct scanner server action (Phase 3's
 *                LLM-Friendly + Freshness). Button awaits the action and
 *                surfaces the result inline.
 *   - 'pending' — no scanner wired yet. Button is replaced with a
 *                  "Scanner wiring in progress" pill.
 */

type ScanTrigger =
  | { mode: 'route'; href: string }
  | {
      mode: 'action';
      key: 'content-optimization' | 'technical-implementation' | 'content-generation';
    }
  | { mode: 'pending' };

function triggerFor(phaseKey: string, firmSlug: string): ScanTrigger {
  switch (phaseKey) {
    case 'brand-audit-analysis':
      return { mode: 'route', href: `/dashboard/${firmSlug}/audits` };
    case 'content-optimization':
      return { mode: 'action', key: 'content-optimization' };
    case 'technical-implementation':
      return { mode: 'action', key: 'technical-implementation' };
    case 'content-generation':
      return { mode: 'action', key: 'content-generation' };
    case 'third-party-optimization':
      return { mode: 'route', href: `/dashboard/${firmSlug}/entity` };
    case 'client-services':
      return { mode: 'route', href: `/dashboard/${firmSlug}/reports` };
    case 'measurement-monitoring':
    default:
      return { mode: 'pending' };
  }
}

type Banner =
  | { tone: 'ok'; text: string }
  | { tone: 'error'; text: string }
  | null;

export function ScanControlsClient({
  firmSlug,
  phaseKey,
  lastScan,
}: {
  firmSlug: string;
  phaseKey: string;
  lastScan: {
    completedAt: string | null;
    runsByKey: Array<{
      sopKey: string;
      sopName: string;
      status: string;
      currentStep: number;
      totalSteps: number;
    }>;
  };
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [banner, setBanner] = useState<Banner>(null);

  const trigger = triggerFor(phaseKey, firmSlug);

  const handleRunScan = () => {
    if (trigger.mode === 'route') {
      start(() => {
        router.push(trigger.href);
      });
      return;
    }
    if (trigger.mode === 'action' && trigger.key === 'content-optimization') {
      setBanner(null);
      start(async () => {
        const res = await runContentOptimizationScan(firmSlug, 'both');
        if (!res.ok) {
          setBanner({ tone: 'error', text: res.error });
          return;
        }
        const parts: string[] = [];
        if (res.llmFriendly) {
          parts.push(
            `LLM-Friendly: scored ${res.llmFriendly.pagesScanned} page${
              res.llmFriendly.pagesScanned === 1 ? '' : 's'
            }, ${res.llmFriendly.pagesFailing} below the bar (avg ${res.llmFriendly.averageScore}/7)`,
          );
        }
        if (res.freshness) {
          parts.push(
            `Freshness: ${res.freshness.fresh} fresh / ${res.freshness.aging} aging / ${res.freshness.stale} stale / ${res.freshness.dormant} dormant / ${res.freshness.unknown} undated`,
          );
        }
        const ticketTotal =
          (res.llmFriendly?.ticketsCreated ?? 0) + (res.freshness?.ticketsCreated ?? 0);
        parts.push(`${ticketTotal} execution task${ticketTotal === 1 ? '' : 's'} written`);
        setBanner({ tone: 'ok', text: parts.join(' · ') });
        router.refresh();
      });
      return;
    }
    if (trigger.mode === 'action' && trigger.key === 'content-generation') {
      setBanner(null);
      start(async () => {
        const res = await runContentGenerationScan(firmSlug);
        if (!res.ok) {
          setBanner({ tone: 'error', text: res.error });
          return;
        }
        const t = res.trustAlignment;
        const f = t.findingsByKind;
        const total =
          f.year_inconsistency + f.quantity_inconsistency + f.banned_claim + f.unverified_award;
        const parts: string[] = [
          `Trust Alignment: scanned ${t.pagesScanned} page${t.pagesScanned === 1 ? '' : 's'}, ${total} finding${total === 1 ? '' : 's'}`,
          `${f.year_inconsistency} year · ${f.quantity_inconsistency} qty · ${f.banned_claim} banned · ${f.unverified_award} unverified`,
          `${t.ticketsCreated} execution task${t.ticketsCreated === 1 ? '' : 's'} written`,
        ];
        setBanner({ tone: 'ok', text: parts.join(' · ') });
        router.refresh();
      });
      return;
    }
    if (trigger.mode === 'action' && trigger.key === 'technical-implementation') {
      setBanner(null);
      start(async () => {
        const res = await runTechnicalImplementationScan(firmSlug);
        if (!res.ok) {
          setBanner({ tone: 'error', text: res.error });
          return;
        }
        const sh = res.semanticHtml;
        const sm = res.schemaMarkup;
        const parts: string[] = [
          `Semantic HTML: avg ${sh.averageScore}/100 across ${sh.pagesScanned} page${sh.pagesScanned === 1 ? '' : 's'} (${sh.bandCounts.high} high · ${sh.bandCounts.medium} medium · ${sh.bandCounts.low} low · ${sh.bandCounts.maintenance} maintenance)`,
          `Schema: ${sm.pagesWithFindings}/${sm.pagesScanned} pages flagged (${sm.severityCounts.high} high · ${sm.severityCounts.medium} medium · ${sm.severityCounts.low} low; ${sm.pagesClean} clean)`,
          `${sh.ticketsCreated + sm.ticketsCreated} execution task${
            sh.ticketsCreated + sm.ticketsCreated === 1 ? '' : 's'
          } written`,
        ];
        setBanner({ tone: 'ok', text: parts.join(' · ') });
        router.refresh();
      });
      return;
    }
  };

  const formatRelative = (iso: string | null): string => {
    if (!iso) return 'never';
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.floor(ms / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hr${hr === 1 ? '' : 's'} ago`;
    const day = Math.floor(hr / 24);
    return `${day} day${day === 1 ? '' : 's'} ago`;
  };

  return (
    <div className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Activity size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
              Scan status
            </div>
            <div className="mt-0.5 text-sm font-semibold text-white">
              Last scan: {formatRelative(lastScan.completedAt)}
            </div>
          </div>
        </div>
        {trigger.mode === 'pending' ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/55">
            Scanner wiring in progress
          </span>
        ) : (
          <button
            type="button"
            onClick={handleRunScan}
            disabled={isPending}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} strokeWidth={2} />}
            Run scan
          </button>
        )}
      </div>

      {banner && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] ${
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
        </div>
      )}

      {lastScan.runsByKey.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {lastScan.runsByKey.map((r) => (
            <ScannerStatusPill key={r.sopKey} run={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function ScannerStatusPill({
  run,
}: {
  run: {
    sopKey: string;
    sopName: string;
    status: string;
    currentStep: number;
    totalSteps: number;
  };
}) {
  const toneClass =
    run.status === 'completed'
      ? 'border-[var(--rag-green)]/30 bg-[var(--rag-green-bg)] text-[var(--rag-green)]'
      : run.status === 'in_progress' || run.status === 'awaiting_input'
        ? 'border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--accent)]'
        : run.status === 'failed' || run.status === 'cancelled'
          ? 'border-[var(--rag-red)]/30 bg-[var(--rag-red-bg)] text-[var(--rag-red)]'
          : 'border-white/15 bg-white/5 text-white/55';
  return (
    <div className={`rounded-md border px-3 py-2 ${toneClass}`}>
      <div className="text-[10px] font-semibold uppercase tracking-widest opacity-70">
        {run.status.replace('_', ' ')}
      </div>
      <div className="mt-0.5 truncate text-xs font-medium">{run.sopName}</div>
      {run.totalSteps > 0 && (
        <div className="mt-1 font-[family-name:var(--font-geist-mono)] text-[10px] opacity-70">
          Step {run.currentStep}/{run.totalSteps}
        </div>
      )}
    </div>
  );
}
