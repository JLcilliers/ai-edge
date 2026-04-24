'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, ExternalLink, Trophy, Users } from 'lucide-react';
import {
  createCompetitor,
  deleteCompetitor,
  type CompetitorRow,
  type ShareOfMentionRow,
} from '../../../actions/competitor-actions';

type ShareData = {
  latestRunId: string | null;
  latestRunFinishedAt: Date | null;
  rows: ShareOfMentionRow[];
};

export function CompetitorsClient({
  firmSlug,
  initialRoster,
  initialShare,
}: {
  firmSlug: string;
  initialRoster: CompetitorRow[];
  initialShare: ShareData;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState('');

  const handleAdd = () => {
    setFormError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('Name is required');
      return;
    }
    startTransition(async () => {
      const result = await createCompetitor({
        firmSlug,
        name: trimmed,
        website: website.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setName('');
      setWebsite('');
      setNotes('');
      router.refresh();
    });
  };

  const handleDelete = (id: string, competitorName: string) => {
    if (!confirm(`Remove ${competitorName} from the competitor roster?`)) return;
    startTransition(async () => {
      const result = await deleteCompetitor({ firmSlug, id });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      router.refresh();
    });
  };

  const topMention = initialShare.rows.find((r) => r.mentionCount > 0);
  const totalMentions = initialShare.rows.reduce(
    (s, r) => s + r.mentionCount,
    0,
  );

  return (
    <div>
      {/* Add competitor form */}
      <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-6">
        <div className="mb-4 flex items-center gap-2">
          <Plus size={18} strokeWidth={1.5} className="text-[--accent]" />
          <h2 className="font-[family-name:var(--font-jakarta)] text-lg font-bold text-white">
            Add Competitor
          </h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-[2fr_2fr_3fr_auto]">
          <input
            type="text"
            placeholder="Firm name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-lg border border-white/10 bg-[--bg-primary] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[--accent]/50 focus:outline-none"
          />
          <input
            type="url"
            placeholder="https://example.com"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            className="rounded-lg border border-white/10 bg-[--bg-primary] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[--accent]/50 focus:outline-none"
          />
          <input
            type="text"
            placeholder="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="rounded-lg border border-white/10 bg-[--bg-primary] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[--accent]/50 focus:outline-none"
          />
          <button
            onClick={handleAdd}
            disabled={isPending}
            className="rounded-full bg-[--accent] px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-[--accent-hover] disabled:opacity-50"
          >
            {isPending ? 'Adding...' : 'Add'}
          </button>
        </div>
        {formError && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/15 px-3 py-2 text-xs text-red-400">
            {formError}
          </div>
        )}
      </div>

      {/* Headline stats */}
      {initialShare.latestRunFinishedAt && (
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <StatCard
            label="Tracked Competitors"
            value={String(initialRoster.length)}
            icon={Users}
          />
          <StatCard
            label="Total Mentions (latest audit)"
            value={String(totalMentions)}
            icon={Plus}
          />
          <StatCard
            label="Most Mentioned"
            value={topMention?.competitorName ?? '—'}
            detail={
              topMention
                ? `${topMention.mentionCount} mentions · ${(topMention.averageShare * 100).toFixed(0)}% avg share`
                : 'no mentions yet'
            }
            icon={Trophy}
          />
        </div>
      )}

      {/* Share of mention table */}
      <div className="mt-8">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h2 className="font-[family-name:var(--font-jakarta)] text-xl font-bold text-white">
              Roster & Share of Mention
            </h2>
            {initialShare.latestRunFinishedAt && (
              <p className="mt-1 font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
                From audit completed{' '}
                {new Date(initialShare.latestRunFinishedAt).toLocaleString()}
              </p>
            )}
            {!initialShare.latestRunId && initialRoster.length > 0 && (
              <p className="mt-1 font-[family-name:var(--font-geist-mono)] text-xs text-white/40">
                Run an audit to populate share-of-mention.
              </p>
            )}
          </div>
        </div>

        {initialRoster.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-[--bg-secondary] py-16 text-center">
            <Users className="mb-4 h-12 w-12 text-white/20" strokeWidth={1.5} />
            <h3 className="mb-2 text-lg font-semibold text-white/60">
              No competitors tracked yet
            </h3>
            <p className="max-w-md text-sm text-white/40">
              Add the 3–5 rival firms you most need to outrank. We&rsquo;ll
              measure how often each gets mentioned in LLM answers for your
              prospect queries.
            </p>
          </div>
        )}

        {initialRoster.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-white/10 bg-[--bg-secondary]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-[10px] font-medium uppercase tracking-widest text-white/40">
                  <th className="px-5 py-3">Competitor</th>
                  <th className="px-5 py-3">Website</th>
                  <th className="px-5 py-3 text-right">Mentions</th>
                  <th className="px-5 py-3 text-right">Avg Share</th>
                  <th className="px-5 py-3 text-right">Praise</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {initialShare.rows.map((share) => {
                  const competitor = initialRoster.find(
                    (c) => c.id === share.competitorId,
                  );
                  if (!competitor) return null;
                  return (
                    <tr
                      key={share.competitorId}
                      className="border-b border-white/5 last:border-0"
                    >
                      <td className="px-5 py-4">
                        <div className="font-medium text-white">
                          {competitor.name}
                        </div>
                        {competitor.notes && (
                          <div className="mt-0.5 text-xs text-white/40">
                            {competitor.notes}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        {competitor.website ? (
                          <a
                            href={competitor.website}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-[family-name:var(--font-geist-mono)] text-xs text-white/55 hover:text-white"
                          >
                            {hostnameOf(competitor.website)}
                            <ExternalLink size={11} strokeWidth={1.5} />
                          </a>
                        ) : (
                          <span className="text-xs text-white/30">—</span>
                        )}
                      </td>
                      <td className="px-5 py-4 text-right font-[family-name:var(--font-geist-mono)] text-white/80">
                        {share.mentionCount}
                      </td>
                      <td className="px-5 py-4 text-right">
                        <ShareBar value={share.averageShare} />
                      </td>
                      <td className="px-5 py-4 text-right">
                        {share.praiseCount > 0 ? (
                          <span className="rounded-full bg-[--rag-green-bg] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[--rag-green]">
                            {share.praiseCount}
                          </span>
                        ) : (
                          <span className="text-xs text-white/30">—</span>
                        )}
                      </td>
                      <td className="px-5 py-4 text-right">
                        <button
                          onClick={() =>
                            handleDelete(share.competitorId, competitor.name)
                          }
                          disabled={isPending}
                          aria-label={`Remove ${competitor.name}`}
                          className="rounded-lg p-1.5 text-white/40 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                        >
                          <Trash2 size={14} strokeWidth={1.5} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function ShareBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="inline-flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-[--accent]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-[family-name:var(--font-geist-mono)] text-xs text-white/55">
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail?: string;
  icon: typeof Trophy;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[--bg-secondary] p-5">
      <div className="flex items-center gap-2">
        <Icon size={14} strokeWidth={1.5} className="text-white/40" />
        <div className="text-[10px] font-medium uppercase tracking-widest text-white/40">
          {label}
        </div>
      </div>
      <div className="mt-2 font-[family-name:var(--font-jakarta)] text-xl font-bold text-white">
        {value}
      </div>
      {detail && <div className="mt-1 text-xs text-white/40">{detail}</div>}
    </div>
  );
}
