import { UserButton } from '@clerk/nextjs';
import Link from 'next/link';

const navItems = [
  { href: '/dashboard' as const, label: 'Overview' },
  { href: '/dashboard/brand-truth' as const, label: 'Brand Truth' },
  { href: '/dashboard/audits' as const, label: 'Audits' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 border-r border-neutral-800 bg-neutral-900 p-6">
        <Link href="/dashboard" className="mb-8 block text-xl font-semibold tracking-tight">
          AI Edge
        </Link>
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center justify-end border-b border-neutral-800 px-6">
          <UserButton afterSignOutUrl="/" />
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
