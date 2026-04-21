'use server';

import {
  getDb,
  firms,
  redditMentions,
  auditRuns,
} from '@ai-edge/db';
import { eq, desc, and } from 'drizzle-orm';
import { runRedditScan } from '../lib/reddit/scan';

const DOGFOOD_FIRM_SLUG = 'clixsy';

async function getFirmId(): Promise<string> {
  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id })
    .from(firms)
    .where(eq(firms.slug, DOGFOOD_FIRM_SLUG))
    .limit(1);
  if (!firm) throw new Error('Dogfood firm not found — save a Brand Truth first');
  return firm.id;
}

/** Start a new Reddit scan for the firm. Returns the audit_run id. */
export async function startRedditScan(): Promise<
  { runId: string } | { error: string }
> {
  try {
    const firmId = await getFirmId();
    const runId = await runRedditScan(firmId);
    return { runId };
  } catch (err) {
    return { error: String(err) };
  }
}

/** Poll status of a Reddit scan. Mirrors the audit status endpoint. */
export async function getRedditScanStatus(runId: string): Promise<{
  status: string;
  error: string | null;
}> {
  const db = getDb();
  const [run] = await db
    .select({ status: auditRuns.status, error: auditRuns.error })
    .from(auditRuns)
    .where(eq(auditRuns.id, runId))
    .limit(1);
  return run ?? { status: 'unknown', error: null };
}

export type RedditMentionRow = {
  id: string;
  subreddit: string;
  author: string | null;
  karma: number | null;
  sentiment: string | null;
  text: string | null;
  url: string;
  postedAt: Date | null;
  ingestedAt: Date;
};

/** All Reddit mentions for the firm, newest ingested first. */
export async function getRedditMentions(): Promise<RedditMentionRow[]> {
  const db = getDb();
  const firmId = await getFirmId();

  return db
    .select({
      id: redditMentions.id,
      subreddit: redditMentions.subreddit,
      author: redditMentions.author,
      karma: redditMentions.karma,
      sentiment: redditMentions.sentiment,
      text: redditMentions.text,
      url: redditMentions.url,
      postedAt: redditMentions.posted_at,
      ingestedAt: redditMentions.ingested_at,
    })
    .from(redditMentions)
    .where(eq(redditMentions.firm_id, firmId))
    .orderBy(desc(redditMentions.ingested_at))
    .limit(100);
}

/** Most recent Reddit scan audit_run — used to render last-run metadata. */
export async function getLatestRedditRun(): Promise<{
  id: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
} | null> {
  const db = getDb();
  const firmId = await getFirmId();

  const [run] = await db
    .select({
      id: auditRuns.id,
      status: auditRuns.status,
      startedAt: auditRuns.started_at,
      finishedAt: auditRuns.finished_at,
      error: auditRuns.error,
    })
    .from(auditRuns)
    .where(and(eq(auditRuns.firm_id, firmId), eq(auditRuns.kind, 'reddit')))
    .orderBy(desc(auditRuns.started_at))
    .limit(1);

  return run ?? null;
}
