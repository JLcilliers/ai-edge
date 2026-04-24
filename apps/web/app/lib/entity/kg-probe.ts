/**
 * Knowledge-graph probe (PLAN §5.6 items 2-3).
 *
 * Checks whether the firm exists as a recognizable ENTITY in the two
 * graphs LLMs lean on most:
 *   - Wikidata (free, stable URIs, feeds Wikipedia + many LLM training sets)
 *   - Google Knowledge Graph Search API (backs the Knowledge Panel; behind
 *     a free-tier API key that we may or may not have configured)
 *
 * Absence from these graphs doesn't just hurt Google SERPs — it correlates
 * directly with LLMs hallucinating or refusing to answer "tell me about
 * $FIRM" questions. That's the signal we're surfacing here.
 *
 * We do NOT:
 *   - Claim or edit Wikidata entries. That's a manual editorial process;
 *     the output here is "go do it yourself via wikidata.org/new".
 *   - Attempt to disambiguate homonyms perfectly. If a firm name has 3+
 *     Wikidata hits, we show them all and let the operator pick.
 */

export interface KgEntityHit {
  id: string;
  label: string;
  description: string | null;
  url: string; // canonical public URL for the entity
}

export interface KgProbeResult {
  source: 'wikidata' | 'google-kg';
  query: string;
  hits: KgEntityHit[];
  error: string | null;
}

/**
 * Wikidata action API: wbsearchentities. Free, no key needed.
 * https://www.wikidata.org/wiki/Wikidata:Data_access
 *
 * Returns up to 5 candidates. We defer any scoring / ranking to the UI —
 * a hit with a matching label + a description mentioning the firm's city
 * is the clear winner, but that's a judgement call best left to the operator.
 */
export async function probeWikidata(query: string): Promise<KgProbeResult> {
  const url = `https://www.wikidata.org/w/api.php?${new URLSearchParams({
    action: 'wbsearchentities',
    format: 'json',
    language: 'en',
    search: query,
    limit: '5',
    origin: '*',
  })}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'ai-edge-entity-scan/0.1 (contact: admin@aiedge.local)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      return {
        source: 'wikidata',
        query,
        hits: [],
        error: `wikidata returned ${res.status}`,
      };
    }
    const json = (await res.json()) as {
      search?: Array<{ id: string; label: string; description?: string; concepturi?: string }>;
    };
    const hits: KgEntityHit[] =
      json.search?.map((h) => ({
        id: h.id,
        label: h.label,
        description: h.description ?? null,
        url: h.concepturi ?? `https://www.wikidata.org/wiki/${h.id}`,
      })) ?? [];

    return { source: 'wikidata', query, hits, error: null };
  } catch (err) {
    return {
      source: 'wikidata',
      query,
      hits: [],
      error: String(err),
    };
  }
}

/**
 * Google Knowledge Graph Search API. Requires `GOOGLE_KG_API_KEY` env.
 * Docs: https://developers.google.com/knowledge-graph
 *
 * We keep this optional — if the key isn't configured the probe returns
 * a "skipped" marker rather than failing. That lets us deploy the module
 * to firms where GCP billing isn't set up yet.
 */
export async function probeGoogleKg(query: string): Promise<KgProbeResult> {
  const apiKey = process.env.GOOGLE_KG_API_KEY;
  if (!apiKey) {
    return {
      source: 'google-kg',
      query,
      hits: [],
      error: 'GOOGLE_KG_API_KEY not configured — skipped',
    };
  }

  const url = `https://kgsearch.googleapis.com/v1/entities:search?${new URLSearchParams({
    query,
    key: apiKey,
    limit: '5',
    indent: 'true',
  })}`;

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return {
        source: 'google-kg',
        query,
        hits: [],
        error: `google-kg returned ${res.status}`,
      };
    }
    const json = (await res.json()) as {
      itemListElement?: Array<{
        result?: {
          '@id'?: string;
          name?: string;
          description?: string;
          url?: string;
          detailedDescription?: { url?: string };
        };
      }>;
    };
    const hits: KgEntityHit[] =
      json.itemListElement
        ?.map((e) => {
          const r = e.result;
          if (!r) return null;
          return {
            id: r['@id'] ?? '',
            label: r.name ?? '',
            description: r.description ?? null,
            url: r.url ?? r.detailedDescription?.url ?? '',
          };
        })
        .filter((x): x is KgEntityHit => x !== null && !!x.label) ?? [];

    return { source: 'google-kg', query, hits, error: null };
  } catch (err) {
    return {
      source: 'google-kg',
      query,
      hits: [],
      error: String(err),
    };
  }
}
