import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect('/dashboard');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold tracking-tight">AI Edge</h1>
      <p className="max-w-md text-center text-neutral-400">
        Trust Alignment for the AI search era. Close the gap between how you
        position your firm and how LLMs describe it.
      </p>
      <Link
        href="/sign-in"
        className="rounded-lg bg-white px-6 py-2.5 text-sm font-medium text-neutral-950 transition hover:bg-neutral-200"
      >
        Sign In
      </Link>
    </main>
  );
}
