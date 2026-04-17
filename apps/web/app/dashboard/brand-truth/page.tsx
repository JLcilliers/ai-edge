import { getLatestBrandTruth, getBrandTruthVersions } from '../../actions/brand-truth-actions';
import { BrandTruthEditor } from './editor';
import { CLIXSY_SEED } from './seed-data';

// Force dynamic — this page hits the DB at render time
export const dynamic = 'force-dynamic';

export default async function BrandTruthPage() {
  const [latest, versions] = await Promise.all([
    getLatestBrandTruth(),
    getBrandTruthVersions(),
  ]);

  const initialPayload = latest?.payload ?? CLIXSY_SEED;
  const currentVersion = latest?.version ?? 0;

  return (
    <div>
      <h1 className="text-2xl font-semibold">Brand Truth Editor</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Version {currentVersion || 'unsaved'} — edit fields and save to create a new version.
      </p>
      <BrandTruthEditor
        initialPayload={initialPayload}
        currentVersion={currentVersion}
        versions={versions}
      />
    </div>
  );
}
