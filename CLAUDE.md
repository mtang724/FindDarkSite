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
- **EOG programmatic download is blocked** — use `scanner/viirs/browser-login.mjs` (Playwright),
  not password-grant. See DEPLOYMENT.md §4.
- Secrets live in gitignored files only (`eog.local`, `scanner/viirs/cache/`); never log/commit them.

## Architecture quick map

- `src/finder.js` — multi-stage search: dark seeds → cluster → POI/elevation/weather/driving enrichment.
- `src/lightPollution.js`, `src/poiSearch.js`, `src/utils.js` — data + geo/conversion helpers.
- `scanner/viirs/` — `build-cache.mjs` (clip raster → cache), `scan-raster.mjs` (`--source viirs|worldatlas`,
  `--bbox` or `--lat/--lng/--radius`), `convert.mjs` (brightness→SQM), `raster-cache.mjs`, `grid.mjs`, `scan-store.mjs`.
