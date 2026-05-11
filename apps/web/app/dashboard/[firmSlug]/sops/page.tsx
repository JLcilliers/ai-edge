import { redirect } from 'next/navigation';

/**
 * Legacy route — the old "all SOPs" umbrella page. The 7 phase tabs in
 * the sidebar replaced it; this redirect catches stale bookmarks and
 * dashboard links that haven't been updated yet, dropping the operator
 * into the first phase (Brand Audit & Analysis).
 */
export default async function LegacyAllSopsPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  redirect(`/dashboard/${firmSlug}/brand-audit-analysis`);
}
