import * as cheerio from 'cheerio';

/**
 * Fetch a page and extract its main textual content. This is the "what does
 * this page actually say" pass feeding embeddings — we strip navigation,
 * footers, scripts, styles, and other chrome so the semantic distance is
 * computed against real prose, not `<nav>`/`<footer>` boilerplate that's
 * shared across every page on the site.
 *
 * Not a full readability reimplementation — that's in the Python worker
 * path with readability-lxml. This is a "good enough for 80% of sites"
 * heuristic pass that avoids the Playwright/container cost.
 */

const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '.nav',
  '.navbar',
  '.header',
  '.footer',
  '.sidebar',
  '.cookie-banner',
  '.cookie-consent',
  '.newsletter',
  '.social-share',
];

const MAIN_CANDIDATES = [
  'main',
  'article',
  '[role="main"]',
  '#main',
  '#content',
  '.main-content',
  '.post-content',
  '.entry-content',
  '.page-content',
];

export interface ExtractedPage {
  url: string;
  title: string | null;
  mainContent: string;
  wordCount: number;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function wordCount(s: string): number {
  if (!s) return 0;
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Walk the candidate selectors in priority order and use the first one
 * that yields >200 words — otherwise fall back to <body>. This matches
 * Mozilla Readability's "pick the densest content block" heuristic in
 * spirit without needing the full scoring algorithm.
 */
function pickMain($: cheerio.CheerioAPI): string {
  for (const sel of MAIN_CANDIDATES) {
    const el = $(sel).first();
    if (el.length === 0) continue;
    const text = collapseWhitespace(el.text());
    if (wordCount(text) >= 200) return text;
  }
  return collapseWhitespace($('body').text());
}

export async function fetchAndExtract(url: string): Promise<ExtractedPage> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'ai-edge-suppression/0.1 (brand audit)',
      Accept: 'text/html,application/xhtml+xml',
    },
    // Follow redirects silently — the persisted row uses the input URL so
    // the sitemap/UI mapping stays stable.
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(`fetch ${url} returned ${res.status}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    throw new Error(`unexpected content-type for ${url}: ${contentType}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // Strip noise before we compute .text() — cheerio's remove() mutates the
  // document in place so the main-content selector picks up the cleaned tree.
  for (const sel of NOISE_SELECTORS) $(sel).remove();

  const title = collapseWhitespace($('title').first().text()) || null;
  const main = pickMain($);

  // Cap to ~20k chars — embeddings API ignores content past its context
  // window anyway, and persisting 200KB of text per page for a 100-page
  // site is wasteful.
  const capped = main.slice(0, 20000);

  return {
    url,
    title,
    mainContent: capped,
    wordCount: wordCount(capped),
  };
}
