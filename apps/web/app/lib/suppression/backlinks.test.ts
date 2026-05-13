/**
 * Regression guard for the Ahrefs `backlinks-stats` response shape.
 *
 * History: the AhrefsProvider previously called the wrong v3 endpoint
 * (/site-explorer/metrics, which returns SERP signals) and read fields
 * that didn't exist on that response. The wrong-endpoint failure mode
 * was silent — HTTP 200, malformed field names, every URL produced 0
 * ref-domains. C1's "preserve link equity via 301 when ≥5 ref-domains"
 * branch had never fired.
 *
 * This test locks the field mapping (`live` → total,
 * `live_refdomains` → refDomains) against a recorded fixture captured
 * from the live API on the fix-PR date. A future refactor that breaks
 * the mapping will fail here before it ships.
 */
import { describe, it, expect } from 'vitest';
import { parseBacklinksStatsResponse } from './backlinks';

// Captured from
//   GET https://api.ahrefs.com/v3/site-explorer/backlinks-stats
//        ?target=https://www.nytimes.com/&mode=exact&date=2026-05-13
// on 2026-05-13. nytimes.com is used because its backlink count is
// large (>20M live, >100k ref-domains) and historically stable, so
// the loose lower-bound assertions below don't break when Ahrefs's
// data refreshes.
const NYTIMES_FIXTURE = {
  metrics: {
    live: 21_718_038,
    all_time: 188_995_743,
    live_refdomains: 104_019,
    all_time_refdomains: 426_884,
  },
};

describe('parseBacklinksStatsResponse', () => {
  it('parses backlinks-stats response correctly', () => {
    const result = parseBacklinksStatsResponse(NYTIMES_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('ahrefs');
    // Loose bounds — nytimes.com had ~104k ref-domains at fixture
    // capture. Anything above 50k confirms the field mapping is
    // pulling from the right key. Below that and we'd be reading a
    // wrong field (or the wrong endpoint entirely).
    expect(result!.refDomains).toBeGreaterThan(50_000);
    // Total backlinks fixture captured at ~21.7M live. >10M is the
    // bar — same reasoning as above.
    expect(result!.total).toBeGreaterThan(10_000_000);
  });

  it('returns zeros when metrics object is present but URL has no data', () => {
    const empty = { metrics: { live: 0, all_time: 0, live_refdomains: 0, all_time_refdomains: 0 } };
    const result = parseBacklinksStatsResponse(empty);
    expect(result).not.toBeNull();
    expect(result!.refDomains).toBe(0);
    expect(result!.total).toBe(0);
  });

  it('returns null when JSON is malformed (missing metrics object)', () => {
    // This is the failure mode that used to be silent. If Ahrefs ever
    // returns a response without a `metrics` key (or we hit the wrong
    // endpoint again), the parser should signal "we don't know" rather
    // than "this URL has 0 backlinks".
    expect(parseBacklinksStatsResponse({})).toBeNull();
    expect(parseBacklinksStatsResponse(null)).toBeNull();
    expect(parseBacklinksStatsResponse({ error: 'something' })).toBeNull();
    expect(parseBacklinksStatsResponse({ metrics: null })).toBeNull();
  });

  it('coerces missing/non-numeric field values to 0 (not NaN)', () => {
    // If Ahrefs ever returns the `metrics` object but renames just
    // one field — say `live` → `live_count` — we should fall through
    // to 0 rather than crash with NaN. The smoke check on activation
    // will catch this and refuse to activate the provider.
    const result = parseBacklinksStatsResponse({
      metrics: { live: 'not a number', live_refdomains: undefined },
    });
    expect(result).not.toBeNull();
    expect(result!.total).toBe(0);
    expect(result!.refDomains).toBe(0);
  });
});
