'use server';

import {
  getDb,
  firms,
  auditRuns,
  redditMentions,
  brandTruthVersions,
} from '@ai-edge/db';
import { eq, desc, sql, and, ne } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export type FirmType =
  | 'law_firm'
  | 'dental_practice'
  | 'marketing_agency'
  | 'other';

const FIRM_TYPES: ReadonlySet<FirmType> = new Set([
  'law_firm',
  'dental_practice',
  'marketing_agency',
  'other',
]);

export type FirmRow = {
  id: string;
  slug: string;
  name: string;
  firm_type: FirmType;
  created_at: Date;
};

/** All firms in the workspace, newest first. */
export async function listFirms(): Promise<FirmRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: firms.id,
      slug: firms.slug,
      name: firms.name,
      firm_type: firms.firm_type,
      created_at: firms.created_at,
    })
    .from(firms)
    .orderBy(desc(firms.created_at));

  return rows.map((r) => ({ ...r, firm_type: r.firm_type as FirmType }));
}

/** Resolve a firm by slug. Null if not found. */
export async function getFirmBySlug(slug: string): Promise<FirmRow | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: firms.id,
      slug: firms.slug,
      name: firms.name,
      firm_type: firms.firm_type,
      created_at: firms.created_at,
    })
    .from(firms)
    .where(eq(firms.slug, slug))
    .limit(1);

  if (!row) return null;
  return { ...row, firm_type: row.firm_type as FirmType };
}

export type FirmSummary = {
  latestBrandTruthVersion: number | null;
  latestBrandTruthUpdatedAt: Date | null;
  lastAudit:
    | { id: string; status: string; startedAt: Date }
    | null;
  lastRedditScan:
    | { id: string; status: string; startedAt: Date }
    | null;
  redditMentionCount: number;
};

/** Headline stats for the client profile page + client-list cards. */
export async function getFirmSummary(
  slug: string,
): Promise<FirmSummary | null> {
  const db = getDb();
  const firm = await getFirmBySlug(slug);
  if (!firm) return null;

  const [btv, lastAudit, lastReddit, mentionCount] = await Promise.all([
    db
      .select({
        version: brandTruthVersions.version,
        created_at: brandTruthVersions.created_at,
      })
      .from(brandTruthVersions)
      .where(eq(brandTruthVersions.firm_id, firm.id))
      .orderBy(desc(brandTruthVersions.version))
      .limit(1),
    db
      .select({
        id: auditRuns.id,
        status: auditRuns.status,
        started_at: auditRuns.started_at,
      })
      .from(auditRuns)
      .where(
        and(eq(auditRuns.firm_id, firm.id), ne(auditRuns.kind, 'reddit')),
      )
      .orderBy(desc(auditRuns.started_at))
      .limit(1),
    db
      .select({
        id: auditRuns.id,
        status: auditRuns.status,
        started_at: auditRuns.started_at,
      })
      .from(auditRuns)
      .where(
        and(eq(auditRuns.firm_id, firm.id), eq(auditRuns.kind, 'reddit')),
      )
      .orderBy(desc(auditRuns.started_at))
      .limit(1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(redditMentions)
      .where(eq(redditMentions.firm_id, firm.id)),
  ]);

  return {
    latestBrandTruthVersion: btv[0]?.version ?? null,
    latestBrandTruthUpdatedAt: btv[0]?.created_at ?? null,
    lastAudit:
      lastAudit[0] && lastAudit[0].started_at
        ? {
            id: lastAudit[0].id,
            status: lastAudit[0].status,
            startedAt: lastAudit[0].started_at,
          }
        : null,
    lastRedditScan:
      lastReddit[0] && lastReddit[0].started_at
        ? {
            id: lastReddit[0].id,
            status: lastReddit[0].status,
            startedAt: lastReddit[0].started_at,
          }
        : null,
    redditMentionCount: mentionCount[0]?.count ?? 0,
  };
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/** Create a new client firm. Slug is auto-derived from name unless supplied. */
export async function createFirm(input: {
  name: string;
  firm_type: FirmType;
  slug?: string;
}): Promise<{ ok: true; slug: string } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Client name is required' };
  if (!FIRM_TYPES.has(input.firm_type)) {
    return { ok: false, error: 'Invalid firm type' };
  }

  const slug = (input.slug?.trim() || toSlug(name));
  if (!slug) return { ok: false, error: 'Could not derive a slug from the name' };
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return {
      ok: false,
      error: 'Slug must use only lowercase letters, numbers, and hyphens',
    };
  }

  const db = getDb();
  try {
    await db.insert(firms).values({
      slug,
      name,
      firm_type: input.firm_type,
    });
    revalidatePath('/dashboard');
    return { ok: true, slug };
  } catch (err) {
    const msg = String(err);
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return { ok: false, error: `A client with slug "${slug}" already exists` };
    }
    return { ok: false, error: msg };
  }
}
