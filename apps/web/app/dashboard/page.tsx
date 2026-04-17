import Link from 'next/link';

export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Clixsy Intercept — Trust Alignment for the AI search era.
      </p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/dashboard/brand-truth"
          className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 transition hover:border-neutral-700"
        >
          <h2 className="font-medium">Brand Truth</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Edit your firm&apos;s brand identity and positioning.
          </p>
        </Link>
        <Link
          href="/dashboard/audits"
          className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 transition hover:border-neutral-700"
        >
          <h2 className="font-medium">Trust Alignment Audits</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Run and review LLM alignment audits.
          </p>
        </Link>
      </div>
    </div>
  );
}
