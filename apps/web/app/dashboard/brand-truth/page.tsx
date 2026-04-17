import { getLatestBrandTruth, getBrandTruthVersions } from '../../actions/brand-truth-actions';
import { BrandTruthEditor } from './editor';
import { CLIXSY_SEED } from './seed-data';

export default async function BrandTruthPage() {
  const [latest, versions] = await Promise.all([
    getLatestBrandTruth(),
    getBrandTruthVersions(),
  ]);

  const initialPayload = latest?.payload ?? CLIXSY_SEED;
  const currentVersion = latest?.version ?? 0;

  return (
    <div className="flex gap-6">
      {/* Main editor */}
      <div className="flex-1">
        <h1 className="text-2xl font-semibold">Brand Truth Editor</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Version {currentVersion || 'unsaved'} — edit fields and save to create a new version.
        </p>
        <BrandTruthEditor
          initialPayload={initialPayload}
          currentVersion={currentVersion}
        />
      </div>

      {/* Version history sidebar */}
      <aside className="w-64 shrink-0">
        <h2 className="text-sm font-medium text-neutral-400">Version History</h2>
        <div className="mt-3 flex flex-col gap-1">
          {versions.length === 0 ? (
            <p className="text-xs text-neutral-600">No versions saved yet.</p>
          ) : (
            versions.map((v) => (
              <div
                key={v.id}
                className={`rounded-md border px-3 py-2 text-xs ${
                  v.version === currentVersion
                    ? 'border-blue-600 bg-blue-950/30 text-blue-300'
                    : 'border-neutral-800 text-neutral-500'
                }`}
              >
                <span className="font-medium">v{v.version}</span>
                <span className="ml-2">
                  {v.createdAt.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}
