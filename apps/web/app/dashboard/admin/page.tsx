import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, Shield } from 'lucide-react';
import { getAdminDashboardBundle } from '../../actions/admin-actions';
import { AdminClient } from './admin-client';

export const dynamic = 'force-dynamic';

/**
 * Workspace admin observability cockpit.
 *
 * Three surfaces, top → bottom by severity of what goes wrong if it
 * breaks:
 *   1. Cron health — if a cron stalls, the operator needs to know
 *      first. Weekly/daily audits, reddit poll, citation diff, monthly
 *      reports all live here.
 *   2. Firm health snapshot — per-firm triage: latest audit, error
 *      streak, open mentions, BT version, monthly-report coverage,
 *      budget utilisation. Click a row → jump to that firm's dashboard.
 *   3. Workspace spend — MTD totals + 12-month trend across every firm.
 *
 * This page intentionally has no auth gate — per the internal-tool
 * directive, the whole workspace is open to anyone who can reach it.
 * Firm-scoped pages live under `/dashboard/[firmSlug]`; this one
 * deliberately sits above the `[firmSlug]` layout so it doesn't
 * inherit the firm sidebar.
 */
export default async function AdminPage() {
  const bundle = await getAdminDashboardBundle();

  return (
    <div className="mx-auto max-w-7xl px-8 py-10">
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
            Admin
          </span>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[var(--bg-secondary)] px-4 py-2 text-xs font-medium text-white/70 transition-colors hover:border-white/20 hover:text-white"
        >
          <ArrowLeft size={14} strokeWidth={1.5} />
          Back to clients
        </Link>
      </div>

      <div className="mb-8 flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/5">
          <Shield size={24} strokeWidth={1.5} className="text-[var(--accent)]" />
        </div>
        <div>
          <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
            Workspace Admin
          </h1>
          <p className="mt-2 text-white/55">
            Cron health, per-firm triage, and workspace-wide spend. Read-only —
            firm edits happen on each firm's Settings page.
          </p>
        </div>
      </div>

      <AdminClient bundle={bundle} />
    </div>
  );
}
