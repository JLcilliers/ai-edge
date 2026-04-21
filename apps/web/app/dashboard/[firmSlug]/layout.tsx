import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft } from 'lucide-react';
import { listFirms, getFirmBySlug } from '../../actions/firm-actions';
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
  const [current, firms] = await Promise.all([
    getFirmBySlug(firmSlug),
    listFirms(),
  ]);
  if (!current) notFound();

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="flex w-64 shrink-0 flex-col gap-6 border-r border-white/5 bg-black/20 px-5 py-6 backdrop-blur-sm">
        {/* Top: logo + back-to-clients */}
        <div>
          <div className="mb-4 flex items-center gap-3">
            <Image
              src="/clixsy-logo.svg"
              alt="Clixsy"
              width={92}
              height={24}
              className="brightness-0 invert"
            />
            <span className="border-l border-white/10 pl-3 font-[family-name:var(--font-inter)] text-[9px] font-medium uppercase tracking-[0.3em] text-white/55">
              Intercept
            </span>
          </div>
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
        <FirmSidebarNav firmSlug={firmSlug} />
      </aside>

      {/* Main content */}
      <main className="flex-1 px-10 py-10">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
