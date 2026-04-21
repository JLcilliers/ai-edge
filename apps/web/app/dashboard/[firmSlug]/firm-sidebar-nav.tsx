'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  FileText,
  ClipboardCheck,
  MessageSquare,
  Wrench,
} from 'lucide-react';

type NavKey = 'overview' | 'brand-truth' | 'audits' | 'reddit' | 'remediation';

type NavItem = {
  key: NavKey;
  label: string;
  href: (slug: string) => string;
  icon: typeof LayoutDashboard;
  // Match mode: "exact" only matches the exact href; "prefix" matches the href or any child path.
  match: 'exact' | 'prefix';
};

const ITEMS: NavItem[] = [
  {
    key: 'overview',
    label: 'Overview',
    href: (slug) => `/dashboard/${slug}`,
    icon: LayoutDashboard,
    match: 'exact',
  },
  {
    key: 'brand-truth',
    label: 'Brand Truth',
    href: (slug) => `/dashboard/${slug}/brand-truth`,
    icon: FileText,
    match: 'prefix',
  },
  {
    key: 'audits',
    label: 'Audits',
    href: (slug) => `/dashboard/${slug}/audits`,
    icon: ClipboardCheck,
    match: 'prefix',
  },
  {
    key: 'reddit',
    label: 'Reddit',
    href: (slug) => `/dashboard/${slug}/reddit`,
    icon: MessageSquare,
    match: 'prefix',
  },
  {
    key: 'remediation',
    label: 'Remediation',
    href: (slug) => `/dashboard/${slug}/remediation`,
    icon: Wrench,
    match: 'prefix',
  },
];

export function FirmSidebarNav({
  firmSlug,
  openTicketCount,
}: {
  firmSlug: string;
  openTicketCount: number;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {ITEMS.map((item) => {
        const href = item.href(firmSlug);
        const active =
          item.match === 'exact'
            ? pathname === href
            : pathname === href || pathname.startsWith(`${href}/`);
        const Icon = item.icon;
        const showBadge = item.key === 'remediation' && openTicketCount > 0;
        return (
          <Link
            key={item.key}
            href={href}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
              active
                ? 'bg-white/10 text-white'
                : 'text-white/55 hover:bg-white/5 hover:text-white/80'
            }`}
          >
            <Icon size={16} strokeWidth={1.5} />
            <span className="flex-1">{item.label}</span>
            {showBadge && (
              <span className="rounded-full bg-[--rag-red] px-2 py-0.5 text-[10px] font-bold text-black">
                {openTicketCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
