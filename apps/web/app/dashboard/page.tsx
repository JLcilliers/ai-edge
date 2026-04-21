import Link from 'next/link';
import Image from 'next/image';
import { Plus, Building2, Scale, Stethoscope, Megaphone, HelpCircle } from 'lucide-react';
import { listFirms, getFirmSummary, type FirmType } from '../actions/firm-actions';
import { getOpenTicketCount } from '../actions/remediation-actions';

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

export default async function ClientListPage() {
  const firms = await listFirms();
  const summaries = await Promise.all(
    firms.map(async (f) => {
      const [summary, openTicketCount] = await Promise.all([
        getFirmSummary(f.slug).catch(() => null),
        getOpenTicketCount(f.slug).catch(() => 0),
      ]);
      return { firm: f, summary, openTicketCount };
    }),
  );

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      {/* Header */}
      <div className="mb-10 flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Image
            src="/clixsy-logo.svg"
            alt="Clixsy"
            width={120}
            height={32}
            className="brightness-0 invert"
          />
          <span className="border-l border-white/10 pl-4 font-[family-name:var(--font-inter)] text-[10px] font-medium uppercase tracking-[0.3em] text-white/55">
            Intercept
          </span>
        </div>
        <Link
          href="/dashboard/new-client"
          className="inline-flex items-center gap-2 rounded-full bg-[--accent] px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[--accent-hover]"
        >
          <Plus size={16} strokeWidth={2} />
          Add Client
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Clients
        </h1>
        <p className="mt-2 text-white/55">
          Pick a client to run audits, edit Brand Truth, or check Reddit sentiment.
        </p>
      </div>

      {/* Empty state */}
      {firms.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-[--bg-secondary] py-20 text-center">
          <Building2 className="mb-4 h-12 w-12 text-white/20" strokeWidth={1.5} />
          <h2 className="mb-2 text-lg font-semibold text-white/60">No clients yet</h2>
          <p className="mb-6 max-w-md text-sm text-white/40">
            Add your first client to start monitoring their AI search visibility
            and brand alignment.
          </p>
          <Link
            href="/dashboard/new-client"
            className="inline-flex items-center gap-2 rounded-full bg-[--accent] px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-[--accent-hover]"
          >
            <Plus size={16} strokeWidth={2} />
            Add Your First Client
          </Link>
        </div>
      )}

      {/* Client cards */}
      {firms.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {summaries.map(({ firm, summary, openTicketCount }) => {
            const Icon = FIRM_TYPE_ICON[firm.firm_type];
            return (
              <Link
                key={firm.id}
                href={`/dashboard/${firm.slug}`}
                className="group flex flex-col gap-4 rounded-xl border border-white/10 bg-[--bg-secondary] p-6 transition-colors hover:border-[--accent]/30"
              >
                <div className="flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/5">
                    <Icon size={20} strokeWidth={1.5} className="text-[--accent]" />
                  </div>
                  <span className="rounded-full border border-white/10 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/55">
                    {FIRM_TYPE_LABEL[firm.firm_type]}
                  </span>
                </div>

                <div>
                  <h2 className="font-[family-name:var(--font-jakarta)] text-lg font-bold text-white group-hover:text-[--accent]">
                    {firm.name}
                  </h2>
                  <p className="mt-1 font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
                    /{firm.slug}
                  </p>
                </div>

                <div className="mt-auto grid grid-cols-2 gap-3 border-t border-white/5 pt-4 text-xs">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-white/40">
                      Brand Truth
                    </div>
                    <div className="mt-0.5 text-white/70">
                      {summary?.latestBrandTruthVersion
                        ? `v${summary.latestBrandTruthVersion}`
                        : 'not set'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-white/40">
                      Last Audit
                    </div>
                    <div className="mt-0.5 text-white/70">
                      {summary?.lastAudit?.startedAt
                        ? new Date(summary.lastAudit.startedAt).toLocaleDateString(
                            'en-US',
                            { month: 'short', day: 'numeric' },
                          )
                        : 'never'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-white/40">
                      Reddit Scan
                    </div>
                    <div className="mt-0.5 text-white/70">
                      {summary?.lastRedditScan?.startedAt
                        ? new Date(
                            summary.lastRedditScan.startedAt,
                          ).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                          })
                        : 'never'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-white/40">
                      Open Tickets
                    </div>
                    <div
                      className={`mt-0.5 ${
                        openTicketCount > 0 ? 'text-[--rag-red]' : 'text-white/70'
                      }`}
                    >
                      {openTicketCount}
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
