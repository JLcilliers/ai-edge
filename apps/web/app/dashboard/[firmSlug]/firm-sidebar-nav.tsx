'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, FileText, ClipboardCheck, MessageSquare, Users, FileX, Database, ShieldCheck, FileBarChart, Eye, Settings, Inbox, FlaskConical } from 'lucide-react';

type NavItem = {
  label: string;
  href: (slug: string) => string;
  icon: typeof LayoutDashboard;
  // Match mode: "exact" only matches the exact href; "prefix" matches the href or any child path.
  match: 'exact' | 'prefix';
  // Optional numeric badge key (sidebar-owned, not per-item flag). The nav
  // decides how to render it from the label.
  badge?: 'openTicketCount';
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
    label: 'Visibility',
    href: (slug) => `/dashboard/${slug}/visibility`,
    icon: Eye,
    match: 'prefix',
  },
  {
    label: 'Reddit',
    href: (slug) => `/dashboard/${slug}/reddit`,
    icon: MessageSquare,
    match: 'prefix',
  },
  {
    label: 'Tickets',
    href: (slug) => `/dashboard/${slug}/tickets`,
    icon: Inbox,
    match: 'prefix',
    badge: 'openTicketCount',
  },
  {
    label: 'Competitors',
    href: (slug) => `/dashboard/${slug}/competitors`,
    icon: Users,
    match: 'prefix',
  },
  {
    label: 'Suppression',
    href: (slug) => `/dashboard/${slug}/suppression`,
    icon: FileX,
    match: 'prefix',
  },
  {
    label: 'Entity',
    href: (slug) => `/dashboard/${slug}/entity`,
    icon: Database,
    match: 'prefix',
  },
  {
    label: 'Compliance',
    href: (slug) => `/dashboard/${slug}/compliance`,
    icon: ShieldCheck,
    match: 'prefix',
  },
  {
    label: 'Reports',
    href: (slug) => `/dashboard/${slug}/reports`,
    icon: FileBarChart,
    match: 'prefix',
  },
  {
    label: 'Scenario Lab',
    href: (slug) => `/dashboard/${slug}/scenarios`,
    icon: FlaskConical,
    match: 'prefix',
  },
  {
    label: 'Settings',
    href: (slug) => `/dashboard/${slug}/settings`,
    icon: Settings,
    match: 'prefix',
  },
];

export function FirmSidebarNav({
  firmSlug,
  openTicketCount = 0,
}: {
  firmSlug: string;
  openTicketCount?: number;
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
        const badgeValue =
          item.badge === 'openTicketCount' && openTicketCount > 0
            ? openTicketCount
            : null;
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
            <span className="flex-1">{item.label}</span>
            {badgeValue !== null && (
              <span
                className={`rounded-full px-2 py-0.5 font-[family-name:var(--font-geist-mono)] text-[10px] font-semibold ${
                  active
                    ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                    : 'bg-[var(--accent)]/15 text-[var(--accent)]/90'
                }`}
              >
                {badgeValue > 99 ? '99+' : badgeValue}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
