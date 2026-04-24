import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  FileText,
  ClipboardCheck,
  MessageSquare,
  ArrowRight,
  Scale,
  Stethoscope,
  Megaphone,
  HelpCircle,
  Building2,
  Users,
} from 'lucide-react';
import {
  getFirmBySlug,
  getFirmSummary,
  type FirmType,
} from '../../actions/firm-actions';

export const dynamic = 'force-dynamic';

const FIRM_TYPE_LABEL: Record<FirmType, string> = {
  law_firm: 'Law Firm',
  dental_practice: 'Dental Practice',
  marketing_agency: 'Marketing Agency',
  other: 'Other',
};

const FIRM_TYPE_ICON: Record<FirmType, typeof Building2> = {
  law_firm: Scale,
  dental_practice: Stethoscope,
  marketing_agency: Megaphone,
  other: HelpCircle,
};

function formatDate(d: Date | null | undefined) {
  if (!d) return 'never';
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function FirmOverviewPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const summary = await getFirmSummary(firmSlug).catch(() => null);
  const Icon = FIRM_TYPE_ICON[firm.firm_type];

  return (
    <div>
      {/* Header */}
      <div className="mb-10 flex items-start gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-white/5">
          <Icon size={28} strokeWidth={1.5} className="text-[--accent]" />
        </div>
        <div className="flex-1">
          <div className="mb-2 flex items-center gap-3">
            <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
              {firm.name}
            </h1>
            <span className="rounded-full border border-white/10 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/55">
              {FIRM_TYPE_LABEL[firm.firm_type]}
            </span>
          </div>
          <p className="font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
            /{firm.slug} · added {formatDate(firm.created_at)}
          </p>
        </div>
      </div>

      {/* Headline stats */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Brand Truth"
          value={
            summary?.latestBrandTruthVersion
              ? `v${summary.latestBrandTruthVersion}`
              : 'not set'
          }
          detail={
            summary?.latestBrandTruthUpdatedAt
              ? `updated ${formatDate(summary.latestBrandTruthUpdatedAt)}`
              : 'configure to start auditing'
          }
        />
        <StatTile
          label="Last Audit"
          value={formatDate(summary?.lastAudit?.startedAt ?? null)}
          detail={summary?.lastAudit?.status ?? 'no runs yet'}
        />
        <StatTile
          label="Reddit Scan"
          value={formatDate(summary?.lastRedditScan?.startedAt ?? null)}
          detail={summary?.lastRedditScan?.status ?? 'no scans yet'}
        />
        <StatTile
          label="Reddit Mentions"
          value={String(summary?.redditMentionCount ?? 0)}
          detail="across all scans"
        />
      </div>

      {/* Module cards */}
      <h2 className="mb-4 font-[family-name:var(--font-jakarta)] text-sm font-semibold uppercase tracking-widest text-white/55">
        Modules
      </h2>
      <div className="grid gap-4 md:grid-cols-3">
        <ModuleCard
          href={`/dashboard/${firmSlug}/brand-truth`}
          icon={FileText}
          title="Brand Truth"
          description="How AI should describe this client. The source-of-truth payload every audit checks against."
          cta={
            summary?.latestBrandTruthVersion
              ? `Edit v${summary.latestBrandTruthVersion}`
              : 'Set up Brand Truth'
          }
        />
        <ModuleCard
          href={`/dashboard/${firmSlug}/audits`}
          icon={ClipboardCheck}
          title="Trust Alignment Audits"
          description="Run LLM prompts across GPT / Claude / Gemini and score how they describe this client vs Brand Truth."
          cta="Run & review audits"
        />
        <ModuleCard
          href={`/dashboard/${firmSlug}/reddit`}
          icon={MessageSquare}
          title="Reddit Sentiment"
          description="What Redditors say about this client, and what prospects are asking. High-weight LLM citation source."
          cta="Scan & review mentions"
        />
        <ModuleCard
          href={`/dashboard/${firmSlug}/competitors`}
          icon={Users}
          title="Competitors"
          description="Track rival firms across audits — share-of-mention, praise asymmetry, and whose websites the LLMs cite instead of ours."
          cta="Manage roster"
        />
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
      <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
        {label}
      </div>
      <div className="mt-2 font-[family-name:var(--font-jakarta)] text-xl font-bold text-white">
        {value}
      </div>
      <div className="mt-1 text-xs text-white/40">{detail}</div>
    </div>
  );
}

function ModuleCard({
  href,
  icon: Icon,
  title,
  description,
  cta,
}: {
  href: string;
  icon: typeof FileText;
  title: string;
  description: string;
  cta: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-3 rounded-xl border border-white/10 bg-[--bg-secondary] p-6 transition-colors hover:border-[--accent]/30"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/5">
        <Icon size={20} strokeWidth={1.5} className="text-[--accent]" />
      </div>
      <h3 className="font-[family-name:var(--font-jakarta)] text-lg font-bold text-white">
        {title}
      </h3>
      <p className="flex-1 text-sm text-white/55">{description}</p>
      <div className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-[--accent] transition-transform group-hover:translate-x-0.5">
        {cta}
        <ArrowRight size={14} strokeWidth={2} />
      </div>
    </Link>
  );
}
