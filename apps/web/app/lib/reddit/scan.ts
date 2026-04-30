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
 * Flow (two-pass — collect, then gate, then classify):
 *   1. Load latest Brand Truth for the firm.
 *   2. Dedupe + normalize search terms (firm_name, name_variants, misspellings;
 *      MIN_TERM_LENGTH=4 floor on everything except firm_name itself).
 *   3. PASS 1 — for each term, search Reddit (last month, relevance-sorted),
 *      word-boundary verify the term appears in title+selftext, and accumulate
 *      candidates by post_id while recording every term that matched. A post
 *      that matches ≥2 distinct terms gets auto-accepted later — that pattern
 *      ("Bruni & Campisi" appearing in one thread, or "Pickett" + "Andrew
 *      Pickett Law" co-occurring) is almost always a real mention.
 *   4. Build a CONTEXT-KEYWORD set from Brand Truth: geography (city/state),
 *      practice areas / service offerings, attorney/provider/team names,
 *      primary URL bare domain, secondary tokens of the firm_name (so
 *      "Campisi" counts when the matched term was "Bruni" alone).
 *   5. PASS 2 — for each candidate post, decide:
 *        - matchedTerms.length ≥ 2 → auto-accept (strong co-occurrence signal)
 *        - context set is empty → accept (permissive fallback for firms with
 *          sparse Brand Truth — better to surface than silently hide)
 *        - otherwise → accept iff at least one context keyword (other than the
 *          matched term itself) word-boundary matches in title+selftext.
 *      Posts that fail are logged but never sentiment-classified — saving the
 *      LLM call AND not polluting the dashboard with confidently-irrelevant
 *      mentions ("Bruni" pasta sauce, Civil War general "Pickett", etc.).
 *   6. Classify sentiment via OpenRouter Gemini Flash for accepted posts only.
 *   7. Upsert via the (firm_id, post_id, comment_id) unique index — post-level
 *      rows use `''` as a sentinel because Postgres treats NULLs as distinct.
 *   8. Open a remediation ticket for any complaint with score >= 10 karma.
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

    // PASS 1: collect candidate posts. A post can match multiple terms — we
    // record all of them so PASS 2 can use co-occurrence as a strong signal.
    type Candidate = {
      post: RedditPost;
      matchedTerms: string[];
    };
    const candidates = new Map<string, Candidate>();

    // Track per-term outcome so we can detect "every search threw" and turn
    // a silently-empty scan into a real `failed` audit row instead of a
    // misleading `completed candidates=0`. Without this the dashboard says
    // "scan ran, no new mentions" — same UX as a healthy-but-quiet firm —
    // even when the API key is rotated, RapidAPI is down, or the host name
    // is wrong.
    let searchAttempts = 0;
    let searchFailures = 0;
    const lastSearchErrors: string[] = [];

    for (const term of searchTerms) {
      searchAttempts++;
      let posts: RedditPost[] = [];
      try {
        posts = await searchReddit({
          query: term,
          timeFilter: 'month',
          sortType: 'relevance',
          filter: 'posts',
        });
      } catch (err) {
        // Log but don't kill the whole scan — RapidAPI occasionally 502s
        // and a single transient term failure shouldn't lose the others.
        console.error(`Reddit search failed for "${term}":`, err);
        searchFailures++;
        // Keep just the most recent few error messages — the audit_run.error
        // column truncates around 1KB and we'd rather see the last error
        // than a dump of identical 401s.
        const msg = err instanceof Error ? err.message : String(err);
        if (lastSearchErrors.length < 3) lastSearchErrors.push(msg);
        continue;
      }

      const pattern = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
      for (const post of posts) {
        const combined = `${post.title}\n${post.selftext}`;
        // Word-boundary verify — Reddit's fuzzy search returns lots of false
        // positives. Substring match was naive ("APL" matched "APLE", "APRIL"
        // didn't but "APL boss" did legitimately and "APL Bioengineering"
        // also got through). Word boundaries kill the substring class.
        if (!pattern.test(combined)) continue;

        let candidate = candidates.get(post.id);
        if (!candidate) {
          candidate = { post, matchedTerms: [] };
          candidates.set(post.id, candidate);
        }
        if (!candidate.matchedTerms.includes(term)) {
          candidate.matchedTerms.push(term);
        }
      }
    }

    // Fail loud if every attempted search threw. An empty result set on a
    // genuine quiet firm produces 0 candidates with `searchFailures=0` —
    // that path stays `completed`. Only the all-threw case flips to failed.
    if (searchAttempts > 0 && searchFailures === searchAttempts) {
      throw new Error(
        `All ${searchAttempts} Reddit search call(s) failed — ` +
          `last error(s): ${lastSearchErrors.join(' | ')}. ` +
          `Check RAPIDAPI_REDDIT_KEY / RAPIDAPI_REDDIT_HOST.`,
      );
    }

    // PASS 2: relevance gate. Build context once, then walk candidates.
    const contextKeywords = buildContextKeywords(brandTruth);
    const isContextEmpty = contextKeywords.length === 0;
    if (isContextEmpty) {
      console.warn(
        `[reddit:scan] firm ${firmId} has no extractable context keywords ` +
          `(geography / services / attorneys / domain). Relevance gate is ` +
          `running in PERMISSIVE mode — populate Brand Truth to reduce noise.`,
      );
    }

    const accepted: Array<{
      post: RedditPost;
      matchedTerm: string;
      reason: 'multi-term' | 'context-match' | 'permissive';
    }> = [];
    let rejected = 0;

    for (const candidate of candidates.values()) {
      const decision = evaluateRelevance(
        candidate.post,
        candidate.matchedTerms,
        contextKeywords,
        isContextEmpty,
      );
      if (decision.accept) {
        accepted.push({
          post: candidate.post,
          // Prefer the longest matched term — usually the most specific one
          // (e.g., "Bruni & Campisi" > "Bruni"). Used only for the
          // matched_term column on the mention row, not for any logic.
          matchedTerm: pickPrimaryTerm(candidate.matchedTerms),
          reason: decision.reason,
        });
      } else {
        rejected++;
      }
    }

    console.log(
      `[reddit:scan] firm=${firmId} candidates=${candidates.size} ` +
        `accepted=${accepted.length} (multi-term=${
          accepted.filter((a) => a.reason === 'multi-term').length
        }, context-match=${
          accepted.filter((a) => a.reason === 'context-match').length
        }, permissive=${
          accepted.filter((a) => a.reason === 'permissive').length
        }) rejected=${rejected}`,
    );

    // Sentiment classification — only for accepted candidates. This is the
    // expensive step (one LLM call per post), so the gate above directly
    // saves cost in addition to UX cleanup.
    const mentionsToInsert: Array<{
      post: RedditPost;
      sentiment: RedditSentiment;
      matchedTerm: string;
    }> = [];

    for (const a of accepted) {
      const sentiment = await classifySentiment({
        firmName: brandTruth.firm_name,
        title: a.post.title,
        body: a.post.selftext,
      });
      mentionsToInsert.push({
        post: a.post,
        sentiment: sentiment.label,
        matchedTerm: a.matchedTerm,
      });
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

/**
 * Minimum length for a Reddit search term. 3-character abbreviations like
 * "APL" / "IBM" / "KFC" match dozens of unrelated subreddits — the cost of
 * letting them through is hundreds of NEUTRAL rows that the operator has
 * to dismiss before reaching real signal. The firm_name itself is exempt
 * from this filter because it's the root identity (and is always long
 * enough in practice).
 *
 * 4 characters is the floor. "Avvo" (4), "Yelp" (4), "Pickett" (7) all
 * pass. "APL" (3), "AB" (2), "X" (1) are skipped with a console warning
 * the operator can grep in vercel logs.
 */
const MIN_TERM_LENGTH = 4;

/**
 * Minimum length for a CONTEXT keyword. Looser than MIN_TERM_LENGTH because
 * context keywords aren't searched against Reddit — they're only used to
 * disambiguate posts already returned by a search. A 3-letter geography
 * abbreviation like "NYC" is fine here even though "NYC" alone is too
 * ambiguous to search for.
 */
const MIN_CONTEXT_LENGTH = 3;

/**
 * Tokens that should never count as a context keyword on their own. These
 * are extracted from firm names + service offerings but mean nothing
 * disambiguating in Reddit threads ("Group", "and", "the", "law", "firm"
 * appear in millions of unrelated posts).
 */
const CONTEXT_STOPWORDS = new Set<string>([
  'the',
  'and',
  'for',
  'of',
  'on',
  'in',
  'at',
  'a',
  'an',
  'or',
  'inc',
  'llc',
  'llp',
  'pllc',
  'corp',
  'pa',
  'pc',
  'ltd',
  'co',
  'group',
  'law',
  'firm',
  'office',
  'offices',
  'practice',
  'services',
  'service',
  'company',
  'agency',
  'associates',
]);

/** Escape regex metacharacters in a literal string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectSearchTerms(bt: BrandTruth): string[] {
  // The firm_name always passes through — it's the canonical identity, and
  // it'd be wrong to silently skip it on a length technicality.
  const firmName = bt.firm_name?.trim();
  const raw = [
    firmName,
    ...(bt.name_variants ?? []),
    ...(bt.common_misspellings ?? []),
  ];
  // Dedupe case-insensitive, drop empties, trim, skip too-ambiguous terms
  const seen = new Set<string>();
  const out: string[] = [];
  const skipped: string[] = [];
  for (const term of raw) {
    const trimmed = term?.trim();
    if (!trimmed) continue;
    // Floor: skip terms shorter than 4 chars unless it's the firm_name
    // itself (which the operator presumably can't change without renaming
    // their firm).
    if (trimmed !== firmName && trimmed.length < MIN_TERM_LENGTH) {
      skipped.push(trimmed);
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  if (skipped.length > 0) {
    console.warn(
      `[reddit:scan] skipped ${skipped.length} too-ambiguous search term(s) ` +
        `(< ${MIN_TERM_LENGTH} chars): ${skipped.join(', ')}. ` +
        `Add a longer variant in Brand Truth to capture mentions of these.`,
    );
  }
  return out;
}

/**
 * Pull every signal out of Brand Truth that proves a Reddit post is talking
 * about THIS firm rather than a coincidentally-named person/place/thing.
 * Returns a deduped, lowercased array of phrases ready to compile into
 * word-boundary regexes. Order doesn't matter — the gate only needs one to
 * match.
 *
 * Sources, in rough order of disambiguating power:
 *   1. Bare domain root from primary_url (very strong — links straight back
 *      to the firm's site).
 *   2. Attorney / provider / team-member last names — "Pickett" the
 *      attorney is a different signal from "Pickett" the search term, and
 *      requiring a NAME co-occurrence kills posts about General George
 *      Pickett or unrelated Picketts.
 *   3. Geography (city + state, full and abbreviated). A post mentioning
 *      "Bruni" AND "Long Island" or "NY" is overwhelmingly likely to be
 *      about Bruni & Campisi the Long Island plumbing company.
 *   4. Practice areas / service offerings. "personal injury" or "estate
 *      planning" alongside the firm name is a strong context match.
 *   5. Firm-name secondary tokens — for multi-token firm names like "Bruni
 *      & Campisi", we include both halves so when only "Bruni" is the
 *      matched term, "Campisi" can still satisfy the gate.
 *   6. Required positioning phrases (operator-curated marketing tags —
 *      sometimes things like "boutique law firm" or "Texas attorney" that
 *      operators add specifically because they expect them to co-occur
 *      with their name).
 *
 * Stopwords ('law', 'firm', 'group', 'inc', etc.) are stripped — they're
 * too generic to disambiguate anything.
 */
function buildContextKeywords(bt: BrandTruth): string[] {
  const out = new Set<string>();

  // 1) Domain root from primary_url ("brunicampisi" from
  //    "https://www.brunicampisi.com/about"). The bare token is way more
  //    distinctive than the firm's full marketing name and almost never
  //    appears outside of Reddit posts that are actually about the firm.
  if ('primary_url' in bt && bt.primary_url) {
    const root = extractDomainRoot(bt.primary_url);
    if (root && root.length >= MIN_CONTEXT_LENGTH) {
      out.add(root.toLowerCase());
    }
  }

  // 2) Person names — last token of each provider/attorney/team-member name.
  //    First names are too generic ("Andrew") so we pull the last token
  //    only ("Pickett"). We DO accept full names too (longer phrase = even
  //    more disambiguating).
  const peopleArrays: Array<Array<{ name?: string }>> = [];
  if ('attorney_bios' in bt && Array.isArray(bt.attorney_bios)) {
    peopleArrays.push(bt.attorney_bios as Array<{ name?: string }>);
  }
  if ('provider_bios' in bt && Array.isArray(bt.provider_bios)) {
    peopleArrays.push(bt.provider_bios as Array<{ name?: string }>);
  }
  if ('team_members' in bt && Array.isArray(bt.team_members)) {
    peopleArrays.push(bt.team_members as Array<{ name?: string }>);
  }
  for (const people of peopleArrays) {
    for (const person of people) {
      const name = person?.name?.trim();
      if (!name) continue;
      const tokens = name.split(/\s+/).filter(Boolean);
      // Last name (most disambiguating single token)
      const lastToken = tokens[tokens.length - 1];
      if (
        lastToken &&
        lastToken.length >= MIN_CONTEXT_LENGTH &&
        !CONTEXT_STOPWORDS.has(lastToken.toLowerCase())
      ) {
        out.add(lastToken.toLowerCase());
      }
      // Full name (rare but extremely disambiguating when present)
      if (tokens.length > 1 && name.length >= MIN_CONTEXT_LENGTH) {
        out.add(name.toLowerCase());
      }
    }
  }

  // 3) Geography — city, state full, state abbreviation, and country if
  //    non-default.
  if ('headquarters' in bt && bt.headquarters) {
    addLocationKeywords(out, bt.headquarters);
  }
  if ('geographies_served' in bt && Array.isArray(bt.geographies_served)) {
    for (const geo of bt.geographies_served) {
      if (geo?.city && geo.city.length >= MIN_CONTEXT_LENGTH) {
        out.add(geo.city.toLowerCase());
      }
      if (geo?.state && geo.state.length >= 2) {
        // Always include the literal state value (could be abbreviation OR
        // full name — schema accepts 2-3 chars for `state`).
        out.add(geo.state.toLowerCase());
      }
    }
  }
  if ('service_areas' in bt && Array.isArray(bt.service_areas)) {
    for (const area of bt.service_areas) {
      if (typeof area === 'string' && area.trim().length >= MIN_CONTEXT_LENGTH) {
        out.add(area.trim().toLowerCase());
      }
    }
  }

  // 4) Practice areas / service offerings.
  if ('practice_areas' in bt && Array.isArray(bt.practice_areas)) {
    for (const area of bt.practice_areas) {
      if (typeof area === 'string' && area.trim().length >= MIN_CONTEXT_LENGTH) {
        out.add(area.trim().toLowerCase());
      }
    }
  }
  if ('service_offerings' in bt && Array.isArray(bt.service_offerings)) {
    for (const offering of bt.service_offerings) {
      const name = offering?.name?.trim();
      if (name && name.length >= MIN_CONTEXT_LENGTH) {
        out.add(name.toLowerCase());
      }
    }
  }

  // 5) Firm-name secondary tokens. Skip stopwords + the firm-name string
  //    itself (already a search term, doesn't help as context).
  if (bt.firm_name) {
    const firmTokens = bt.firm_name
      .split(/[\s&/,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (firmTokens.length >= 2) {
      for (const token of firmTokens) {
        if (
          token.length >= MIN_CONTEXT_LENGTH &&
          !CONTEXT_STOPWORDS.has(token.toLowerCase())
        ) {
          out.add(token.toLowerCase());
        }
      }
    }
  }

  // 6) Required positioning phrases — operator-curated, treat as gold.
  if (Array.isArray(bt.required_positioning_phrases)) {
    for (const phrase of bt.required_positioning_phrases) {
      if (typeof phrase === 'string' && phrase.trim().length >= MIN_CONTEXT_LENGTH) {
        out.add(phrase.trim().toLowerCase());
      }
    }
  }

  return Array.from(out);
}

function addLocationKeywords(
  set: Set<string>,
  loc: { city?: string; region?: string; country?: string },
): void {
  if (loc.city && loc.city.length >= MIN_CONTEXT_LENGTH) {
    set.add(loc.city.toLowerCase());
  }
  if (loc.region && loc.region.length >= 2) {
    set.add(loc.region.toLowerCase());
  }
  // Skip `country` for the default 'US' — billions of posts mention 'US'
  // and it adds no signal. Non-default country codes (GB, AU) are kept.
  if (loc.country && loc.country !== 'US' && loc.country.length >= 2) {
    set.add(loc.country.toLowerCase());
  }
}

/**
 * Extract the bare middle token of a URL — the part between protocol/www
 * and the TLD. Examples:
 *   https://www.brunicampisi.com/about → "brunicampisi"
 *   https://andrewpickettlaw.com       → "andrewpickettlaw"
 *   http://my-firm.co.uk/contact       → "my-firm"  (returns first label)
 * Returns null on malformed input rather than throwing — the relevance
 * gate just won't have this signal.
 */
function extractDomainRoot(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    let host = url.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    const parts = host.split('.');
    // For "brunicampisi.com" → ["brunicampisi", "com"] → take "brunicampisi".
    // For "subdomain.example.com" → ["subdomain", "example", "com"] → take
    // "example" (the registrable apex). Cheap heuristic: take the second-
    // to-last label if there are ≥3 parts, else the first label. Doesn't
    // handle every public suffix but is correct for ~all firm domains.
    if (parts.length >= 3) {
      return parts[parts.length - 2] ?? null;
    }
    return parts[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a candidate post is actually about the firm.
 *
 * Returns `{accept: true, reason: 'multi-term'}` when the post matched ≥2
 * distinct search terms (very strong co-occurrence signal — e.g., a post
 * mentioning both "Bruni" and "Campisi"). These are auto-accepted with no
 * context check.
 *
 * Returns `{accept: true, reason: 'permissive'}` when context is empty —
 * preferred to silently dropping every match. Logged at scan-start so
 * operators can populate their Brand Truth.
 *
 * Returns `{accept: true, reason: 'context-match'}` when at least one
 * context keyword (excluding the matched term itself) word-boundary
 * matches in title+selftext.
 *
 * Returns `{accept: false}` otherwise — the post mentioned the firm name
 * but no other corroborating signal, so it's almost certainly a name
 * collision (Bruni the cookbook author, Pickett the historical figure).
 */
function evaluateRelevance(
  post: RedditPost,
  matchedTerms: string[],
  contextKeywords: string[],
  isContextEmpty: boolean,
): { accept: true; reason: 'multi-term' | 'context-match' | 'permissive' } | { accept: false } {
  if (matchedTerms.length >= 2) {
    return { accept: true, reason: 'multi-term' };
  }

  if (isContextEmpty) {
    return { accept: true, reason: 'permissive' };
  }

  const matchedLower = new Set(matchedTerms.map((t) => t.toLowerCase()));
  const haystack = `${post.title}\n${post.selftext}`;

  for (const keyword of contextKeywords) {
    // Don't let a keyword satisfy the gate if it IS the matched term —
    // that'd be circular (the term match alone, which we already know
    // happened, can't also be the context signal).
    if (matchedLower.has(keyword)) continue;

    const pattern = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i');
    if (pattern.test(haystack)) {
      return { accept: true, reason: 'context-match' };
    }
  }

  return { accept: false };
}

/**
 * Pick the most specific term to record on the mention row when multiple
 * matched. Heuristic: longest term. "Bruni & Campisi" beats "Bruni"; "law
 * firm" beats "law" (though the latter shouldn't be a search term anyway
 * because of MIN_TERM_LENGTH).
 */
function pickPrimaryTerm(matched: string[]): string {
  if (matched.length === 0) return '';
  if (matched.length === 1) return matched[0]!;
  return matched.reduce((best, candidate) =>
    candidate.length > best.length ? candidate : best,
  );
}
