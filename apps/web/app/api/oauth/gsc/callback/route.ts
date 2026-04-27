import { NextResponse } from 'next/server';
import { getDb, firms } from '@ai-edge/db';
import { eq } from 'drizzle-orm';
import { handleOAuthCallback, isOAuthConfigured } from '../../../../lib/gsc/oauth';

export const dynamic = 'force-dynamic';

/**
 * Google OAuth 2.0 callback for Search Console (Phase B #6).
 *
 * Reached via the redirect from Google's consent screen. URL params:
 *   code   — the authorization code we exchange for tokens
 *   state  — the firm slug (we set this in buildAuthorizeUrl)
 *   error  — present if the user denied or Google rejected the request
 *
 * The callback can't ask the operator which Search Console site to
 * connect (Google's consent screen scopes the grant to one property
 * implicitly, but the API requires us to specify the property URL on
 * every query). For v1, we accept the property URL via a follow-up
 * query param `siteUrl=`. Operators paste it from Search Console:
 *   https://search.google.com/search-console → property selector
 *   → "Settings" → "Property settings" → "Property type"
 *
 * Hardening note. We don't validate `state` against a server-side
 * nonce because (a) the slug isn't user-controlled in any meaningful
 * way (it's a known firm in OUR DB), (b) the redirect URI is locked
 * server-side at the Google Cloud project level, and (c) a CSRF here
 * would just connect a different firm's GSC to itself, which is
 * detectable via the `connected_by` field. If we surface this to
 * end-clients in the future we'll add a server-side nonce.
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
  const siteUrl = url.searchParams.get('siteUrl');

  // Don't log the auth code itself — it's a one-time bearer credential.
  console.log(
    `[oauth:gsc:callback] state=${state} hasCode=${!!code} siteUrl=${
      siteUrl ? 'provided' : 'missing'
    } error=${errorParam ?? 'none'}`,
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
  if (!siteUrl) {
    // The first half of the dance succeeded but we need the operator
    // to confirm the property URL. Render a tiny HTML form that
    // POSTs back to ?code=&state=&siteUrl=… so we can complete.
    const safeState = encodeURIComponent(state);
    const safeCode = encodeURIComponent(code);
    return new NextResponse(
      `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Connect Search Console — pick property</title>
<style>
body{margin:0;background:#0b0b0b;color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{max-width:420px;width:100%;background:#171717;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:28px}
h1{font-size:18px;margin:0 0 8px;font-weight:600}
p{font-size:14px;color:rgba(255,255,255,.6);line-height:1.5;margin:0 0 18px}
label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.55);margin-bottom:6px}
input{width:100%;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:10px 12px;color:#fafafa;font-family:ui-monospace,Consolas,monospace;font-size:13px;box-sizing:border-box}
button{margin-top:16px;width:100%;background:#facc15;color:#000;border:0;border-radius:999px;padding:10px 16px;font-weight:600;font-size:14px;cursor:pointer}
small{display:block;margin-top:12px;color:rgba(255,255,255,.4);font-size:11px}
</style></head>
<body><div class="card">
<h1>Pick your Search Console property</h1>
<p>Paste the exact property URL from Search Console → Settings → Property type. Format: <code>https://www.example.com/</code> for URL prefix, or <code>sc-domain:example.com</code> for domain property.</p>
<form method="GET" action="">
  <input type="hidden" name="code" value="${safeCode}">
  <input type="hidden" name="state" value="${safeState}">
  <label for="siteUrl">Property URL</label>
  <input type="text" name="siteUrl" id="siteUrl" placeholder="https://www.example.com/" autofocus required>
  <button type="submit">Complete connection</button>
  <small>This page never leaves your browser; the form posts back to the same callback so we can finish exchanging the code.</small>
</form>
</div></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
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

  const result = await handleOAuthCallback({
    code,
    firmId: firm.id,
    siteUrl,
    connectedBy: 'oauth-callback',
  });

  if (!result.ok) {
    return new NextResponse(
      `Connection failed: ${result.error}. Try again from /dashboard/${firm.slug}/settings.`,
      { status: 500 },
    );
  }

  // Success → redirect back to the firm's settings page with a flash
  // hint via query param.
  const redirectUrl = new URL(
    `/dashboard/${firm.slug}/settings?gsc=connected`,
    request.url,
  );
  return NextResponse.redirect(redirectUrl);
}
