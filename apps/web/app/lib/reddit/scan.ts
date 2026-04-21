import {
  getDb,
  redditMentions,
  brandTruthVersions,
  remediationTickets,
  auditRuns,
} from '@ai-edge/db';
import type { BrandTruth } from '@ai-edge/shared';
import { eq, desc } from 'drizzle-orm';
import { searchReddit, type RedditPost } from './client';
import { classifySentiment, type RedditSentiment } from './sentiment';

/**
 * Run a Reddit sentiment scan for a firm.
 *
 * Flow:
 *   1. Load latest Brand Truth for the firm
 *   2. Dedupe + normalize search terms (firm_name, name_variants, common_misspellings)
 *   3. For each term, search Reddit posts (last month, relevance-sorted)
 *   4. Substring-verify the firm name actually appears (Reddit fuzzy-matches)
 *   5. Classify sentiment via OpenRouter Gemini Flash
 *   6. Upsert via the (firm_id, post_id, comment_id) unique index — post-level
 *      rows use `''` as a sentinel because Postgres treats NULLs as distinct
 *   7. Open a remediation ticket for any complaint with score >= 10 karma
 *
 * Returns an `audit_run` id of kind='reddit' so the dashboard can link to
 * the scan and we get a consistent history/status model.
 */
export async function runRedditScan(firmId: string): Promise<string> {
  const db = getDb();

  // Create audit run row so the UI has something to poll on
  const [run] = await db
    .insert(auditRuns)
    .values({
      firm_id: firmId,
      kind: 'reddit',
      status: 'running',
      started_at: new Date(),
    })
    .returning({ id: auditRuns.id });

  const runId = run!.id;

  try {
    // Load latest Brand Truth
    const [btv] = await db
      .select()
      .from(brandTruthVersions)
      .where(eq(brandTruthVersions.firm_id, firmId))
      .orderBy(desc(brandTruthVersions.version))
      .limit(1);

    if (!btv) throw new Error('No Brand Truth version found for firm');
    const brandTruth = btv.payload as BrandTruth;

    const searchTerms = collectSearchTerms(brandTruth);
    if (searchTerms.length === 0) {
      throw new Error('Brand Truth has no firm_name/name_variants/common_misspellings to search');
    }

    // Dedupe across all search terms — the same post often shows up for
    // multiple variants. Key = post id.
    const seenPostIds = new Set<string>();
    const mentionsToInsert: Array<{
      post: RedditPost;
      sentiment: RedditSentiment;
      matchedTerm: string;
    }> = [];

    for (const term of searchTerms) {
      let posts: RedditPost[] = [];
      try {
        posts = await searchReddit({
          query: term,
          timeFilter: 'month',
          sortType: 'relevance',
          filter: 'posts',
        });
      } catch (err) {
        // Log but don't kill the whole scan — RapidAPI occasionally 502s.
        console.error(`Reddit search failed for "${term}":`, err);
        continue;
      }

      for (const post of posts) {
        if (seenPostIds.has(post.id)) continue;

        // Substring verify — Reddit's fuzzy search returns lots of false
        // positives. We only keep posts where the brand name actually
        // appears in title or body.
        const combined = `${post.title}\n${post.selftext}`.toLowerCase();
        if (!combined.includes(term.toLowerCase())) continue;

        seenPostIds.add(post.id);
        const sentiment = await classifySentiment({
          firmName: brandTruth.firm_name,
          title: post.title,
          body: post.selftext,
        });

        mentionsToInsert.push({
          post,
          sentiment: sentiment.label,
          matchedTerm: term,
        });
      }
    }

    // Bulk insert with dedupe via unique index. Sentinel '' for comment_id
    // makes the (firm_id, post_id, '') key actually enforce uniqueness —
    // Postgres treats NULL as distinct in multi-col unique indexes.
    if (mentionsToInsert.length > 0) {
      const inserted = await db
        .insert(redditMentions)
        .values(
          mentionsToInsert.map((m) => ({
            firm_id: firmId,
            subreddit: m.post.subreddit,
            post_id: m.post.id,
            comment_id: '',
            author: m.post.author,
            karma: m.post.score,
            sentiment: m.sentiment,
            text: `${m.post.title}\n\n${m.post.selftext}`.slice(0, 10000),
            url: m.post.url,
            posted_at: m.post.created_utc ? new Date(m.post.created_utc * 1000) : null,
          })),
        )
        .onConflictDoNothing({
          target: [redditMentions.firm_id, redditMentions.post_id, redditMentions.comment_id],
        })
        .returning({
          id: redditMentions.id,
          sentiment: redditMentions.sentiment,
          karma: redditMentions.karma,
        });

      // Open remediation tickets for real complaints (karma >= 10)
      const ticketRows = inserted
        .filter((row) => row.sentiment === 'complaint' && (row.karma ?? 0) >= 10)
        .map((row) => ({
          firm_id: firmId,
          source_type: 'reddit' as const,
          source_id: row.id,
          status: 'open',
          playbook_step: 'reddit_triage',
          due_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days — Reddit rots fast
        }));

      if (ticketRows.length > 0) {
        await db.insert(remediationTickets).values(ticketRows);
      }
    }

    await db
      .update(auditRuns)
      .set({ status: 'completed', finished_at: new Date() })
      .where(eq(auditRuns.id, runId));
  } catch (err) {
    await db
      .update(auditRuns)
      .set({ status: 'failed', finished_at: new Date(), error: String(err) })
      .where(eq(auditRuns.id, runId));
  }

  return runId;
}

function collectSearchTerms(bt: BrandTruth): string[] {
  const raw = [
    bt.firm_name,
    ...(bt.name_variants ?? []),
    ...(bt.common_misspellings ?? []),
  ];
  // Dedupe case-insensitive, drop empties, trim
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of raw) {
    const trimmed = term?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
