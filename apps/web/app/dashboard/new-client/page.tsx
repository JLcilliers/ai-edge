import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { NewClientForm } from './new-client-form';

export const dynamic = 'force-dynamic';

export default function NewClientPage() {
  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      <Link
        href="/dashboard"
        className="mb-6 inline-flex items-center gap-1.5 text-xs text-white/40 transition-colors hover:text-white/70"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        Back to clients
      </Link>

      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Add Client
        </h1>
        <p className="mt-2 text-white/55">
          Create a workspace for a new client. Brand Truth comes next.
        </p>
      </div>

      <div className="rounded-2xl border border-white/10 bg-[--bg-secondary] p-8">
        <NewClientForm />
      </div>
    </div>
  );
}
