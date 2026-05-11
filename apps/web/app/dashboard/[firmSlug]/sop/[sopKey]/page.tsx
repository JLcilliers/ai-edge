import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, BookOpen, Clock } from 'lucide-react';
import { getSopRunDetail } from '../../../../actions/sop-actions';
import { getFirmBySlug } from '../../../../actions/firm-actions';
import { SOP_REGISTRY } from '../../../../lib/sop/registry';
import type { SopKey } from '../../../../lib/sop/types';
import { SopWorkflowClient } from './sop-workflow-client';

export const dynamic = 'force-dynamic';
// SOP workflow server actions (completeStep, generateDeliverable) can
// run for tens of seconds — completing Step 7 of Brand Visibility Audit
// generates an xlsx and a ticket bundle. Default 60s is enough now;
// raise to 300s on Day 2 once the heavy builders are wired.

export default async function SopWorkflowPage({
  params,
}: {
  params: Promise<{ firmSlug: string; sopKey: string }>;
}) {
  const { firmSlug, sopKey } = await params;
  if (!(sopKey in SOP_REGISTRY)) notFound();
  const typedKey = sopKey as SopKey;

  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const detail = await getSopRunDetail(firmSlug, typedKey);

  return (
    <div>
      <Link
        href={`/dashboard/${firmSlug}/sops`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-white/55 transition-colors hover:text-white"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        Back to SOPs
      </Link>

      <div className="mb-6">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 font-[family-name:var(--font-geist-mono)] text-[10px] font-semibold uppercase tracking-widest text-white/70">
            Phase {detail.def.phase}
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] text-white/40">
            <Clock size={11} strokeWidth={2} />
            {detail.def.timeRequired}
          </span>
          {typeof detail.def.cadence === 'object' && (
            <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/55">
              Recurring · every {detail.def.cadence.intervalDays}d
            </span>
          )}
        </div>
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          {detail.def.name}
        </h1>
        <p className="mt-3 max-w-3xl text-sm text-white/65">{detail.def.purpose}</p>
      </div>

      {/* Dependency banner */}
      {detail.dependencies.length > 0 && (
        <div className="mb-5 rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-4">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-white/55">
            <BookOpen size={12} strokeWidth={2} />
            Depends on
          </div>
          <ul className="flex flex-wrap gap-2">
            {detail.dependencies.map((d) => (
              <li key={d.sopKey}>
                <Link
                  href={`/dashboard/${firmSlug}/sop/${d.sopKey}`}
                  className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-white/80 transition-colors hover:border-white/30 hover:text-white"
                >
                  {d.name}
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${
                      d.status === 'completed'
                        ? 'bg-[var(--rag-green)]/15 text-[var(--rag-green)]'
                        : d.status === 'in_progress' || d.status === 'awaiting_input'
                          ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                          : 'bg-white/10 text-white/55'
                    }`}
                  >
                    {d.status.replace('_', ' ')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <SopWorkflowClient firmSlug={firmSlug} detail={detail} />
    </div>
  );
}
