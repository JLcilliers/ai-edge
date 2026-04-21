import Link from 'next/link';
import Image from 'next/image';
import { LayoutDashboard, FileText, BarChart3, MessageSquare, AlertTriangle } from 'lucide-react';

const navItems = [
  { href: '/dashboard' as const, label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/brand-truth' as const, label: 'Brand Truth', icon: FileText },
  { href: '/dashboard/audits' as const, label: 'Audits', icon: BarChart3 },
  { href: '/dashboard/reddit' as const, label: 'Reddit', icon: MessageSquare },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-white/10 bg-[--bg-secondary]">
        {/* Logo lockup */}
        <div className="px-6 pt-6 pb-8">
          <Link href="/dashboard" className="block">
            <Image src="/clixsy-logo.svg" alt="Clixsy" width={120} height={32} className="brightness-0 invert" />
            <span className="mt-1 block font-[family-name:var(--font-inter)] text-[10px] font-medium uppercase tracking-[0.3em] text-white/55">
              Intercept
            </span>
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex flex-1 flex-col gap-0.5 px-3">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-white/55 transition-colors hover:bg-white/5 hover:text-white"
              >
                <Icon size={18} strokeWidth={1.5} />
                {item.label}
              </Link>
            );
          })}
          {/* Future: Remediation (disabled) */}
          <span className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-white/25">
            <AlertTriangle size={18} strokeWidth={1.5} />
            Remediation
          </span>
        </nav>

        {/* Footer */}
        <div className="border-t border-white/5 px-6 py-4">
          <span className="text-[10px] uppercase tracking-[0.15em] text-white/30">
            Powered by Clixsy
          </span>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col bg-[--bg-primary]" style={{ backgroundImage: "url('/topo-pattern.svg')", backgroundRepeat: 'repeat' }}>
        <main className="flex-1 px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
