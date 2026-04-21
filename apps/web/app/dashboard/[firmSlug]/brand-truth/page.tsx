import { notFound } from 'next/navigation';
import {
  getLatestBrandTruth,
  getBrandTruthVersions,
} from '../../../actions/brand-truth-actions';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { BrandTruthEditor } from './editor';
import { emptySeed } from './seed-data';

// Force dynamic — this page hits the DB at render time
export const dynamic = 'force-dynamic';

export default async function BrandTruthPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const [latest, versions] = await Promise.all([
    getLatestBrandTruth(firmSlug),
    getBrandTruthVersions(firmSlug),
  ]);

  const initialPayload =
    latest?.payload ?? emptySeed({ name: firm.name, firm_type: firm.firm_type });
  const currentVersion = latest?.version ?? 0;

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Brand Truth
        </h1>
        <p className="mt-2 text-white/55">
          Define how AI should describe {firm.name}
        </p>
        <p className="mt-1 text-xs font-[family-name:var(--font-geist-mono)] text-white/40">
          Version {currentVersion || 'unsaved'}
        </p>
      </div>
      <BrandTruthEditor
        firmSlug={firmSlug}
        initialPayload={initialPayload}
        currentVersion={currentVersion}
        versions={versions}
      />
    </div>
  );
}
