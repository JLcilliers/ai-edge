'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, FileText, ClipboardCheck, MessageSquare, Users, FileX, Database, FileBarChart, Eye, Settings, Inbox, ScanSearch, Activity, PenSquare, Globe2, Wrench, Sparkles, Briefcase } from 'lucide-react';

type NavItem = {
  label: string;
  href: (slug: string) => string;
  icon: typeof LayoutDashboard;
  // Match mode: "exact" only matches the exact href; "prefix" matches the href or any child path.
  match: 'exact' | 'prefix';
  // Numeric badge source. The sidebar maps each badge kind to a data
  // source the parent layout fetched (Action Items total, per-phase
  // count). Nav items without a badge field render bare.
  badge?:
    | { kind: 'openTicketCount' }
    | { kind: 'phaseTicketCount'; phase: number };
};

// Order: Action Items first so the operator's "what do I need to do?"
// surface is the most accessible entry, then Overview + Brand Truth as
// firm-scoped context surfaces, then the 7 phase tabs with inline
// task counts, then operator-facing data views, then settings.
const ITEMS: NavItem[] = [
  // ── Top: the task list. Everything the operator does flows from here. ──
  {
    label: 'Action Items',
    href: (slug) => `/dashboard/${slug}/tickets`,
    icon: Inbox,
    match: 'prefix',
    badge: { kind: 'openTicketCount' },
  },
  {
    label: 'Overview',
    href: (slug) => `/dashboard/${slug}`,
    icon: LayoutDashboard,
    match: 'exact',
  },
  // Brand Truth — canonical positioning payload every workflow reads from.
  {
    label: 'Brand Truth',
    href: (slug) => `/dashboard/${slug}/brand-truth`,
    icon: FileText,
    match: 'prefix',
  },

  // ── The Steve Toth playbook, surfaced as 7 ordered phase tabs ──
  // Each tab is one phase of the AEO program. The label IS the phase
  // name — no "Phase 1" / "Phase 2" prefixes, no umbrella "SOPs" tab.
  // Order matters: top → bottom mirrors the program sequence the
  // operator runs through. Each phase carries an inline count badge
  // showing open tickets in that phase — surfaces empty phases at a
  // glance instead of requiring a click to discover them.
  {
    label: 'Brand Audit & Analysis',
    href: (slug) => `/dashboard/${slug}/brand-audit-analysis`,
    icon: ScanSearch,
    match: 'prefix',
    badge: { kind: 'phaseTicketCount', phase: 1 },
  },
  {
    label: 'Measurement & Monitoring',
    href: (slug) => `/dashboard/${slug}/measurement-monitoring`,
    icon: Activity,
    match: 'prefix',
    badge: { kind: 'phaseTicketCount', phase: 2 },
  },
  {
    label: 'Content Optimization',
    href: (slug) => `/dashboard/${slug}/content-optimization`,
    icon: PenSquare,
    match: 'prefix',
    badge: { kind: 'phaseTicketCount', phase: 3 },
  },
  {
    label: 'Third-Party Optimization',
    href: (slug) => `/dashboard/${slug}/third-party-optimization`,
    icon: Globe2,
    match: 'prefix',
    badge: { kind: 'phaseTicketCount', phase: 4 },
  },
  {
    label: 'Technical Implementation',
    href: (slug) => `/dashboard/${slug}/technical-implementation`,
    icon: Wrench,
    match: 'prefix',
    badge: { kind: 'phaseTicketCount', phase: 5 },
  },
  {
    label: 'Content Generation',
    href: (slug) => `/dashboard/${slug}/content-generation`,
    icon: Sparkles,
    match: 'prefix',
    badge: { kind: 'phaseTicketCount', phase: 6 },
  },
  {
    label: 'Client Services',
    href: (slug) => `/dashboard/${slug}/client-services`,
    icon: Briefcase,
    match: 'prefix',
    badge: { kind: 'phaseTicketCount', phase: 7 },
  },

  // ── Legacy data views — backing surfaces for the SOP workflows
  // (each one is the data layer for one or more phase steps). Kept
  // top-level for quick operator access; the workflows also drill
  // into them in-context. ──
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
    label: 'Reports',
    href: (slug) => `/dashboard/${slug}/reports`,
    icon: FileBarChart,
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
  openTicketCountsByPhase = {},
}: {
  firmSlug: string;
  openTicketCount?: number;
  openTicketCountsByPhase?: Record<number, number>;
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

        // Resolve the badge value.
        let badgeValue: number | null = null;
        if (item.badge) {
          if (item.badge.kind === 'openTicketCount' && openTicketCount > 0) {
            badgeValue = openTicketCount;
          } else if (item.badge.kind === 'phaseTicketCount') {
            const n = openTicketCountsByPhase[item.badge.phase] ?? 0;
            if (n > 0) badgeValue = n;
          }
        }

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
