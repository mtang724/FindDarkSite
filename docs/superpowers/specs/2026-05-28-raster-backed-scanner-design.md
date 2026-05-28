# Raster-backed Scanner (`scan-raster`) — Design

**Date:** 2026-05-28
**Status:** Approved (pending spec review)

## Problem

The current scanners ([scan_grid.py](../../../scanner/scan_grid.py), `scan-grid.*js`) query
light pollution **one point at a time** via the lightpollutionmap.info GeoServer WMS
`GetFeatureInfo` endpoint, throttled to ~2 req/sec out of politeness.

This is fine for a single city/region (a 200 km / 5 km scan ≈ 5,000 points ≈ ~42 min — and
~1h28m in practice). It does **not** scale:

- Continental US at 5 km ≈ **773,000 points ≈ ~9 days** of continuous requests, ~108 MB JSON.
- Hammering a free community service with hundreds of thousands of requests is abusive and
  risks an IP ban.
- The WMS returns a *rendered* 0–255 pixel value, which the scanner converts to radiance via a
  fitted approximation ([pixelToRadiance](../../../src/utils.js)), losing accuracy.

## Goal

Replace the per-point HTTP scan with **local sampling of the authoritative VIIRS raster**, so
that generating a scan for any city/region/nation is local, instant, and uses no third-party
service at run time. Output stays schema-compatible with today's scan files so the web app is
untouched.

### Success criteria

- Generating a 200 km / 5 km scan takes **seconds**, not ~90 minutes.
- Output JSON is **schema-compatible** with the current scan format (the app reads only
  `lat`/`lng`/`sqm` per point) → the web app needs **zero changes**.
- A rectangular **national** (CONUS) scan can be produced on demand.
- Uses **real VIIRS radiance** (more accurate than the pixel approximation).
- No credentials or multi-GB data files are ever committed to git.

### Non-goals

- No change to the web app, its data-loading model, or the scan JSON schema.
- No in-browser raster reading (that was "Option C", explicitly deferred).
- No re-architecture of the app to load a single giant national file (rejected: a national file
  is either too coarse to be useful or too large for the browser to load).
- Alaska/Hawaii/territories are out of scope for v1 (CONUS only; VNL covers them but the cache
  window is CONUS).

## Data source

- **VIIRS VNL V2.2, 2023 annual composite, "average_masked" product** from the Earth Observation
  Group (Colorado School of Mines), `eogdata.mines.edu/products/vnl`. This is almost certainly
  the same dataset behind lightpollutionmap.info's "VIIRS_2023" layer.
- GeoTIFF, WGS84, **15 arc-sec (~500 m)** resolution, global extent −180..180 lng, −65..75 lat.
- Values are radiance in **nW/cm²/sr** — the same units assumed by the existing
  [radianceToSqm](../../../src/utils.js) formula, so it feeds in directly.
- The "average_masked" (median-masked) product strips ephemeral lights/auroras — the right choice
  for stable dark-sky assessment.
- **Download requires a free EOG account** (OAuth / Keycloak). Credentials supplied by the user.

## Architecture

Three stages. Stages 1–2 run **once**; stage 3 runs per scan.

```
download.mjs       OAuth to EOG → download global average_masked .tif.gz → cache dir
build-cache.mjs    clip the CONUS window → compact Float32 cache (.bin + .json header)
scan-raster.mjs    sample the cache on a grid → scan_<...>.json + rebuild index.json
```

All three live under `scanner/viirs/`. They depend on:
- `geotiff.js` (npm) — pure-JS GeoTIFF reader, no native GDAL build.
- `src/utils.js` — reuse `generateGridPoints`, `radianceToSqm`, `sqmToBortle`, `haversineDistance`
  rather than duplicating geo/conversion math.

### Component: `scanner/viirs/download.mjs`

- **Purpose:** authenticate to EOG and download the 2023 average_masked global GeoTIFF.
- **Interface:** `node scanner/viirs/download.mjs` — reads `EOG_USERNAME` / `EOG_PASSWORD` from
  env (or a gitignored `.env`). Writes `scanner/viirs/cache/VNL_v22_2023_average_masked.tif`
  (gunzipped). Skips download if the file already exists.
- **Auth:** OAuth password-grant against the EOG token endpoint to obtain a Bearer access token,
  then a normal authenticated GET. The exact realm/client_id/token-URL will be confirmed against
  current EOG docs during implementation (their auth was migrated recently).
- **Depends on:** network, EOG credentials, ~12 GB free disk for the uncompressed global file.

### Component: `scanner/viirs/build-cache.mjs`

- **Purpose:** clip the global raster to a CONUS window and store it in a fast, compact form so
  stage 3 needs no GeoTIFF parsing.
- **Interface:** `node scanner/viirs/build-cache.mjs` — reads the downloaded global TIFF, reads the
  CONUS bbox window (`lng −125..−66.5`, `lat 24..50`) via geotiff.js, writes:
  - `viirs_conus_2023.bin` — raw Float32 radiance grid, row-major.
  - `viirs_conus_2023.json` — header: `{ minLng, maxLng, minLat, maxLat, width, height, pixelDegLng, pixelDegLat, noData }`.
- **Memory:** CONUS at 15 arc-sec ≈ 6000 × 13944 ≈ 84 M cells ≈ ~334 MB Float32. Node may need
  `--max-old-space-size`. Acceptable for a one-time step.
- **Depends on:** the global TIFF from stage 1, geotiff.js.

### Component: `scanner/viirs/scan-raster.mjs`

- **Purpose:** the new scanner. Same UX as the old one, but samples the local cache.
- **Interface (drop-in with [scan_grid.py](../../../scanner/scan_grid.py)):**
  - `--lat --lng --radius --step --output` — circular scan around a center.
  - `--bbox minLng,minLat,maxLng,maxLat --step` — rectangular national/regional scan.
  - Defaults match the existing scanner (radius 200, step 5).
- **Behavior:**
  1. Load `viirs_conus_2023.{bin,json}` (mmap/Buffer).
  2. Generate grid points (`generateGridPoints` for circular; a bbox generator for `--bbox`).
  3. For each point, sample radiance from the cache (nearest-cell or bilinear — see Open question).
  4. `radiance → radianceToSqm → sqmToBortle`.
  5. Emit `{ metadata, results:[{lat,lng,radiance,sqm,bortle}] }` to `public/data/scan_<...>.json`
     and rebuild `public/data/index.json` (same behavior as the Python scanner).
- **Depends on:** the cache from stage 2, `src/utils.js`.

## Data flow

```
EOG ──(OAuth+GET)──▶ global .tif ──(clip CONUS)──▶ viirs_conus_2023.bin+.json
                                                          │
                                       grid points ──────▶ sample radiance
                                                          │
                                          radianceToSqm / sqmToBortle
                                                          │
                                         public/data/scan_<...>.json + index.json
                                                          │
                                              web app (unchanged) loads + filters
```

## Output schema (unchanged)

```json
{
  "metadata": { "centerLat", "centerLng", "radiusKm", "stepKm", "layer": "VIIRS_2023_VNL_v22",
                "source": "EOG average_masked", "startedAt", "lastUpdated",
                "totalPoints", "validPoints" },
  "results": [ { "lat", "lng", "radiance", "sqm", "bortle" } ]
}
```

`index.json` rebuild logic mirrors [scan_grid.py](../../../scanner/scan_grid.py)'s `rebuild_index`.
Note: the synthetic `pixel` field is dropped (the app never reads it; it used only `sqm`).

## Error handling

- **download.mjs:** fail loudly with a clear message if credentials are missing or auth fails
  (401/redirect to login). Resume/skip if the target file already exists and is non-empty.
- **build-cache.mjs:** validate the CONUS window is non-empty; treat raster noData / negatives as
  radiance 0 (→ SQM 22.0, consistent with the existing dark-clamp).
- **scan-raster.mjs:** if the cache is missing, print the exact `download`/`build-cache` commands to
  run first. Points outside the CONUS window → marked invalid (`sqm: -1`), excluded from `validPoints`.

## Testing

- **Unit:** sampler returns expected radiance for known cells (synthetic tiny cache fixture);
  bbox + circular grid generators produce expected point counts.
- **Conversion parity:** feed known radiances through `radianceToSqm`/`sqmToBortle`, assert against
  the Python scanner's values for the same inputs.
- **Ground-truth spot-check:** sample a few known coordinates (downtown San Jose ≈ Bortle 9;
  deep ocean / remote Nevada ≈ Bortle 1) and assert plausible SQM ranges. Cross-check a handful of
  points against the existing WMS scan we already have
  ([scan_37.3704_-121.8784_200km.json](../../../public/data/scan_37.3704_-121.8784_200km.json)) —
  expect the same Bortle class for most land points (radiance source differs, so allow ±1 class).
- **Smoke:** regenerate the San Jose 200 km / 5 km scan and confirm it loads in the web app and
  produces sensible results.

## Risks & fallbacks

| Risk | Mitigation |
|------|------------|
| geotiff.js struggles with the ~12 GB global striped TIFF | Fallback: `brew install gdal` + `gdal_translate -projwin` to clip CONUS, then read the small clip. |
| EOG auth params changed (realm/client_id) | Confirm against current EOG docs at implementation time; the password-grant flow is documented. |
| Node heap on the 334 MB cache | Run stages 2–3 with `--max-old-space-size=2048`; cache is read as a Buffer, not parsed JSON. |
| Native VNL radiance differs from the WMS pixel approximation | Expected and desirable (more accurate); tests allow ±1 Bortle class vs the old scan. |

## Security

- EOG credentials: env vars or a gitignored `.env`; never logged, never committed.
- Cache dir `scanner/viirs/cache/` added to `.gitignore` (multi-GB raster + cache).
- Generated `scan_*.json` continue to be committed (per the earlier `.gitignore` change).

## Resolved decisions

1. **Sampling:** nearest-cell for v1 (500 m raster ≫ 5 km grid, so interpolation buys little).
   Bilinear can be added later if needed.
2. **National file resolution:** **5 km** for now. A CONUS `--bbox` at 5 km ≈ 306 k land points
   ≈ ~40 MB JSON — heavy in-browser but loadable; acceptable for now. A coarser overview can be
   added later if load time becomes a problem.

## Addendum (2026-05-28): World Atlas 2015 source for Bortle 1/2/3

**Why:** VIIRS measures *upward emitted* radiance and the `average_masked` product floors at its
~0.25 nW detection limit, so all truly-dark skies collapse to Bortle 1 (no 2/3). Distinguishing the
darkest classes needs *modeled zenith sky brightness*, which is what the World Atlas (Falchi et al.
2016) provides — VIIRS DNB propagated through an atmospheric radiative-transfer model and calibrated
to ground SQM meters. This is the same product lightpollutionmap.info uses for its dark-end Bortle.

**Source:** `World_Atlas_2015.tif` from GFZ Data Services (doi 10.5880/GFZ.1.4.2016.001) — GeoTIFF,
30 arcsec (~1 km), EPSG:4326, **artificial** zenith brightness in **mcd/m²** (natural excluded),
noData ≈ −3.4e38. Free download, no auth.

**Conversion** (`scanner/viirs/convert.mjs` `brightnessToSqm`): add the natural background and convert
in magnitudes, using the same zero-point as `radianceToSqm` so "no light" → exactly 22.0:
`SQM = 22.0 − 2.5·log10(1 + artificial_mcd / 0.174)`, clamped [16,22]. Verified: NYC→Bortle 9,
San Jose→8, rural Kansas→2, Great Basin NV→1. National 5 km distribution becomes a smooth gradient
(B1 41% / B2 23% / B3 12% / B4 20% / …) vs the VIIRS cliff (B1 85%, no B2/B3).

**Integration:** `build-cache.mjs --in <tif> --out <basename>` is now source-agnostic; `scan-raster.mjs
--source viirs|worldatlas` picks the cache + converter. `sampleRadiance` noData handling generalized
(exact-equality + negatives → 0) to tolerate the World Atlas float-min noData.

**License (IMPORTANT):** The World Atlas README prohibits redistribution and commercial use
(contact Falchi for permissions). Therefore World-Atlas-derived scans are **gitignored**
(`public/data/*worldatlas*.json`) and kept **local only** — do not commit/push them. Only our own
code is committed. VIIRS-derived scans remain freely distributable.
