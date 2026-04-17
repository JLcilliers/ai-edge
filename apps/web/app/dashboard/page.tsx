import Link from 'next/link';
import { FileText, BarChart3 } from 'lucide-react';

export default function DashboardPage() {
  return (
    <div>
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Overview
        </h1>
        <p className="mt-2 text-white/55">
          Clixsy Intercept — AI search visibility at a glance
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/dashboard/brand-truth"
          className="group rounded-xl border border-white/10 bg-[--bg-secondary] p-6 transition-colors hover:border-[--accent]/30"
        >
          <FileText size={24} strokeWidth={1.5} className="text-[--accent] mb-3" />
          <h2 className="font-[family-name:var(--font-jakarta)] text-lg font-bold text-white">Brand Truth</h2>
          <p className="mt-1 text-sm text-white/55">
            Define how AI should describe your brand.
          </p>
        </Link>

        <Link
          href="/dashboard/audits"
          className="group rounded-xl border border-white/10 bg-[--bg-secondary] p-6 transition-colors hover:border-[--accent]/30"
        >
          <BarChart3 size={24} strokeWidth={1.5} className="text-[--accent] mb-3" />
          <h2 className="font-[family-name:var(--font-jakarta)] text-lg font-bold text-white">Trust Alignment Audits</h2>
          <p className="mt-1 text-sm text-white/55">
            How LLMs actually describe you vs how you want to be described.
          </p>
        </Link>
      </div>
    </div>
  );
}
