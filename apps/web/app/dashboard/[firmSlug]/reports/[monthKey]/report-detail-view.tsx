import {
  Activity,
  MessageSquare,
  Users,
  FileX,
  Database,
  DollarSign,
  ExternalLink,
} from 'lucide-react';
import type { MonthlyReportPayload } from '../../../../lib/reports/build-monthly-report';

/**
 * Pure presentation of a `MonthlyReportPayload`. No interactivity,
 * so this is a server component — renders once at request time.
 */
export function ReportDetailView({ payload }: { payload: MonthlyReportPayload }) {
  return (
    <div className="flex flex-col gap-6">
      <AuditsSection payload={payload} />
      <RedditSection payload={payload} />
      <CompetitiveSection payload={payload} />
      <SuppressionSection payload={payload} />
      <EntitySection payload={payload} />
      <CostSection payload={payload} />
    </div>
  );
}

// ── Audits ───────────────────────────────────────────────────

function AuditsSection({ payload }: { payload: MonthlyReportPayload }) {
  const { audits } = payload;
  const ragTotal =
    audits.rag_totals.red + audits.rag_totals.yellow + audits.rag_totals.green;

  return (
    <Section icon={Activity} title="Audits" count={audits.total}>
      <div className="grid gap-3 sm:grid-cols-4">
        <Tile label="Total runs" value={audits.total} />
        <Tile
          label="Mention rate"
          value={`${Math.round(audits.mention_rate * 100)}%`}
          hint="Share of LLM responses mentioning the firm"
        />
        <Tile
          label="Avg tone"
          value={audits.avg_tone_1_10 != null ? audits.avg_tone_1_10.toFixed(1) : '—'}
          hint="1–10 scale, higher = more favorable"
        />
        <Tile
          label="Audit cost"
          value={`$${audits.total_cost_usd.toFixed(2)}`}
          hint="Sum of run costs this month"
        />
      </div>

      {/* RAG distribution */}
      {ragTotal > 0 && (
        <div className="mt-4 rounded-xl border border-white/10 bg-[--bg-secondary] p-4">
          <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-widest text-white/40">
            <span>RAG distribution</span>
            <span>{ragTotal} responses scored</span>
          </div>
          <div className="flex h-3 overflow-hidden rounded-full bg-white/5">
            {audits.rag_totals.red > 0 && (
              <div
                className="h-full bg-[--rag-red]"
                style={{ width: `${(audits.rag_totals.red / ragTotal) * 100}%` }}
                title={`${audits.rag_totals.red} red`}
              />
            )}
            {audits.rag_totals.yellow > 0 && (
              <div
                className="h-full bg-[--rag-yellow]"
                style={{ width: `${(audits.rag_totals.yellow / ragTotal) * 100}%` }}
                title={`${audits.rag_totals.yellow} yellow`}
              />
            )}
            {audits.rag_totals.green > 0 && (
              <div
                className="h-full bg-[--rag-green]"
                style={{ width: `${(audits.rag_totals.green / ragTotal) * 100}%` }}
                title={`${audits.rag_totals.green} green`}
              />
            )}
          </div>
          <div className="mt-2 flex justify-between font-[family-name:var(--font-geist-mono)] text-[11px]">
            <span className="text-[--rag-red]">{audits.rag_totals.red} red</span>
            <span className="text-[--rag-yellow]">{audits.rag_totals.yellow} yellow</span>
            <span className="text-[--rag-green]">{audits.rag_totals.green} green</span>
          </div>
        </div>
      )}

      {/* By kind */}
      {Object.keys(audits.by_kind).length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[10px] uppercase tracking-widest text-white/40">
            By kind
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(audits.by_kind).map(([kind, count]) => (
              <span
                key={kind}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1 text-xs"
              >
                <span className="text-white/55">{kind}</span>
                <span className="font-[family-name:var(--font-geist-mono)] text-white/80">
                  {count}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Per-run table */}
      {audits.runs.length > 0 && (
        <div className="mt-5 overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="border-b border-white/10 bg-white/[0.02]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-white/40">
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2 font-medium">Started</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">RAG</th>
                <th className="px-4 py-2 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {audits.runs.map((r) => (
                <tr key={r.id} className="border-b border-white/5 last:border-b-0">
                  <td className="px-4 py-2.5 font-[family-name:var(--font-geist-mono)] text-xs text-white/80">
                    {r.kind}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-white/60">
                    {r.started_at
                      ? new Date(r.started_at).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })
                      : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    <StatusPill status={r.status} />
                  </td>
                  <td className="px-4 py-2.5 font-[family-name:var(--font-geist-mono)] text-xs">
                    {r.rag.red + r.rag.yellow + r.rag.green > 0 ? (
                      <span className="flex gap-2">
                        {r.rag.red > 0 && (
                          <span className="text-[--rag-red]">{r.rag.red}R</span>
                        )}
                        {r.rag.yellow > 0 && (
                          <span className="text-[--rag-yellow]">{r.rag.yellow}Y</span>
                        )}
                        {r.rag.green > 0 && (
                          <span className="text-[--rag-green]">{r.rag.green}G</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-white/30">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-[family-name:var(--font-geist-mono)] text-xs text-white/70">
                    ${r.cost_usd.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {audits.total === 0 && (
        <EmptyLine message="No audit runs this month" />
      )}
    </Section>
  );
}

// ── Reddit ───────────────────────────────────────────────────

function RedditSection({ payload }: { payload: MonthlyReportPayload }) {
  const { reddit } = payload;
  return (
    <Section icon={MessageSquare} title="Reddit" count={reddit.total_mentions}>
      {/* Sentiment breakdown */}
      {Object.keys(reddit.by_sentiment).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(reddit.by_sentiment).map(([sentiment, count]) => (
            <span
              key={sentiment}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${sentimentBadgeClass(sentiment)}`}
            >
              <span className="font-medium">{sentiment}</span>
              <span className="font-[family-name:var(--font-geist-mono)]">{count}</span>
            </span>
          ))}
        </div>
      )}

      {/* Top mentions */}
      {reddit.top_mentions.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-widest text-white/40">
            Top mentions (by karma)
          </div>
          {reddit.top_mentions.map((m, i) => (
            <div
              key={i}
              className="rounded-xl border border-white/10 bg-[--bg-secondary] px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span
                  className={`rounded-full px-2 py-0.5 font-medium ${sentimentBadgeClass(m.sentiment ?? 'neutral')}`}
                >
                  {m.sentiment ?? 'unknown'}
                </span>
                <span className="font-[family-name:var(--font-geist-mono)] text-white/55">
                  r/{m.subreddit}
                </span>
                <span className="font-[family-name:var(--font-geist-mono)] text-white/40">
                  {m.karma ?? 0} karma
                </span>
                {m.posted_at && (
                  <span className="font-[family-name:var(--font-geist-mono)] text-white/30">
                    {new Date(m.posted_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                )}
                <a
                  href={m.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex items-center gap-1 text-[--accent] hover:underline"
                >
                  Open
                  <ExternalLink size={10} strokeWidth={2} />
                </a>
              </div>
              {m.excerpt && (
                <p className="mt-2 line-clamp-2 text-sm text-white/75">{m.excerpt}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {reddit.total_mentions === 0 && (
        <EmptyLine message="No Reddit mentions ingested this month" />
      )}
    </Section>
  );
}

// ── Competitive ──────────────────────────────────────────────

function CompetitiveSection({ payload }: { payload: MonthlyReportPayload }) {
  const { competitive } = payload;
  // Sort competitors by mention count desc — the biggest share-of-voice
  // claimants belong at the top.
  const sortedCompetitors = [...competitive.by_competitor].sort(
    (a, b) => b.mention_count - a.mention_count,
  );

  return (
    <Section icon={Users} title="Competitive" count={competitive.total_mentions}>
      {sortedCompetitors.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="border-b border-white/10 bg-white/[0.02]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-white/40">
                <th className="px-4 py-2 font-medium">Competitor</th>
                <th className="px-4 py-2 font-medium">Mentions</th>
                <th className="px-4 py-2 font-medium" title="Average share-of-voice across mentions">
                  Avg share
                </th>
                <th className="px-4 py-2 font-medium">Praise</th>
              </tr>
            </thead>
            <tbody>
              {sortedCompetitors.map((c) => (
                <tr
                  key={c.competitor_id}
                  className="border-b border-white/5 last:border-b-0"
                >
                  <td className="px-4 py-2.5 text-white/85">{c.name}</td>
                  <td className="px-4 py-2.5 font-[family-name:var(--font-geist-mono)] text-xs text-white/70">
                    {c.mention_count}
                  </td>
                  <td className="px-4 py-2.5 font-[family-name:var(--font-geist-mono)] text-xs text-white/70">
                    {c.avg_share != null ? `${Math.round(c.avg_share * 100)}%` : '—'}
                  </td>
                  <td className="px-4 py-2.5 font-[family-name:var(--font-geist-mono)] text-xs">
                    {c.praise_count > 0 ? (
                      <span className="text-[--rag-green]">{c.praise_count}</span>
                    ) : (
                      <span className="text-white/40">0</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyLine message="No competitor mentions this month" />
      )}
    </Section>
  );
}

// ── Suppression ──────────────────────────────────────────────

function SuppressionSection({ payload }: { payload: MonthlyReportPayload }) {
  const { suppression } = payload;
  return (
    <Section icon={FileX} title="Suppression" count={suppression.new_findings}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Tile
          label="New findings"
          value={suppression.new_findings}
          hint="Legacy pages flagged this month"
        />
        <Tile
          label="Open tickets at month-end"
          value={suppression.open_tickets_at_end}
          hint="Remediation queue depth at the close of the window"
        />
      </div>

      {Object.keys(suppression.by_action).length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[10px] uppercase tracking-widest text-white/40">
            By action
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(suppression.by_action).map(([action, count]) => (
              <span
                key={action}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1 text-xs"
              >
                <span className="font-medium uppercase tracking-wider text-white/55">
                  {action}
                </span>
                <span className="font-[family-name:var(--font-geist-mono)] text-white/80">
                  {count}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {suppression.new_findings === 0 && suppression.open_tickets_at_end === 0 && (
        <EmptyLine message="No suppression activity this month" />
      )}
    </Section>
  );
}

// ── Entity ───────────────────────────────────────────────────

function EntitySection({ payload }: { payload: MonthlyReportPayload }) {
  const { entity } = payload;
  return (
    <Section icon={Database} title="Entity" count={entity.new_signals}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Tile label="New signals" value={entity.new_signals} />
        <Tile
          label="Divergences"
          value={entity.divergence_count}
          hint="Signals where one or more source disagreed"
          tone={entity.divergence_count > 0 ? 'red' : 'neutral'}
        />
      </div>

      {Object.keys(entity.by_source).length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[10px] uppercase tracking-widest text-white/40">
            By source
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(entity.by_source).map(([source, count]) => (
              <span
                key={source}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1 text-xs"
              >
                <span className="font-medium text-white/55">{source}</span>
                <span className="font-[family-name:var(--font-geist-mono)] text-white/80">
                  {count}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {entity.new_signals === 0 && (
        <EmptyLine message="No entity signals captured this month" />
      )}
    </Section>
  );
}

// ── Cost ─────────────────────────────────────────────────────

function CostSection({ payload }: { payload: MonthlyReportPayload }) {
  const { cost } = payload;
  const providers = Object.entries(cost.by_provider);
  const totalByProvider = providers.reduce((sum, [, v]) => sum + v, 0);

  return (
    <Section icon={DollarSign} title="Cost">
      <div className="grid gap-3 sm:grid-cols-2">
        <Tile
          label="Total USD"
          value={`$${cost.total_usd.toFixed(2)}`}
          hint="Sum across audit runs this month"
          tone="accent"
        />
        <Tile
          label="Providers used"
          value={providers.length}
          hint="Distinct model providers billed"
        />
      </div>

      {providers.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="border-b border-white/10 bg-white/[0.02]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-white/40">
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-4 py-2 font-medium">Spend</th>
                <th className="px-4 py-2 font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {providers
                .sort((a, b) => b[1] - a[1])
                .map(([provider, amount]) => (
                  <tr
                    key={provider}
                    className="border-b border-white/5 last:border-b-0"
                  >
                    <td className="px-4 py-2.5 font-[family-name:var(--font-geist-mono)] text-xs text-white/80">
                      {provider}
                    </td>
                    <td className="px-4 py-2.5 font-[family-name:var(--font-geist-mono)] text-xs text-white/70">
                      ${amount.toFixed(2)}
                    </td>
                    <td className="px-4 py-2.5 font-[family-name:var(--font-geist-mono)] text-xs text-white/60">
                      {totalByProvider > 0
                        ? `${Math.round((amount / totalByProvider) * 100)}%`
                        : '—'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {cost.total_usd === 0 && providers.length === 0 && (
        <EmptyLine message="No spend recorded this month" />
      )}
    </Section>
  );
}

// ── Shared atoms ─────────────────────────────────────────────

function Section({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: typeof Activity;
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[--bg-secondary]/40 p-6">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/5">
          <Icon size={18} strokeWidth={1.5} className="text-[--accent]" />
        </div>
        <h2 className="font-[family-name:var(--font-jakarta)] text-lg font-semibold text-white">
          {title}
        </h2>
        {typeof count === 'number' && (
          <span className="font-[family-name:var(--font-geist-mono)] text-[10px] text-white/40">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'accent' | 'red' | 'neutral';
}) {
  const valueClass =
    tone === 'accent'
      ? 'text-[--accent]'
      : tone === 'red'
      ? 'text-[--rag-red]'
      : 'text-white';
  return (
    <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-4">
      <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
        {label}
      </div>
      <div className={`mt-1 font-[family-name:var(--font-jakarta)] text-xl font-bold ${valueClass}`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-white/40">{hint}</div>}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === 'completed'
      ? 'bg-[--rag-green-bg] text-[--rag-green]'
      : status === 'failed' || status === 'error'
      ? 'bg-[--rag-red-bg] text-[--rag-red]'
      : status === 'running'
      ? 'bg-blue-500/15 text-blue-300'
      : 'bg-white/10 text-white/60';
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls}`}
    >
      {status}
    </span>
  );
}

function EmptyLine({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/10 px-5 py-4 text-xs text-white/40">
      {message}
    </div>
  );
}

function sentimentBadgeClass(sentiment: string): string {
  switch (sentiment) {
    case 'praise':
      return 'bg-[--rag-green-bg] text-[--rag-green]';
    case 'complaint':
      return 'bg-[--rag-red-bg] text-[--rag-red]';
    case 'recommendation_request':
      return 'bg-[--accent]/15 text-[--accent]';
    case 'neutral':
    default:
      return 'bg-white/10 text-white/55';
  }
}
