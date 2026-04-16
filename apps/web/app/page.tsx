export default function Home() {
  return (
    <main className="p-8 max-w-2xl">
      <h1 className="text-3xl font-semibold">AI Edge</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Phase 0 scaffold. Brand Truth editor and Trust Alignment dashboard
        arrive once Clerk + Neon credentials are pulled via{' '}
        <code className="font-mono text-xs">vercel env pull .env.local</code>.
      </p>
    </main>
  );
}
