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
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Brand Truth
        </h1>
        <p className="mt-2 text-white/55">
          Define how AI should describe your brand
        </p>
        <p className="mt-1 text-xs font-[family-name:var(--font-geist-mono)] text-white/40">
          Version {currentVersion || 'unsaved'}
        </p>
      </div>
      <BrandTruthEditor
        initialPayload={initialPayload}
        currentVersion={currentVersion}
        versions={versions}
      />
    </div>
  );
}
