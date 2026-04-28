import { NextResponse } from 'next/server';
import { getDb, firms } from '@ai-edge/db';
import { eq } from 'drizzle-orm';
import {
  fetchAccessibleSites,
  getValidAccessToken,
  isOAuthConfigured,
  updateSiteUrl,
  type AccessibleSite,
} from '../../../../lib/gsc/oauth';

export const dynamic = 'force-dynamic';

/**
 * Search Console "pick property" follow-up (Phase B #6).
 *
 * Reached via redirect from /api/oauth/gsc/callback when the granted
 * Google account has access to two or more Search Console properties.
 * The operator must confirm which property anchors this firm — we
 * default to sites[0] in the callback, but agencies almost always
 * manage multiple GSC accounts and we can't guess which one belongs
 * to this firm.
 *
 * Two phases on the same endpoint, distinguished by query params:
 *
 *   GET /api/oauth/gsc/pick-site?slug=<firm-slug>
 *     → reads the stored access token for the firm, calls
 *       webmasters.sites.list, renders an HTML page with a <select>
 *       of all accessible properties (form action posts back to this
 *       same endpoint with siteUrl filled in).
 *
 *   GET /api/oauth/gsc/pick-site?slug=<firm-slug>&siteUrl=<chosen>
 *     → updates gsc_connections.site_url, redirects to the firm's
 *       settings page with ?gsc=connected.
 *
 * GET-only flow (no POST) keeps the form submission compatible with
 * a server-rendered <form method="GET">. The siteUrl field is opaque
 * (it's whatever Google returns for siteEntry[].siteUrl) so there's
 * no SSRF concern beyond what the operator already chose.
 */
export async function GET(request: Request) {
  if (!isOAuthConfigured()) {
    return NextResponse.json(
      { error: 'OAuth not configured — see Phase B #6 setup' },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  const chosenSiteUrl = url.searchParams.get('siteUrl');

  if (!slug) {
    return NextResponse.json(
      { error: 'Missing slug — pick-site must be reached via /api/oauth/gsc/callback' },
      { status: 400 },
    );
  }

  // Resolve firm by slug.
  const db = getDb();
  const [firm] = await db
    .select({ id: firms.id, slug: firms.slug })
    .from(firms)
    .where(eq(firms.slug, slug))
    .limit(1);
  if (!firm) {
    return NextResponse.json({ error: `Firm not found: ${slug}` }, { status: 404 });
  }

  // ── Phase 2: form submitted with chosen siteUrl ──────────────
  if (chosenSiteUrl) {
    try {
      await updateSiteUrl(firm.id, chosenSiteUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[oauth:gsc:pick-site] firm=${firm.slug} step=updateSiteUrl error="${msg}"`,
      );
      return new NextResponse(
        `Failed to save the chosen property: ${msg}. Try again from /dashboard/${firm.slug}/settings.`,
        { status: 500 },
      );
    }
    console.log(
      `[oauth:gsc:pick-site] firm=${firm.slug} step=updated siteUrl="${chosenSiteUrl}"`,
    );
    const redirectUrl = new URL(
      `/dashboard/${firm.slug}/settings?gsc=connected`,
      request.url,
    );
    return NextResponse.redirect(redirectUrl);
  }

  // ── Phase 1: render the dropdown ─────────────────────────────
  // Pull a valid access token (auto-refreshes if the brief callback
  // window expired before the operator clicked through).
  let accessToken: string;
  let currentSiteUrl: string;
  try {
    const valid = await getValidAccessToken(firm.id);
    accessToken = valid.accessToken;
    currentSiteUrl = valid.siteUrl;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[oauth:gsc:pick-site] firm=${firm.slug} step=getValidAccessToken error="${msg}"`,
    );
    return new NextResponse(
      `No active Search Console connection for this firm. Re-authorize from /dashboard/${firm.slug}/settings.`,
      { status: 400 },
    );
  }

  let sites: AccessibleSite[];
  try {
    sites = await fetchAccessibleSites(accessToken);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[oauth:gsc:pick-site] firm=${firm.slug} step=fetchSites error="${msg}"`,
    );
    return new NextResponse(
      `Failed to list Search Console properties: ${msg}. Re-authorize from /dashboard/${firm.slug}/settings.`,
      { status: 500 },
    );
  }

  if (sites.length === 0) {
    return new NextResponse(
      `No Search Console properties for this account. Re-authorize from /dashboard/${firm.slug}/settings with an account that has at least one verified property.`,
      { status: 400 },
    );
  }

  return new NextResponse(renderPickerHtml({ slug: firm.slug, sites, currentSiteUrl }), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * HTML escape for safe interpolation into HTML attributes and text.
 * Auth-code-style values can contain `/`, `+`, `=`, `&` — `escape()` is
 * not safe; this is. Quotes are also escaped so it's safe inside both
 * `value="..."` attributes and text nodes.
 */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPickerHtml({
  slug,
  sites,
  currentSiteUrl,
}: {
  slug: string;
  sites: AccessibleSite[];
  currentSiteUrl: string;
}): string {
  const safeSlug = htmlEscape(slug);

  // Sort: verified first (siteOwner > siteFullUser > siteRestrictedUser),
  // unverified last so the operator's likely choice is at the top.
  const tier = (level: string): number => {
    switch (level) {
      case 'siteOwner':
        return 0;
      case 'siteFullUser':
        return 1;
      case 'siteRestrictedUser':
        return 2;
      default:
        return 3; // siteUnverifiedUser and any future levels
    }
  };
  const sorted = [...sites].sort((a, b) => {
    const t = tier(a.permissionLevel) - tier(b.permissionLevel);
    if (t !== 0) return t;
    return a.siteUrl.localeCompare(b.siteUrl);
  });

  // Render each property as a clickable list item rather than a <select>
  // option. Native <select> dropdowns become unusable past ~30 entries —
  // agencies routinely have 100+ properties — so we layer a search-as-
  // you-type filter on top of a scrollable list. `data-search` is the
  // pre-lowercased haystack the input filter matches against.
  const itemsHtml = sorted
    .map((s) => {
      const v = htmlEscape(s.siteUrl);
      const lvl = htmlEscape(s.permissionLevel);
      const search = htmlEscape(`${s.siteUrl} ${s.permissionLevel}`.toLowerCase());
      const isCurrent = s.siteUrl === currentSiteUrl;
      const isUnverified = s.permissionLevel === 'siteUnverifiedUser';
      const classes = [
        'property',
        isCurrent ? 'preselected' : '',
        isUnverified ? 'unverified' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const tierBadge = isUnverified
        ? '<span class="badge warn">unverified — sync will fail</span>'
        : `<span class="badge">${lvl}</span>`;
      return `<li role="option" class="${classes}" data-value="${v}" data-search="${search}">
  <span class="url">${v}</span>
  ${tierBadge}
</li>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Pick your Search Console property</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0b0b0b;color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{max-width:560px;width:100%;background:#171717;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:28px}
h1{font-size:18px;margin:0 0 8px;font-weight:600}
p{font-size:14px;color:rgba(255,255,255,.6);line-height:1.5;margin:0 0 18px}
label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.55);margin-bottom:6px}
input[type="search"]{width:100%;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:10px 12px;color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px}
input[type="search"]:focus{outline:none;border-color:#facc15}
button{margin-top:16px;width:100%;background:#facc15;color:#000;border:0;border-radius:999px;padding:10px 16px;font-weight:600;font-size:14px;cursor:pointer;transition:background .15s}
button:hover:not(:disabled){background:#fbbf24}
button:disabled{background:rgba(255,255,255,.08);color:rgba(255,255,255,.35);cursor:not-allowed}
small{display:block;margin-top:12px;color:rgba(255,255,255,.4);font-size:11px;line-height:1.5}
.count{font-size:11px;color:rgba(255,255,255,.45);margin-top:8px;margin-bottom:8px}
.list{list-style:none;padding:0;margin:0;max-height:340px;overflow-y:auto;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(0,0,0,.2)}
.list::-webkit-scrollbar{width:8px}
.list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:4px}
.property{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;transition:background .12s}
.property:last-child{border-bottom:none}
.property:hover{background:rgba(255,255,255,.04)}
.property.selected{background:rgba(250,204,21,.12);outline:1px solid rgba(250,204,21,.4);outline-offset:-1px}
.property.unverified{opacity:.7}
.url{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;color:#fafafa;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:rgba(255,255,255,.55);padding:2px 8px;border:1px solid rgba(255,255,255,.12);border-radius:999px;white-space:nowrap;flex-shrink:0}
.badge.warn{color:#fca5a5;border-color:rgba(252,165,165,.3)}
.empty{padding:32px 12px;text-align:center;color:rgba(255,255,255,.4);font-size:13px}
</style></head>
<body><div class="card">
<h1>Pick your Search Console property</h1>
<p>This Google account has access to ${sorted.length} ${sorted.length === 1 ? 'property' : 'properties'}. Type to filter, then click the one that matches the firm we're connecting. You can re-pick later from Settings.</p>
<form method="GET" action="/api/oauth/gsc/pick-site" id="picker-form">
  <input type="hidden" name="slug" value="${safeSlug}">
  <input type="hidden" name="siteUrl" id="chosen-site" required>
  <label for="filter">Search</label>
  <input type="search" id="filter" placeholder="Type domain, sc-domain:, or permission level…" autofocus autocomplete="off" spellcheck="false">
  <div class="count"><span id="visible-count">${sorted.length}</span> of ${sorted.length} ${sorted.length === 1 ? 'property' : 'properties'}</div>
  <ul class="list" id="property-list" role="listbox" aria-label="Search Console properties">
    ${itemsHtml}
  </ul>
  <button type="submit" id="submit-btn" disabled>Pick a property to continue</button>
  <small>Domain properties (<code>sc-domain:example.com</code>) cover all subdomains; URL-prefix properties (<code>https://www.example.com/</code>) are scoped to one origin. Verified levels (siteOwner, siteFullUser, siteRestrictedUser) can be queried; siteUnverifiedUser cannot.</small>
</form>
</div>
<script>
(() => {
  const filter = document.getElementById('filter');
  const list = document.getElementById('property-list');
  const chosen = document.getElementById('chosen-site');
  const visibleCount = document.getElementById('visible-count');
  const submitBtn = document.getElementById('submit-btn');
  const total = list.children.length;
  let selectedItem = null;

  function selectItem(li) {
    if (!li) return;
    if (selectedItem) selectedItem.classList.remove('selected');
    li.classList.add('selected');
    chosen.value = li.dataset.value;
    selectedItem = li;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save and connect';
    // Scroll selection into view in case keyboard chose it.
    li.scrollIntoView({ block: 'nearest' });
  }

  function applyFilter() {
    const q = filter.value.trim().toLowerCase();
    let visible = 0;
    for (const li of list.children) {
      const match = q === '' || li.dataset.search.indexOf(q) !== -1;
      li.style.display = match ? '' : 'none';
      if (match) visible++;
    }
    visibleCount.textContent = visible;
    if (visible === 0) {
      // Replace list with empty state — non-destructive: filter restores rows.
      list.dataset.empty = '1';
    } else {
      list.dataset.empty = '0';
    }
  }

  filter.addEventListener('input', applyFilter);

  list.addEventListener('click', (e) => {
    const li = e.target.closest('li.property');
    if (li) selectItem(li);
  });

  // Keyboard navigation: Enter on filter picks the first visible row;
  // ArrowDown moves focus to first visible row.
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const firstVisible = Array.from(list.children).find(
        (li) => li.style.display !== 'none',
      );
      if (firstVisible) selectItem(firstVisible);
    }
  });

  // Pre-select the currently-stored siteUrl so the form is submittable
  // without any user interaction (most operators want to keep the
  // connection pointed where it already is and just verify).
  const preselected = list.querySelector('li.preselected');
  if (preselected) selectItem(preselected);
})();
</script>
</body></html>`;
}
