# CLAUDE.md — FindDarkSite

Dark-sky stargazing site finder. Vanilla JS + Vite frontend (Leaflet map); a Node scanner
(`scanner/viirs/`) generates light-pollution scan JSON that the app loads from `public/data/`.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (works out of the box — a VIIRS national scan is committed)
node --test tests/raster-cache.test.mjs tests/grid.test.mjs tests/scan-store.test.mjs tests/convert.test.mjs
```

## Setting up the light-pollution data on a new machine

Scans are generated locally from satellite rasters; the rasters/caches are gitignored.
**For full setup — including the World Atlas data that distinguishes Bortle 1/2/3 — follow
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).** It is step-by-step and self-contained.

## Hard constraints (do not violate)

- **World Atlas data is license-restricted** (Falchi 2016 — no redistribution/commercial use).
  World-Atlas-derived scans are gitignored (`public/data/*worldatlas*.json`); **never commit or
  push them**, and never commit the local `public/data/index.json` change that lists a `worldatlas`
  scan. Keep that data local only. VIIRS-derived scans are fine to commit.
- **Deploying: use `npm run build:deploy`, never plain `npm run build`.** `vite build` copies all of
  `public/` into `dist/`, so a local World Atlas scan would land in `dist/` and get published.
  `scripts/build-deploy.mjs` scrubs World Atlas from `dist/data/`, strips it from the index, fails
  if any survives, and gzips the big scans. The distributable **Sky-glow** layer
  (`*_skyglow.json`, derived from VIIRS+GLOBE) ships the Bortle 1/2/3 gradation publicly. Full
  runbook: [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).
- **EOG programmatic download is blocked** — use `scanner/viirs/browser-login.mjs` (Playwright),
  not password-grant. See DEPLOYMENT.md §4.
- Secrets live in gitignored files only (`eog.local`, `reddit.local`, `scanner/viirs/cache/`,
  `scripts/.cache/`); never log/commit them. Reddit scrape intermediates (`scripts/.cache/reddit-raw*.json`,
  `reddit-extracted.json`, `chrome-profile/`, `reddit-session.json`) stay local — only the final
  `public/data/reddit-locations.json` is committed.

## Architecture quick map

- `src/finder.js` — multi-stage search: dark seeds → cluster → POI/elevation/weather/driving enrichment.
- `src/lightPollution.js`, `src/poiSearch.js`, `src/utils.js` — data + geo/conversion helpers.
- `scanner/viirs/` — `build-cache.mjs` (clip raster → cache), `scan-raster.mjs` (`--source viirs|worldatlas`,
  `--bbox` or `--lat/--lng/--radius`), `convert.mjs` (brightness→SQM), `raster-cache.mjs`, `grid.mjs`, `scan-store.mjs`.

## Reddit community-locations pipeline (`scripts/`)

Crowd-sourced dark-sky spots mined from city-subreddit posts, shown as an overlay
(`src/redditLocations.js` loads `public/data/reddit-locations.json`; used in `src/scoring.js`).
Stages, in order:

1. **Login (once)** — `reddit-login-manual.mjs`: real Chrome (`channel:'chrome'`) + persistent
   profile (`scripts/.cache/chrome-profile/`) to defeat Reddit's JS-challenge. Sign in by hand
   (CAPTCHA/2FA ok); saves the profile + `reddit-session.json`. Re-run when the session expires.
   (`reddit-login.mjs` is the older headless/credential variant; stock Playwright Chromium gets
   challenged, so prefer the manual real-Chrome path.)
2. **Scrape** — `fetch-reddit-deep.mjs`: authenticated, headful, reuses that profile to scrape as
   the logged-in user (much more lenient). 85 metros × 6 queries + national subs (`t=all`), drills
   top posts → `scripts/.cache/reddit-raw-deep.json`. ~10–12 h, resume-safe, run overnight.
   (`fetch-reddit-stargazing.mjs` = older wide pass, `fetch-reddit-slow.mjs` = anonymous gap-filler.)
3. **Extract** — LLM pulls place names/sentiment from raw posts → `scripts/.cache/reddit-extracted.json`.
4. **Geocode** — two options:
   - `geocode-extracted-places.mjs` **rebuilds the whole** `reddit-locations.json` from
     `reddit-extracted.json` (Nominatim, state-scoped). Only run with an up-to-date extracted cache —
     a stale cache will overwrite good committed data.
   - `geocode-fill-missing.mjs` is **non-destructive**: reads the shippable file in place and only
     geocodes places still missing lat/lng (parenthetical-stripped + no-state fallbacks, since many
     Reddit dark-sky spots sit across a state line from the metro). Use this on a machine without
     the deep-scrape caches.
5. **Dedup** — `dedup-reddit-locations.mjs` (in place): merges same-metro duplicate pins (within
   1.5 km) and annotates spots recommended from several metros with `mentions` / `alsoRecommendedIn`
   (a cross-validation trust signal the scorer surfaces). Keeps each metro's copy so by-city lookup
   still works.

The scrape/extract caches are gitignored; only `public/data/reddit-locations.json` ships.
