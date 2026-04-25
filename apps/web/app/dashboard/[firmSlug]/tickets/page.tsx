import { notFound } from 'next/navigation';
import {
  listRemediationTickets,
  getTicketStats,
} from '../../../actions/remediation-actions';
import {
  TICKET_SOURCES,
  TICKET_STATUSES,
  type TicketSource,
  type TicketStatus,
} from '../../../actions/remediation-constants';
import { getFirmBySlug } from '../../../actions/firm-actions';
import { TicketsClient } from './tickets-client';

export const dynamic = 'force-dynamic';

/**
 * Unified remediation queue.
 *
 * `?status=open|in_progress|closed` and `?source=audit|legacy|reddit|entity`
 * filter the list. The Admin "Open tickets" column and the sidebar badge
 * both link into `?status=open` so operators land on their work.
 */
export default async function TicketsPage({
  params,
  searchParams,
}: {
  params: Promise<{ firmSlug: string }>;
  searchParams: Promise<{ status?: string; source?: string }>;
}) {
  const { firmSlug } = await params;
  const { status, source } = await searchParams;
  const firm = await getFirmBySlug(firmSlug);
  if (!firm) notFound();

  const activeStatus: TicketStatus | null =
    status && (TICKET_STATUSES as readonly string[]).includes(status)
      ? (status as TicketStatus)
      : null;
  const activeSource: TicketSource | null =
    source && (TICKET_SOURCES as readonly string[]).includes(source)
      ? (source as TicketSource)
      : null;

  const [tickets, stats] = await Promise.all([
    listRemediationTickets(firmSlug, {
      status: activeStatus ?? undefined,
      sourceType: activeSource ?? undefined,
    }).catch(() => []),
    // Faceted: pass both filters so byStatus respects the source axis and
    // bySource respects the status axis. See `getTicketStats` for details.
    getTicketStats(firmSlug, {
      status: activeStatus ?? undefined,
      sourceType: activeSource ?? undefined,
    }).catch(() => ({
      total: 0,
      byStatus: { open: 0, in_progress: 0, closed: 0 } as Record<TicketStatus, number>,
      bySource: { audit: 0, legacy: 0, reddit: 0, entity: 0 } as Record<TicketSource, number>,
      openOverdue: 0,
    })),
  ]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
          Remediation Tickets
        </h1>
        <p className="mt-2 text-white/55">
          Every scanner writes here. Audit red rows, legacy suppression findings,
          entity gaps, and high-karma Reddit complaints surface as tickets —
          close them out as you act.
        </p>
      </div>
      <TicketsClient
        firmSlug={firmSlug}
        initialTickets={tickets}
        stats={stats}
        activeStatus={activeStatus}
        activeSource={activeSource}
      />
    </div>
  );
}
