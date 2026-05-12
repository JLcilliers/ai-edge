import { PhasePageShell } from '../_phase/phase-page-shell';
import { ExportToolbar } from '../_exports/export-toolbar';

export const dynamic = 'force-dynamic';

/**
 * Phase 7 (Client Services) page. The phase shell renders the weekly
 * AEO Reporting scanner output. The export toolbar above it surfaces
 * the .xlsx tickets export + the AEO Audit Delivery deck export so
 * operators have the two client-facing deliverables one click away.
 */
export default async function ClientServicesPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  return (
    <div>
      <div className="mb-6">
        <ExportToolbar firmSlug={firmSlug} />
      </div>
      <PhasePageShell firmSlug={firmSlug} phaseKey="client-services" />
    </div>
  );
}
