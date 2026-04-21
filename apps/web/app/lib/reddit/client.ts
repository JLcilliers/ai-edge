/**
 * Reddit search client — sparior/reddit3 on RapidAPI.
 *
 * Why RapidAPI instead of PRAW (legacy PLAN.md §5.4 plan): no OAuth dance,
 * no USER_AGENT wrangling, commercial rate limits handled by the
 * subscription. One key, one host header.
 *
 * Endpoint confirmed working:
 *   GET /v1/reddit/search?search=<q>&filter=posts&timeFilter=<w>&sortType=<s>
 * See https://rapidapi.com/sparior/api/reddit3/playground
 */
const BASE_URL = 'https://reddit3.p.rapidapi.com';

export type RedditTimeFilter = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
export type RedditSortType = 'relevance' | 'new' | 'hot' | 'top' | 'comments';
export type RedditFilter = 'posts' | 'comments';

export type RedditPost = {
  /** Post thing id (e.g. `t3_1k6w8hb`) */
  name: string;
  /** Clean id without the `t3_` prefix */
  id: string;
  subreddit: string;
  title: string;
  /** Post body text (may be empty for link posts) */
  selftext: string;
  author: string;
  score: number;
  num_comments: number;
  /** Unix seconds */
  created_utc: number;
  /** Reddit permalink path (prepend https://reddit.com) */
  permalink: string;
  /** Full https://reddit.com URL */
  url: string;
  upvote_ratio: number | null;
};

type SearchParams = {
  query: string;
  subreddit?: string;
  timeFilter?: RedditTimeFilter;
  sortType?: RedditSortType;
  filter?: RedditFilter;
};

type Reddit3SearchResponse = {
  meta: { status: number; search?: string; cursor?: string };
  body: Array<{
    name?: string;
    subreddit?: string;
    title?: string;
    selftext?: string;
    author?: string;
    score?: number;
    num_comments?: number;
    created_utc?: number;
    permalink?: string;
    url?: string;
    upvote_ratio?: number;
  }>;
};

function getApiKey(): string {
  const key = process.env.RAPIDAPI_REDDIT_KEY;
  if (!key) {
    throw new Error('RAPIDAPI_REDDIT_KEY is not set — see .env.example');
  }
  return key;
}

function getHost(): string {
  return process.env.RAPIDAPI_REDDIT_HOST ?? 'reddit3.p.rapidapi.com';
}

function buildPermalinkUrl(permalink: string): string {
  if (!permalink) return '';
  if (permalink.startsWith('http')) return permalink;
  return `https://reddit.com${permalink.startsWith('/') ? '' : '/'}${permalink}`;
}

function normalize(raw: Reddit3SearchResponse['body'][number]): RedditPost | null {
  if (!raw.name || !raw.permalink) return null;
  const id = raw.name.startsWith('t3_') ? raw.name.slice(3) : raw.name;
  return {
    name: raw.name,
    id,
    subreddit: raw.subreddit ?? '',
    title: raw.title ?? '',
    selftext: raw.selftext ?? '',
    author: raw.author ?? '',
    score: raw.score ?? 0,
    num_comments: raw.num_comments ?? 0,
    created_utc: raw.created_utc ?? 0,
    permalink: raw.permalink,
    url: raw.url && raw.url.startsWith('http') ? raw.url : buildPermalinkUrl(raw.permalink),
    upvote_ratio: raw.upvote_ratio ?? null,
  };
}

/**
 * Search Reddit posts via the RapidAPI `/v1/reddit/search` endpoint.
 *
 * @example
 * await searchReddit({ query: 'clixsy', timeFilter: 'month' })
 */
export async function searchReddit(params: SearchParams): Promise<RedditPost[]> {
  const url = new URL(`${BASE_URL}/v1/reddit/search`);
  url.searchParams.set('search', params.query);
  url.searchParams.set('filter', params.filter ?? 'posts');
  url.searchParams.set('timeFilter', params.timeFilter ?? 'month');
  url.searchParams.set('sortType', params.sortType ?? 'relevance');
  if (params.subreddit) url.searchParams.set('subreddit', params.subreddit);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'x-rapidapi-host': getHost(),
      'x-rapidapi-key': getApiKey(),
      accept: 'application/json',
    },
    // Never cache Reddit search — we always want fresh results.
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Reddit search failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as Reddit3SearchResponse;
  if (!Array.isArray(json.body)) return [];

  return json.body
    .map(normalize)
    .filter((p): p is RedditPost => p !== null);
}
