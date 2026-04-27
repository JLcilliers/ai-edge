import { notFound } from 'next/navigation';
import {
  getEntityHealth,
  getLatestEntityRun,
  getCrossSourceHealth,
} from '../../../actions/entity-actions';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { EntityClient } from './entity-client';

export const dynamic = 'force-dynamic';

export default async function EntityPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const [health, latestRun, crossSource] = await Promise.all([
    getEntityHealth(firmSlug).catch(() => null),
    getLatestEntityRun(firmSlug).catch(() => null),
    getCrossSourceHealth(firmSlug).catch(() => []),
  ]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Entity & Structured Signals
        </h1>
        <p className="mt-2 text-white/55">
          Schema.org coverage on {firm.name}&apos;s home page, plus Wikidata and
          Google Knowledge Graph presence. Missing structured signals are the
          #1 reason LLMs hallucinate about small firms.
        </p>
      </div>
      <EntityClient
        firmSlug={firmSlug}
        initialHealth={health}
        initialLatestRun={latestRun}
        initialCrossSource={crossSource}
      />
    </div>
  );
}
