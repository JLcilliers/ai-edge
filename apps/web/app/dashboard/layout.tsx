// Root dashboard layout: just the topo background + page shell.
// The firm-scoped sidebar lives in /dashboard/[firmSlug]/layout.tsx so the
// client-list page at /dashboard renders without a sidebar.
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className="min-h-screen bg-[var(--bg-primary)]"
      style={{
        backgroundImage: "url('/topo-pattern.svg')",
        backgroundRepeat: 'repeat',
      }}
    >
      {children}
    </div>
  );
}
