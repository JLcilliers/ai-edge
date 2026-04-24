import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, Wand2 } from 'lucide-react';
import {
  getSuppressionFindingDetail,
} from '../../../../actions/rewrite-draft-actions';
import { FindingDetailClient } from './finding-detail-client';

export const dynamic = 'force-dynamic';

/**
 * Legacy-finding detail page — the entry point for the AI-assisted rewrite
 * workflow (PLAN §5.3).
 *
 * The page is rendered server-side with the initial detail payload (finding
 * + page + current draft, if any). The client component handles the
 * generate/accept/reject mutations so the user can iterate without a full
 * navigation on each action.
 */
export default async function FindingDetailPage({
  params,
}: {
  params: Promise<{ firmSlug: string; findingId: string }>;
}) {
  const { firmSlug, findingId } = await params;
  const detail = await getSuppressionFindingDetail(firmSlug, findingId).catch(
    () => null,
  );
  if (!detail) notFound();

  const distance = detail.finding.semanticDistance;
  const distanceBadge =
    detail.finding.action === 'noindex'
      ? 'bg-[--rag-red-bg] text-[--rag-red]'
      : detail.finding.action === 'rewrite'
        ? 'bg-[--rag-yellow-bg] text-[--rag-yellow]'
        : 'bg-white/10 text-white/55';

  return (
    <div>
      <div className="mb-4">
        <Link
          href={`/dashboard/${firmSlug}/suppression`}
          className="inline-flex items-center gap-1.5 text-xs text-white/55 hover:text-white"
        >
          <ArrowLeft size={14} strokeWidth={1.5} />
          Back to suppression
        </Link>
      </div>

      <div className="mb-8 flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/5">
          <Wand2 size={24} strokeWidth={1.5} className="text-[--accent]" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="font-[family-name:var(--font-jakarta)] text-3xl font-extrabold tracking-tight text-white">
            Legacy Page Rewrite
          </h1>
          <p className="mt-2 text-white/55">
            Rewrites this page in the current Brand Truth&apos;s voice while
            preserving on-page entities (names, credentials, contact details)
            and avoiding banned claims. Generation is deterministic — the
            same draft is produced until either the page content or the
            Brand Truth changes.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 font-[family-name:var(--font-geist-mono)] text-xs">
            <span className={`rounded-full px-3 py-1 text-[10px] font-medium uppercase tracking-wider ${distanceBadge}`}>
              {detail.finding.action}
            </span>
            <span className="text-white/55">d = {distance.toFixed(3)}</span>
            {detail.page.wordCount !== null && (
              <span className="text-white/40">
                {detail.page.wordCount} words on legacy page
              </span>
            )}
            <a
              href={detail.page.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[--accent] hover:underline"
            >
              {detail.page.url}
              <ExternalLink size={12} strokeWidth={1.5} />
            </a>
          </div>
        </div>
      </div>

      <FindingDetailClient detail={detail} />
    </div>
  );
}
