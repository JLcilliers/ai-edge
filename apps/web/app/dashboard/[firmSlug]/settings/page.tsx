import { notFound } from 'next/navigation';
import { Settings } from 'lucide-react';
import { getFirmSettings } from '../../../actions/settings-actions';
import { SettingsClient } from './settings-client';

export const dynamic = 'force-dynamic';

/**
 * Firm Settings — the operator's control surface for a single firm.
 *
 * Three sections, top to bottom, ordered by frequency of use:
 *   1. Budget — set monthly cap + optional note. Most-used section because
 *      a firm graduating from pilot to paid usually ships with a cap bump.
 *   2. Cost Telemetry — MTD breakdown + 12-month trend. Purely read-only.
 *   3. Firm Metadata — display name + firm type. Slug is immutable (changing
 *      it would break bookmarks, cron references, and outbound links).
 *   4. Danger Zone — delete firm with typed-name confirmation. Cascades
 *      wipe every table that references firm_id.
 *
 * The page is `force-dynamic` because budget + spend change every audit
 * run; caching would show a stale picture after the first request.
 */
export default async function SettingsPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const bundle = await getFirmSettings(firmSlug);
  if (!bundle) notFound();

  return (
    <div>
      <div className="mb-8 flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/5">
          <Settings size={24} strokeWidth={1.5} className="text-[--accent]" />
        </div>
        <div>
          <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
            Firm Settings
          </h1>
          <p className="mt-2 text-white/55">
            Monthly LLM spend cap, audit + rewrite cost telemetry, and
            firm-level metadata. All changes take effect immediately — cron
            schedulers re-read the budget before every run.
          </p>
        </div>
      </div>

      <SettingsClient firmSlug={firmSlug} initialBundle={bundle} />
    </div>
  );
}
