# CodeHound

Find working, publicly posted promo, bonus, sign-up, referral, lottery, and coupon codes for an app, game, or store. Type a name, or upload a screenshot of the redeem screen.

CodeHound reads codes that are already published. It does not guess, generate, brute-force, or submit codes to a brand's site or API, and it does not open login-only or private groups.

[![Buy Me a Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://buymeacoffee.com/anthonyleebuilds)

## Features

- Mobile-first installable web app (PWA), laid out for a phone width.
- Text search, plus a screenshot upload that asks Gemini Flash to name the brand, the kind of code the field wants, and any on-screen hint (for example social icons).
- Parallel Sherlock-style search with live per-source status over server-sent events: official help pages, public social posts and bios, Reddit via the Arctic Shift archive, coupon sites, general web search, and YouTube titles and descriptions.
- Works with no paid keys. Optional Gemini (vision, grounded URL discovery, verbatim extraction), Tavily, Brave, and Serper are used when their env vars are set.
- Regex extraction plus, when a Gemini key is present, a model pass that only keeps codes quoted verbatim in a fetched page.
- Dedupe and a visible score breakdown. The official bonus applies only when a source URL's registrable site name is the brand (freecash.com, help.freecash.com). A host that merely contains the name (freecashcodes.net) does not get it. Scoring reads the real page URL.
- Scam guard hides codes that promise an unrealistic cash bonus (about $100–$500), ask for a password, or come from a "code generator".
- Copy button, source links, placement note, a tap-to-expand score breakdown, Worked / Didn't work votes (one per device, switchable), a run log, a Freecash test run, and a local watchlist. New high-confidence watch hits can raise a browser notification without replacing the screen.
- Results with codes are cached per brand for 1–3 hours. An empty hunt is kept for at most 10 minutes, and a hunt where every source failed or was blocked is not cached. `DELETE /api/cache?q=Freecash` drops one brand.
- Official pages are fetched directly: the brand homepage, then /academy, /help, /support, /faq, and related paths. A help index that lists articles only inside page JSON is expanded into those article URLs. Search hits are kept only when the URL, title, or snippet mentions the brand. Reddit uses the Arctic Shift archive first (`arctic-shift.photon-reddit.com`, with `arctic-shift.com` tried before it) and falls back to Reddit JSON only when the archive returns no rows. A Reddit response that is HTML instead of JSON is marked blocked. Unauthenticated `r.jina.ai` requests return HTTP 401 from Render, so the reader is used only when `JINA_API_KEY` is set.
- `GET /api/debug/sources?q=Freecash` returns each source status plus the HTTP status, byte size, and route for every fetch. Add `?fresh=1` on `/api/search` to skip the cache.

## Environment variables

Copy `.env.example` to `.env`. All keys are optional.

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Screenshot reading, grounded public-URL discovery, and verbatim code extraction. |
| `GEMINI_MODEL` | Flash model id. Default `gemini-2.5-flash`. A 404 falls back to `gemini-2.0-flash`. |
| `BRAVE_API_KEY` | Optional Brave Search API. |
| `SERPER_API_KEY` | Optional Serper (Google) API. |
| `TAVILY_API_KEY` | Optional Tavily search. Tried before Brave and Serper. |
| `JINA_API_KEY` | Optional. Without it, blocked pages are not sent to r.jina.ai. |
| `SUPABASE_URL` | Optional shared vote and cache storage. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role for that project. Server-side only. |
| `CACHE_TTL_SECONDS` | Cache lifetime, clamped to 3600–10800. Default 7200. |
| `PORT` | HTTP port. Render sets this. Default 3000. |
| `DATA_DIR` | Local JSON store. Default `./data`. |

Votes and the cache live in `DATA_DIR/store.json`. On Render's free web service the disk is ephemeral, so that file resets on deploy or spin-down. To keep votes across restarts, create these tables and set the Supabase variables:

```sql
create table if not exists codehound_votes (
  brand text not null,
  code text not null,
  worked int not null default 0,
  failed int not null default 0,
  primary key (brand, code)
);

create table if not exists codehound_cache (
  brand text primary key,
  payload jsonb not null,
  cached_at timestamptz not null default now()
);
```

If Supabase is set but the tables are missing, CodeHound logs once and keeps using the local file.

Screenshot reading is the only feature that requires a key. Without `GEMINI_API_KEY` the upload responds with a clear error so you can type the name instead.

## Local run

```bash
npm ci
npm run build
npm start
```

Open `http://localhost:3000`. Health check: `http://localhost:3000/healthz`.

```bash
npm test
```

The test run includes a live hunt for Freecash and DoorDash, so it needs outbound network access.

## Render

`render.yaml` defines one free Node web service. It builds with `npm ci && npm run build`, starts with `npm start`, listens on `0.0.0.0:$PORT`, and uses `/healthz`.

In the Render dashboard, set `GEMINI_API_KEY` (and any other keys) as secret env vars. Do not commit them. Free web services spin down after a stretch of idle time; the next request starts the process again. The in-memory search throttle and the JSON file reset when that happens. The watchlist itself is in the browser's `localStorage`.

Web push is not included. A watched app gets an in-app "new" badge when a later hunt finds a high-confidence code that was not in the previous result.

## Limits

- Reddit often answers datacenter IPs with HTTP 403. That row shows as failed; other sources still run.
- DuckDuckGo HTML is a fallback and times out from some networks. Bing HTML is the default free search path.
- Coupon sites frequently mask codes behind a click (`SAVE…`). Masked prefixes are dropped. A code is kept when the full value is in the public HTML.
- Some promo pages are client-rendered and come back empty. Official help articles that are server-rendered work best.
- Confidence is a ranking signal from public evidence and votes, not a promise that a code still redeems.
- The app does not collect an account, a precise location, or a personal profile.

## Support

[Support CodeHound on Buy Me a Coffee](https://buymeacoffee.com/anthonyleebuilds).
