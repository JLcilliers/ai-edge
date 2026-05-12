import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft } from 'lucide-react';
import { listFirms, getFirmBySlug } from '../../actions/firm-actions';
import { getOpenTicketCount } from '../../actions/remediation-actions';
import { FirmSwitcher } from './firm-switcher';
import { FirmSidebarNav } from './firm-sidebar-nav';

export const dynamic = 'force-dynamic';

export default async function FirmScopedLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const [current, firms, openTicketCount] = await Promise.all([
    getFirmBySlug(firmSlug),
    listFirms(),
    // getOpenTicketCount swallows errors internally so a DB hiccup can't
    // crash the layout — it just renders as "no badge".
    getOpenTicketCount(firmSlug),
  ]);
  if (!current) notFound();

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="flex w-64 shrink-0 flex-col gap-6 border-r border-white/5 bg-black/20 px-5 py-6 backdrop-blur-sm">
        {/* Top: logo + back-to-clients */}
        <div>
          {/* Logo → always links back to the all-clients dashboard.
              Acts as the universal "home" button across every workflow
              + data view. */}
          <Link
            href="/dashboard"
            className="mb-4 inline-flex items-center transition-opacity hover:opacity-80"
            aria-label="Back to all clients dashboard"
          >
            <Image
              src="/clixsy-logo.svg"
              alt="Clixsy"
              width={180}
              height={75}
              priority
            />
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-xs text-white/40 transition-colors hover:text-white/70"
          >
            <ArrowLeft size={12} strokeWidth={2} />
            All Clients
          </Link>
        </div>

        {/* Firm switcher */}
        <FirmSwitcher current={current} firms={firms} />

        {/* Nav */}
        <FirmSidebarNav firmSlug={firmSlug} openTicketCount={openTicketCount} />
      </aside>

      {/* Main content */}
      <main className="flex-1 px-10 py-10">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
