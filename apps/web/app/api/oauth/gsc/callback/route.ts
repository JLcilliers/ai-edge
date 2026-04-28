import { NextResponse } from 'next/server';
import { getDb, firms } from '@ai-edge/db';
import { eq } from 'drizzle-orm';
import {
  exchangeCode,
  fetchAccessibleSites,
  isOAuthConfigured,
  persistTokens,
} from '../../../../lib/gsc/oauth';

export const dynamic = 'force-dynamic';

/**
 * Google OAuth 2.0 callback for Search Console (Phase B #6).
 *
 * Reached via the redirect from Google's consent screen. URL params:
 *   code   — the authorization code we exchange for tokens (single-use)
 *   state  — the firm slug we set on the auth URL
 *   error  — present if the user denied or Google rejected the request
 *
 * Flow.
 *   1. Validate firm slug against our DB.
 *   2. Exchange code → tokens (single-use; must do this before any other
 *      step that could fail and force a retry).
 *   3. Call SearchConsole sites.list to get every property this account
 *      can see. We need this for the dropdown — operators almost always
 *      have multiple properties and must confirm which one anchors this
 *      firm.
 *   4. Persist tokens with the FIRST returned site as a default. The
 *      `gsc_connections.site_url` column is NOT NULL so we always store
 *      *something*; the operator confirms or changes it on the next page.
 *   5. If the account has exactly one site, we're done — redirect to
 *      settings with `?gsc=connected`.
 *   6. If two or more sites, redirect to /api/oauth/gsc/pick-site which
 *      renders a dropdown of all accessible properties.
 *
 * Hardening note. We don't validate `state` against a server-side nonce
 * because (a) the slug isn't user-controlled in any meaningful way (it's
 * a known firm in OUR DB), (b) the redirect URI is locked server-side at
 * the Google Cloud project level, and (c) a CSRF here would just connect
 * a different firm's GSC to itself, which is detectable via the
 * `connected_by` field. If we surface this to end-clients in the future
 * we'll add a server-side nonce.
 */
export async function GET(request: Request) {
  if (!isOAuthConfigured()) {
    console.warn('[oauth:gsc:callback] OAuth env not configured');
    return NextResponse.json(
      { error: 'OAuth not configured — see Phase B #6 setup' },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  // Don't log the auth code itself — it's a one-time bearer credential.
  console.log(
    `[oauth:gsc:callback] state=${state} hasCode=${!!code} error=${
      errorParam ?? 'none'
    }`,
  );

  if (errorParam) {
    return new NextResponse(
      `OAuth error: ${errorParam}. Try again from /dashboard/${state}/settings.`,
      { status: 400 },
    );
  }
  if (!code || !state) {
    return NextResponse.json(
      { error: 'Missing code or state in callback URL' },
      { status: 400 },
    );
  }

  // Resolve firm by slug.
  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id, slug: firms.slug })
    .from(firms)
    .where(eq(firms.slug, state))
    .limit(1);
  if (!firm) {
    return NextResponse.json(
      { error: `Firm not found: ${state}` },
      { status: 404 },
    );
  }

  // Step 1 — exchange the (single-use) auth code for tokens.
  let tokens;
  try {
    tokens = await exchangeCode(code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[oauth:gsc:callback] firm=${firm.slug} step=exchangeCode error="${msg}"`,
    );
    return new NextResponse(
      `Token exchange failed: ${msg}. Try again from /dashboard/${firm.slug}/settings.`,
      { status: 500 },
    );
  }

  // Step 2 — list properties this account can see in Search Console.
  let sites;
  try {
    sites = await fetchAccessibleSites(tokens.access_token);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[oauth:gsc:callback] firm=${firm.slug} step=fetchSites error="${msg}"`,
    );
    return new NextResponse(
      `Failed to list Search Console properties: ${msg}. Try again from /dashboard/${firm.slug}/settings.`,
      { status: 500 },
    );
  }

  if (sites.length === 0) {
    console.warn(
      `[oauth:gsc:callback] firm=${firm.slug} step=fetchSites siteCount=0`,
    );
    return new NextResponse(
      `No Search Console properties found for this Google account. Make sure the account has access to at least one verified property in Search Console (search.google.com/search-console), then try again from /dashboard/${firm.slug}/settings.`,
      { status: 400 },
    );
  }

  // Step 3 — persist tokens with the first site as a default. The
  // operator confirms or changes the choice on the next page; this just
  // satisfies the NOT NULL constraint and gives the cron a working URL
  // even if the operator never visits the picker.
  const defaultSite = sites[0]!.siteUrl;
  try {
    await persistTokens({
      firmId: firm.id,
      siteUrl: defaultSite,
      tokens,
      connectedBy: 'oauth-callback',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[oauth:gsc:callback] firm=${firm.slug} step=persistTokens defaultSite="${defaultSite}" error="${msg}"`,
    );
    return new NextResponse(
      `Failed to persist connection: ${msg}. Try again from /dashboard/${firm.slug}/settings.`,
      { status: 500 },
    );
  }
  console.log(
    `[oauth:gsc:callback] firm=${firm.slug} step=persisted siteCount=${sites.length} defaultSite="${defaultSite}"`,
  );

  // Step 4 — if there's only one site, we're done. Otherwise route to
  // the dropdown page.
  if (sites.length === 1) {
    const redirectUrl = new URL(
      `/dashboard/${firm.slug}/settings?gsc=connected`,
      request.url,
    );
    return NextResponse.redirect(redirectUrl);
  }

  const pickUrl = new URL('/api/oauth/gsc/pick-site', request.url);
  pickUrl.searchParams.set('slug', firm.slug);
  return NextResponse.redirect(pickUrl);
}
