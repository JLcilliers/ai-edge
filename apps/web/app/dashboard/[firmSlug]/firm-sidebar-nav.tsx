'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, FileText, ClipboardCheck, MessageSquare } from 'lucide-react';

type NavItem = {
  label: string;
  href: (slug: string) => string;
  icon: typeof LayoutDashboard;
  // Match mode: "exact" only matches the exact href; "prefix" matches the href or any child path.
  match: 'exact' | 'prefix';
};

const ITEMS: NavItem[] = [
  {
    label: 'Overview',
    href: (slug) => `/dashboard/${slug}`,
    icon: LayoutDashboard,
    match: 'exact',
  },
  {
    label: 'Brand Truth',
    href: (slug) => `/dashboard/${slug}/brand-truth`,
    icon: FileText,
    match: 'prefix',
  },
  {
    label: 'Audits',
    href: (slug) => `/dashboard/${slug}/audits`,
    icon: ClipboardCheck,
    match: 'prefix',
  },
  {
    label: 'Reddit',
    href: (slug) => `/dashboard/${slug}/reddit`,
    icon: MessageSquare,
    match: 'prefix',
  },
];

export function FirmSidebarNav({ firmSlug }: { firmSlug: string }) {
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
        return (
          <Link
            key={item.label}
            href={href}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
              active
                ? 'bg-white/10 text-white'
                : 'text-white/55 hover:bg-white/5 hover:text-white/80'
            }`}
          >
            <Icon size={16} strokeWidth={1.5} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
