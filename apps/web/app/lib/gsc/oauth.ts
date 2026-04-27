import { getDb, gscConnections } from '@ai-edge/db';
import { eq } from 'drizzle-orm';
import { encryptToken, decryptToken } from './crypto';

/**
 * Google OAuth 2.0 helpers for Search Console (Phase B #6).
 *
 * The flow.
 *   1. Operator hits "Connect Search Console" on /settings.
 *      → server action returns a redirect URL via `buildAuthorizeUrl()`.
 *   2. Browser redirects to Google's OAuth consent screen.
 *   3. User picks the GSC property, grants `webmasters.readonly`.
 *   4. Google redirects to /api/oauth/gsc/callback?code=…&state=…
 *      → callback handler exchanges code → tokens, encrypts, stores.
 *   5. Subsequent searchAnalytics queries call `getValidAccessToken()`
 *      which refreshes if the stored access_token is expired.
 *
 * Procurement requirements (one-time, ops side).
 *   - Google Cloud project + Search Console API enabled.
 *   - OAuth 2.0 Client ID (Web application).
 *   - Authorized redirect URI: $APP_URL/api/oauth/gsc/callback
 *   - Env vars on Vercel: GOOGLE_OAUTH_CLIENT_ID,
 *                         GOOGLE_OAUTH_CLIENT_SECRET,
 *                         OAUTH_TOKEN_ENCRYPTION_KEY (32-byte hex or
 *                                                      arbitrary passphrase),
 *                         GOOGLE_OAUTH_REDIRECT_URI (full https URL).
 *
 * Without those env vars, every helper here throws a clear error so the
 * UI can render "OAuth not configured — see Phase B #6 setup" rather
 * than 500-ing.
 */

const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface OAuthEnv {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getOAuthEnv(): OAuthEnv {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Google OAuth not configured — set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI',
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function isOAuthConfigured(): boolean {
  return !!(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    process.env.GOOGLE_OAUTH_REDIRECT_URI
  );
}

/**
 * Build the URL to redirect the operator to. `state` carries the firm
 * slug round-trip so the callback knows which firm to associate the
 * tokens with. We don't use a CSRF cookie here because the slug itself
 * is opaque-enough and the redirect URI is locked to our own host.
 */
export function buildAuthorizeUrl(firmSlug: string): string {
  const env = getOAuthEnv();
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', env.clientId);
  url.searchParams.set('redirect_uri', env.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  // Force prompt to ensure we always get a refresh_token — Google only
  // returns refresh_token on the first consent unless you ask for it.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', firmSlug);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

async function exchangeCode(code: string): Promise<TokenResponse> {
  const env = getOAuthEnv();
  const body = new URLSearchParams({
    code,
    client_id: env.clientId,
    client_secret: env.clientSecret,
    redirect_uri: env.redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Google token exchange failed: ${res.status} ${errBody.slice(0, 300)}`);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Persist tokens for a firm, encrypted. Called from the callback route
 * after a successful code exchange. Upserts: connecting a second time
 * for the same firm overwrites prior tokens (the operator is re-auth'ing).
 */
export async function persistTokens(args: {
  firmId: string;
  siteUrl: string;
  tokens: TokenResponse;
  connectedBy: string;
}): Promise<void> {
  const db = getDb();
  if (!args.tokens.refresh_token) {
    // Happens if the user previously consented and Google skipped the
    // refresh_token. We force prompt=consent in the auth URL specifically
    // to avoid this — but if it slips through anyway we surface a clear
    // error rather than silently storing access-only credentials that
    // expire in 1 hour and can never refresh.
    throw new Error(
      'Google did not return a refresh_token. Re-authorize with prompt=consent.',
    );
  }
  const expiresAt = new Date(Date.now() + (args.tokens.expires_in - 60) * 1000);
  const access = encryptToken(args.tokens.access_token);
  const refresh = encryptToken(args.tokens.refresh_token);

  // Upsert pattern: try update first; if no row matched, insert.
  const updated = await db
    .update(gscConnections)
    .set({
      site_url: args.siteUrl,
      access_token_enc: access,
      refresh_token_enc: refresh,
      scope: args.tokens.scope,
      expires_at: expiresAt,
      connected_by: args.connectedBy,
      connected_at: new Date(),
      last_sync_error: null,
    })
    .where(eq(gscConnections.firm_id, args.firmId))
    .returning({ firmId: gscConnections.firm_id });
  if (updated.length === 0) {
    await db.insert(gscConnections).values({
      firm_id: args.firmId,
      site_url: args.siteUrl,
      access_token_enc: access,
      refresh_token_enc: refresh,
      scope: args.tokens.scope,
      expires_at: expiresAt,
      connected_by: args.connectedBy,
    });
  }
}

/**
 * Top-level callback handler. Wraps exchange + persist; the route file
 * just calls this with the URL params and returns whatever it gets.
 */
export async function handleOAuthCallback(args: {
  code: string;
  firmId: string;
  siteUrl: string;
  connectedBy: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const tokens = await exchangeCode(args.code);
    await persistTokens({
      firmId: args.firmId,
      siteUrl: args.siteUrl,
      tokens,
      connectedBy: args.connectedBy,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Get a non-expired access_token for a firm, refreshing if needed.
 * Used by the searchAnalytics adapter. Throws if the firm has no
 * GSC connection or refresh has permanently failed.
 */
export async function getValidAccessToken(firmId: string): Promise<{
  accessToken: string;
  siteUrl: string;
}> {
  const db = getDb();
  const [conn] = await db
    .select()
    .from(gscConnections)
    .where(eq(gscConnections.firm_id, firmId))
    .limit(1);
  if (!conn) throw new Error('No Search Console connection for this firm');

  const now = Date.now();
  const expiry = new Date(conn.expires_at).getTime();
  if (expiry > now) {
    return {
      accessToken: decryptToken(conn.access_token_enc),
      siteUrl: conn.site_url,
    };
  }

  // Token expired (or about to) → refresh.
  const env = getOAuthEnv();
  const refresh = decryptToken(conn.refresh_token_enc);
  const body = new URLSearchParams({
    refresh_token: refresh,
    client_id: env.clientId,
    client_secret: env.clientSecret,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    // Persist the error so the UI shows it on the next read.
    await db
      .update(gscConnections)
      .set({ last_sync_error: `refresh failed: ${res.status} ${errBody.slice(0, 200)}` })
      .where(eq(gscConnections.firm_id, firmId));
    throw new Error(`token refresh failed: ${res.status} ${errBody.slice(0, 200)}`);
  }
  const refreshed = (await res.json()) as TokenResponse;
  // Google may or may not return a new refresh_token on refresh — keep
  // the old one if absent.
  const newAccess = refreshed.access_token;
  const newExpiresAt = new Date(Date.now() + (refreshed.expires_in - 60) * 1000);
  await db
    .update(gscConnections)
    .set({
      access_token_enc: encryptToken(newAccess),
      refresh_token_enc: refreshed.refresh_token
        ? encryptToken(refreshed.refresh_token)
        : conn.refresh_token_enc,
      expires_at: newExpiresAt,
      last_sync_error: null,
    })
    .where(eq(gscConnections.firm_id, firmId));
  return { accessToken: newAccess, siteUrl: conn.site_url };
}

export async function disconnectGsc(firmId: string): Promise<void> {
  const db = getDb();
  await db.delete(gscConnections).where(eq(gscConnections.firm_id, firmId));
}
