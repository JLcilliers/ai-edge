# Playwright AIO Worker

Reference implementation of the AI Overview panel scraper used as
Phase B #7's fallback when DataForSEO can't (or shouldn't) be the
primary AIO source. Lives outside the Vercel runtime per ADR-0010
because Playwright + bot detection is a poor fit for a serverless
function.

This service is intentionally **separate from the main app**. It runs
on its own host (Fly.io recommended), exposes a tiny HTTP surface,
and is called by the Vercel-side `PlaywrightAioProvider` when the
operator sets `PLAYWRIGHT_AIO_WORKER_URL` + `PLAYWRIGHT_AIO_WORKER_SECRET`.

## What it does

- Accepts `POST /capture-aio` with `{ query, country, language }`
- Loads `https://www.google.com/search?q=...` in headless Chromium
- Detects Google's AI Overview panel; extracts prose + cited source URLs
- Returns `{ ok, has_aio, overview_text, sources, error? }`

## What it deliberately doesn't do

- **Bypass CAPTCHA.** Hard CAPTCHA = `has_aio: false`. Operators see
  an honest empty row in the dashboard rather than a fabricated overview.
- **Maintain Google selectors automatically.** Google rewrites the AIO
  DOM regularly; expect to update the `[data-mfe-name="ai_overview"]`
  fallback chain a couple of times a year.
- **Run in the Vercel build.** Playwright deps are too heavy + the
  proxy chain doesn't fit Fluid Compute's egress constraints.

## Endpoints

```
GET  /health                                            (no auth)
POST /capture-aio   Authorization: Bearer <secret>
                    Body: { "query": "...", "country": "us", "language": "en" }
```

## Required env

| Var | Purpose |
|---|---|
| `WORKER_SHARED_SECRET` | Match Vercel's `PLAYWRIGHT_AIO_WORKER_SECRET` |
| `BRIGHT_DATA_PROXY_URL` | Residential proxy URL (recommended for production) |
| `PORT` | Default `8080` |
| `HEADLESS` | `true` in production; `false` for local debugging |

## Local development

```bash
cd infra/playwright-aio-worker
npm install
WORKER_SHARED_SECRET=devsecret HEADLESS=false node server.js
# Hit it:
curl -s http://localhost:8080/capture-aio \
     -H "Authorization: Bearer devsecret" \
     -H "Content-Type: application/json" \
     -d '{"query":"personal injury lawyer melbourne fl","country":"us","language":"en"}' | jq
```

## Deploying on Fly.io

```bash
cp fly.toml.example fly.toml
# edit `app = ...` to a unique name
fly launch --no-deploy
fly secrets set WORKER_SHARED_SECRET="$(openssl rand -hex 32)"
fly secrets set BRIGHT_DATA_PROXY_URL="http://customer-...:pwd@brd.superproxy.io:33335"
fly deploy

# On Vercel (Production env):
vercel env add PLAYWRIGHT_AIO_WORKER_URL    # e.g. https://clixsy-aio-worker.fly.dev
vercel env add PLAYWRIGHT_AIO_WORKER_SECRET # the value from `fly secrets set` above
```

After redeploying the Vercel app, hit the **AI Overviews** tab → click
**Capture now**. The capture row should land with provider=`playwright`.

## Why a Bright Data residential proxy

Without one, Google flags the worker IP within a handful of queries
and starts serving CAPTCHA-walled responses. Residential proxies
rotate IP per session, geolocate to where real users live, and don't
trigger the same heuristics. ADR-0010 picked Bright Data; any
equivalent residential pool (Smartproxy, Oxylabs, Webshare) works
identically — the env var is just a proxy URL.

## Selector maintenance

When Google rewrites AIO and selectors stop matching, edit the
`captureAioOnce()` function in `server.js`. The current chain:

1. `[data-mfe-name="ai_overview"]` (most stable historically)
2. `div[aria-label*="AI overview"]` (accessibility hook fallback)
3. text-locator below "AI Overview" header

If all three miss, the worker returns `has_aio: false` — never
fabricates content. The visibility tab will show "0 AIO triggers"
across recent days, which is the operator's signal to refresh
selectors.

## Pricing

- Fly.io shared-cpu-2x + 2GB: ~$5/month at idle (auto-stops)
- Bright Data residential pool: $500-$1500/month for typical agency
  volume
- Per-capture cost: ~10-30 seconds of compute + 1-3 IP rotations

## Why not just use DataForSEO

DataForSEO is the primary; this Playwright path is the **fallback**.
Use it when:

- DataForSEO regresses on a specific query type and you need a
  ground-truth check
- You need access to AIO outputs in a market or language DataForSEO
  doesn't yet cover
- You're spot-checking DataForSEO's output for a contract review

Day-to-day operations should stay on DataForSEO.
