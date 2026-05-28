# Raster-backed Scanner (`scan-raster`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-point WMS scanning with local sampling of the VIIRS VNL V2.2 2023 raster, producing scan JSONs in the existing format so the web app is unchanged.

**Architecture:** Three stages under `scanner/viirs/`. One-time: `download.mjs` (OAuth → global GeoTIFF) and `build-cache.mjs` (clip CONUS → compact Float32 cache). Per-run: `scan-raster.mjs` samples the cache on a grid → `public/data/scan_<...>.json` + `index.json`.

**Tech Stack:** Node 22 (ESM), `geotiff.js` (pure-JS GeoTIFF reader), `node:test` for tests, reuse of `src/utils.js` for geo/conversion math.

**Spec:** [docs/superpowers/specs/2026-05-28-raster-backed-scanner-design.md](../specs/2026-05-28-raster-backed-scanner-design.md)

---

## Prerequisite (manual, no commit)

Before Task 2 can be verified end-to-end, the user must:
1. Register a free EOG account at https://eogdata.mines.edu (Sign Up).
2. Export credentials in the shell that runs the scripts:
   ```bash
   export EOG_USERNAME='you@example.com'
   export EOG_PASSWORD='...'
   ```
These are read from the environment only; never written to disk or committed.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `scanner/viirs/eog-auth.mjs` | Get an EOG OAuth access token from username/password |
| `scanner/viirs/download.mjs` | CLI: download the 2023 global average_masked GeoTIFF |
| `scanner/viirs/raster-cache.mjs` | Cache format: write/load header+bin; pure `sampleRadiance()` |
| `scanner/viirs/build-cache.mjs` | CLI: clip CONUS window from global TIFF → cache |
| `scanner/viirs/grid.mjs` | `generateBboxGridPoints()` for rectangular scans |
| `scanner/viirs/scan-store.mjs` | `writeScan()` + `rebuildIndex()` (ports `scan_grid.py`) |
| `scanner/viirs/scan-raster.mjs` | CLI orchestrator: parse args → sample → write scan |
| `tests/raster-cache.test.mjs` | Unit tests: `sampleRadiance` |
| `tests/grid.test.mjs` | Unit tests: `generateBboxGridPoints` |
| `tests/scan-store.test.mjs` | Unit tests: `rebuildIndex` |
| `.gitignore` | Ignore `scanner/viirs/cache/` |

Reused from `src/utils.js` (ESM, pure, Node-importable): `radianceToSqm`, `sqmToBortle`, `generateGridPoints`, `haversineDistance`.

---

## Task 1: Project scaffolding — dependency, gitignore, cache dir

**Files:**
- Modify: `package.json` (add `geotiff` dependency)
- Modify: `.gitignore`
- Create: `scanner/viirs/cache/.gitkeep`

- [ ] **Step 1: Install geotiff**

Run:
```bash
npm install geotiff@^2.1.3
```
Expected: `geotiff` appears under `dependencies` in `package.json`; `node_modules/geotiff` exists.

- [ ] **Step 2: Verify geotiff imports under Node 22**

Run:
```bash
node -e "import('geotiff').then(m => console.log('geotiff ok:', typeof m.fromFile))"
```
Expected: `geotiff ok: function`

- [ ] **Step 3: Ignore the cache dir**

Edit `.gitignore` — add under the existing "Scan data" block:
```
# VIIRS raster cache (multi-GB, never committed)
scanner/viirs/cache/
```

- [ ] **Step 4: Keep the cache dir present but empty**

Run:
```bash
mkdir -p scanner/viirs/cache && touch scanner/viirs/cache/.gitkeep
```
Note: `.gitkeep` is inside an ignored dir, so force-add it.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore
git add -f scanner/viirs/cache/.gitkeep
git commit -m "Add geotiff dep and VIIRS cache dir scaffolding"
```

---

## Task 2: EOG OAuth token module

**Files:**
- Create: `scanner/viirs/eog-auth.mjs`

EOG uses Keycloak password-grant. The historically documented client is `eogdata_oidc` /
secret `2677ad81-521b-4869-8480-6d05b9e57d48`. Their auth host is `eogauth.mines.edu`. We try the
current realm first and fall back to the legacy path; the verification step confirms which works.

- [ ] **Step 1: Write the auth module**

Create `scanner/viirs/eog-auth.mjs`:
```js
/**
 * Get an EOG OAuth access token via Keycloak password grant.
 * Reads EOG_USERNAME / EOG_PASSWORD from the environment.
 */

const CLIENT_ID = 'eogdata_oidc';
const CLIENT_SECRET = '2677ad81-521b-4869-8480-6d05b9e57d48';

// Candidate token endpoints (newer Keycloak drops the /auth prefix; realm migrated master→eog).
const TOKEN_URLS = [
  'https://eogauth.mines.edu/realms/master/protocol/openid-connect/token',
  'https://eogauth.mines.edu/auth/realms/master/protocol/openid-connect/token',
  'https://eogauth.mines.edu/realms/eog/protocol/openid-connect/token',
];

export async function getAccessToken(username = process.env.EOG_USERNAME, password = process.env.EOG_PASSWORD) {
  if (!username || !password) {
    throw new Error('Set EOG_USERNAME and EOG_PASSWORD in the environment (see plan prerequisite).');
  }
  const body = new URLSearchParams({
    username, password,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'password',
  });

  let lastErr;
  for (const url of TOKEN_URLS) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (resp.ok) {
        const json = await resp.json();
        if (json.access_token) return json.access_token;
        lastErr = new Error(`No access_token in response from ${url}`);
      } else {
        lastErr = new Error(`HTTP ${resp.status} from ${url}`);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `EOG auth failed against all known endpoints. Last error: ${lastErr?.message}. ` +
    `Check the current download instructions at https://eogdata.mines.edu/products/register/ ` +
    `and update CLIENT_ID/CLIENT_SECRET/TOKEN_URLS in eog-auth.mjs.`
  );
}
```

- [ ] **Step 2: Verify against the live endpoint (needs prerequisite creds)**

Run:
```bash
node -e "import('./scanner/viirs/eog-auth.mjs').then(m => m.getAccessToken()).then(t => console.log('token len:', t.length)).catch(e => { console.error(e.message); process.exit(1); })"
```
Expected: `token len: <a few hundred>`. If it fails with all endpoints, follow the error's instruction to update the client params, then re-run.

- [ ] **Step 3: Commit**

```bash
git add scanner/viirs/eog-auth.mjs
git commit -m "Add EOG OAuth token retrieval module"
```

---

## Task 3: Download the global GeoTIFF

**Files:**
- Create: `scanner/viirs/download.mjs`

The 2023 average_masked global file lives under
`https://eogdata.mines.edu/nighttime_light/annual/v22/2023/`. The exact filename is confirmed in
Step 1 (it encodes a processing timestamp). It is gzipped (`.tif.gz`).

- [ ] **Step 1: Find the exact filename**

Run (uses the token to list the dir):
```bash
node -e "
import('./scanner/viirs/eog-auth.mjs').then(async m => {
  const t = await m.getAccessToken();
  const r = await fetch('https://eogdata.mines.edu/nighttime_light/annual/v22/2023/', { headers: { Authorization: 'Bearer ' + t } });
  const html = await r.text();
  const files = [...html.matchAll(/href=\"([^\"]*average_masked[^\"]*\.tif\.gz)\"/g)].map(x => x[1]);
  console.log(files.join('\n'));
});
"
```
Expected: one or more lines ending in `average_masked.dat.tif.gz` (pick the `npp` or combined `npp-j01` global file). Record the filename.

- [ ] **Step 2: Write the downloader**

Create `scanner/viirs/download.mjs`:
```js
/**
 * Download the EOG VNL V2.2 2023 global average_masked GeoTIFF into the cache dir.
 * Usage: node scanner/viirs/download.mjs <filename.tif.gz>
 * Skips download if the gunzipped .tif already exists. Streams to disk; gunzips at the end.
 */
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getAccessToken } from './eog-auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');
const BASE = 'https://eogdata.mines.edu/nighttime_light/annual/v22/2023/';

async function main() {
  const filename = process.argv[2];
  if (!filename) {
    console.error('Usage: node scanner/viirs/download.mjs <filename.tif.gz>  (get it from download.mjs Step 1)');
    process.exit(1);
  }
  await mkdir(CACHE_DIR, { recursive: true });
  const tifPath = path.join(CACHE_DIR, filename.replace(/\.gz$/, ''));
  if (existsSync(tifPath) && statSync(tifPath).size > 0) {
    console.log('Already have', tifPath, '(' + statSync(tifPath).size + ' bytes) — skipping.');
    return;
  }

  const token = await getAccessToken();
  console.log('Downloading', BASE + filename, '...');
  const resp = await fetch(BASE + filename, { headers: { Authorization: 'Bearer ' + token } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading ${filename}`);

  // Stream response → gunzip → .tif on disk
  await pipeline(Readable.fromWeb(resp.body), createGunzip(), createWriteStream(tifPath));
  console.log('Wrote', tifPath, '(' + statSync(tifPath).size + ' bytes)');
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 3: Run the download (long — multi-GB)**

Run (substitute the filename from Step 1):
```bash
node scanner/viirs/download.mjs VNL_v22_npp-j01_2023_global_vcmslcfg_c<...>.average_masked.dat.tif.gz
```
Expected: progress, then `Wrote .../<...>.average_masked.dat.tif (<~12 GB> bytes)`. This file is gitignored.

- [ ] **Step 4: Sanity-check the file is a valid GeoTIFF**

Run:
```bash
node -e "
import('geotiff').then(async ({ fromFile }) => {
  const fs = await import('node:fs');
  const f = fs.readdirSync('scanner/viirs/cache').find(n => n.endsWith('.tif'));
  const tiff = await fromFile('scanner/viirs/cache/' + f);
  const img = await tiff.getImage();
  console.log('size:', img.getWidth(), 'x', img.getHeight());
  console.log('bbox:', img.getBoundingBox());
});
"
```
Expected: width ≈ 86400, height ≈ 33600; bbox ≈ `[-180, -65, 180, 75]`.

- [ ] **Step 5: Commit**

```bash
git add scanner/viirs/download.mjs
git commit -m "Add EOG global GeoTIFF downloader"
```

---

## Task 4: Raster cache format + `sampleRadiance` (TDD)

**Files:**
- Create: `scanner/viirs/raster-cache.mjs`
- Test: `tests/raster-cache.test.mjs`

Cache = a JSON header + a row-major Float32 `.bin`. Row 0 is the northernmost row (max latitude),
column 0 is the westernmost (min longitude), matching GeoTIFF NW origin.

- [ ] **Step 1: Write the failing test**

Create `tests/raster-cache.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleRadiance } from '../scanner/viirs/raster-cache.mjs';

// 4x4 grid, 1°/cell, covering lng 0..4, lat 0..4. data[0] = NW corner (lat 3-4, lng 0-1).
const header = {
  minLng: 0, maxLng: 4, minLat: 0, maxLat: 4,
  width: 4, height: 4, pixelDegLng: 1, pixelDegLat: 1, noData: -999,
};
const data = Float32Array.from([
  10, 11, 12, 13,   // row0: lat 3..4
  20, 21, 22, 23,   // row1: lat 2..3
  30, 31, 32, 33,   // row2: lat 1..2
  40, 41, 42, -50,  // row3: lat 0..1  (last cell negative → clamps to 0)
]);

test('samples NW corner', () => {
  assert.equal(sampleRadiance(header, data, 3.5, 0.5), 10);
});
test('samples interior cell', () => {
  assert.equal(sampleRadiance(header, data, 2.5, 2.5), 22);
});
test('clamps lat==minLat to last row', () => {
  assert.equal(sampleRadiance(header, data, 0.5, 2.5), 42);
});
test('negative radiance clamps to 0', () => {
  assert.equal(sampleRadiance(header, data, 0.5, 3.5), 0);
});
test('out-of-window returns null', () => {
  assert.equal(sampleRadiance(header, data, 5, 1), null);
  assert.equal(sampleRadiance(header, data, 1, -1), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/raster-cache.test.mjs`
Expected: FAIL — `sampleRadiance` not exported / module not found.

- [ ] **Step 3: Write the implementation**

Create `scanner/viirs/raster-cache.mjs`:
```js
/**
 * VIIRS CONUS cache: JSON header + row-major Float32 .bin (NW origin).
 */
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Sample radiance at (lat,lng). Returns:
 *   - null if outside the cache window
 *   - radiance >= 0 otherwise (noData / negatives clamped to 0)
 */
export function sampleRadiance(header, data, lat, lng) {
  if (lng < header.minLng || lng > header.maxLng || lat < header.minLat || lat > header.maxLat) {
    return null;
  }
  let col = Math.floor((lng - header.minLng) / header.pixelDegLng);
  let row = Math.floor((header.maxLat - lat) / header.pixelDegLat);
  if (col >= header.width) col = header.width - 1;
  if (row >= header.height) row = header.height - 1;
  if (col < 0) col = 0;
  if (row < 0) row = 0;
  const v = data[row * header.width + col];
  if (v == null || Number.isNaN(v) || v <= header.noData || v < 0) return 0;
  return v;
}

export function loadCache(headerPath, binPath) {
  const header = JSON.parse(readFileSync(headerPath, 'utf8'));
  const buf = readFileSync(binPath);
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return { header, data };
}

export function writeHeader(headerPath, header) {
  writeFileSync(headerPath, JSON.stringify(header, null, 2));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/raster-cache.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scanner/viirs/raster-cache.mjs tests/raster-cache.test.mjs
git commit -m "Add raster cache format and sampleRadiance (TDD)"
```

---

## Task 5: Build the CONUS cache from the global TIFF

**Files:**
- Create: `scanner/viirs/build-cache.mjs`

Reads the CONUS window in latitude **bands** to bound memory, streaming Float32 to the `.bin`.
CONUS window: `lng −125..−66.5`, `lat 24..50`.

- [ ] **Step 1: Write the cache builder**

Create `scanner/viirs/build-cache.mjs`:
```js
/**
 * Clip the global VNL GeoTIFF to a CONUS Float32 cache (header + bin).
 * Usage: node --max-old-space-size=2048 scanner/viirs/build-cache.mjs
 */
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fromFile } from 'geotiff';
import { writeHeader } from './raster-cache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');

const CONUS = { minLng: -125, maxLng: -66.5, minLat: 24, maxLat: 50 };
const BAND_ROWS = 256;

async function main() {
  const tifName = readdirSync(CACHE_DIR).find(n => n.endsWith('.tif'));
  if (!tifName) throw new Error('No .tif in cache dir — run download.mjs first.');
  const tiff = await fromFile(path.join(CACHE_DIR, tifName));
  const img = await tiff.getImage();
  const [west, south, east, north] = img.getBoundingBox();
  const W = img.getWidth(), H = img.getHeight();
  const resLng = (east - west) / W;
  const resLat = (north - south) / H;

  const x0 = Math.max(0, Math.round((CONUS.minLng - west) / resLng));
  const x1 = Math.min(W, Math.round((CONUS.maxLng - west) / resLng));
  const y0 = Math.max(0, Math.round((north - CONUS.maxLat) / resLat));
  const y1 = Math.min(H, Math.round((north - CONUS.minLat) / resLat));
  const width = x1 - x0, height = y1 - y0;

  const header = {
    minLng: west + x0 * resLng, maxLng: west + x1 * resLng,
    minLat: north - y1 * resLat, maxLat: north - y0 * resLat,
    width, height, pixelDegLng: resLng, pixelDegLat: resLat,
    noData: -1, layer: 'VIIRS_2023_VNL_v22', year: 2023, source: 'EOG average_masked',
  };
  writeHeader(path.join(CACHE_DIR, 'viirs_conus_2023.json'), header);

  const out = createWriteStream(path.join(CACHE_DIR, 'viirs_conus_2023.bin'));
  for (let by = y0; by < y1; by += BAND_ROWS) {
    const bandEnd = Math.min(y1, by + BAND_ROWS);
    const rasters = await img.readRasters({ window: [x0, by, x1, bandEnd], samples: [0] });
    const band = rasters[0]; // TypedArray, length = width * (bandEnd-by)
    const f32 = band instanceof Float32Array ? band : Float32Array.from(band);
    if (!out.write(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength))) {
      await new Promise(r => out.once('drain', r));
    }
    console.log(`rows ${by - y0}..${bandEnd - y0} / ${height}`);
  }
  await new Promise(r => out.end(r));
  console.log('Cache written:', width, 'x', height, 'cells');
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Build the cache**

Run:
```bash
node --max-old-space-size=2048 scanner/viirs/build-cache.mjs
```
Expected: band progress lines, then `Cache written: ~14040 x ~6240 cells`. `viirs_conus_2023.bin` ≈ ~350 MB.

- [ ] **Step 3: Spot-check known coordinates against expectation**

Run:
```bash
node -e "
import('./scanner/viirs/raster-cache.mjs').then(({ loadCache, sampleRadiance }) => {
  const { header, data } = loadCache('scanner/viirs/cache/viirs_conus_2023.json', 'scanner/viirs/cache/viirs_conus_2023.bin');
  for (const [name, lat, lng] of [['San Jose downtown', 37.3382, -121.8863], ['remote NV', 38.5, -116.5]]) {
    console.log(name, '→ radiance', sampleRadiance(header, data, lat, lng));
  }
});
"
```
Expected: San Jose radiance high (tens+); remote Nevada radiance ~0–small. (These become Bortle 9 and Bortle 1–2 respectively after conversion.)

- [ ] **Step 4: Commit** (cache files are gitignored; only the script is committed)

```bash
git add scanner/viirs/build-cache.mjs
git commit -m "Add CONUS cache builder (band-streamed clip of global TIFF)"
```

---

## Task 6: Bbox grid generator (TDD)

**Files:**
- Create: `scanner/viirs/grid.mjs`
- Test: `tests/grid.test.mjs`

Circular scans reuse `generateGridPoints` from `src/utils.js`. This adds the rectangular generator
for `--bbox` national scans, using the same lat/lng step math (no circle filter).

- [ ] **Step 1: Write the failing test**

Create `tests/grid.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBboxGridPoints } from '../scanner/viirs/grid.mjs';

test('covers the bbox corners and stays inside it', () => {
  const pts = generateBboxGridPoints(-100, 30, -99, 31, 50); // ~1° box, 50km step
  assert.ok(pts.length >= 4, 'has several points');
  for (const p of pts) {
    assert.ok(p.lat >= 30 && p.lat <= 31.0001, 'lat in range');
    assert.ok(p.lng >= -100 && p.lng <= -99.0001, 'lng in range');
  }
});

test('finer step yields more points', () => {
  const coarse = generateBboxGridPoints(-100, 30, -98, 32, 50);
  const fine = generateBboxGridPoints(-100, 30, -98, 32, 25);
  assert.ok(fine.length > coarse.length);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/grid.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `scanner/viirs/grid.mjs`:
```js
/** Rectangular grid generator for bbox (national/regional) scans. */
const EARTH_RADIUS_KM = 6371;
const toDeg = (rad) => rad * 180 / Math.PI;
const toRad = (deg) => deg * Math.PI / 180;

export function generateBboxGridPoints(minLng, minLat, maxLng, maxLat, stepKm) {
  const points = [];
  const latStep = toDeg(stepKm / EARTH_RADIUS_KM);
  for (let lat = minLat; lat <= maxLat; lat += latStep) {
    const cosLat = Math.cos(toRad(lat));
    if (cosLat <= 0) continue;
    const lngStep = toDeg(stepKm / (EARTH_RADIUS_KM * cosLat));
    for (let lng = minLng; lng <= maxLng; lng += lngStep) {
      points.push({
        lat: Math.round(lat * 100000) / 100000,
        lng: Math.round(lng * 100000) / 100000,
      });
    }
  }
  return points;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/grid.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scanner/viirs/grid.mjs tests/grid.test.mjs
git commit -m "Add bbox grid generator for national scans (TDD)"
```

---

## Task 7: Scan store — write scan JSON + rebuild index (TDD)

**Files:**
- Create: `scanner/viirs/scan-store.mjs`
- Test: `tests/scan-store.test.mjs`

Ports `save_results` + `rebuild_index` from [scanner/scan_grid.py](../../../scanner/scan_grid.py)
so output and `index.json` exactly match the existing scanner's behavior.

- [ ] **Step 1: Write the failing test**

Create `tests/scan-store.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rebuildIndex } from '../scanner/viirs/scan-store.mjs';

test('rebuildIndex lists scan_*.json with their metadata', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scanidx-'));
  try {
    writeFileSync(path.join(dir, 'scan_a.json'), JSON.stringify({
      metadata: { centerLat: 37, centerLng: -121, radiusKm: 200, stepKm: 5, layer: 'VIIRS_2023_VNL_v22', lastUpdated: '2026-05-28T00:00:00Z', totalPoints: 10, validPoints: 9 },
      results: [],
    }));
    writeFileSync(path.join(dir, 'index.json'), '{}'); // must be ignored by the rebuild
    rebuildIndex(dir);
    const idx = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(idx.scans.length, 1);
    assert.equal(idx.scans[0].filename, 'scan_a.json');
    assert.equal(idx.scans[0].centerLat, 37);
    assert.equal(idx.scans[0].validPoints, 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/scan-store.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `scanner/viirs/scan-store.mjs`:
```js
/** Write scan JSON and rebuild public/data/index.json — mirrors scan_grid.py. */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function rebuildIndex(dataDir) {
  const scans = [];
  for (const name of readdirSync(dataDir).sort()) {
    if (name === 'index.json' || !name.endsWith('.json')) continue;
    let meta;
    try {
      meta = JSON.parse(readFileSync(path.join(dataDir, name), 'utf8')).metadata || {};
    } catch { continue; }
    scans.push({
      filename: name,
      centerLat: meta.centerLat, centerLng: meta.centerLng,
      radiusKm: meta.radiusKm, stepKm: meta.stepKm, layer: meta.layer,
      lastUpdated: meta.lastUpdated, totalPoints: meta.totalPoints, validPoints: meta.validPoints,
    });
  }
  writeFileSync(path.join(dataDir, 'index.json'), JSON.stringify({ scans }, null, 2));
}

export function writeScan(outputFile, metadata, results, publicDataDir) {
  const validPoints = results.filter(r => r.sqm > 0).length;
  const data = {
    metadata: { ...metadata, lastUpdated: new Date().toISOString(), totalPoints: results.length, validPoints },
    results,
  };
  mkdirSync(path.dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(data, null, 2));
  if (publicDataDir && path.resolve(path.dirname(outputFile)) === path.resolve(publicDataDir)) {
    rebuildIndex(publicDataDir);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/scan-store.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add scanner/viirs/scan-store.mjs tests/scan-store.test.mjs
git commit -m "Add scan-store: write scan JSON + rebuild index (TDD)"
```

---

## Task 8: `scan-raster.mjs` CLI orchestrator

**Files:**
- Create: `scanner/viirs/scan-raster.mjs`

Ties it together: parse args → load cache → generate grid (circular or `--bbox`) → sample → convert
→ write scan. Reuses `generateGridPoints`, `radianceToSqm`, `sqmToBortle` from `src/utils.js`.

- [ ] **Step 1: Write the CLI**

Create `scanner/viirs/scan-raster.mjs`:
```js
/**
 * Raster-backed scanner. Samples the local CONUS cache (no network).
 * Circular:  node scanner/viirs/scan-raster.mjs --lat 37.37 --lng -121.88 --radius 200 --step 5
 * National:  node scanner/viirs/scan-raster.mjs --bbox -125,24,-66.5,50 --step 5
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadCache, sampleRadiance } from './raster-cache.mjs';
import { generateBboxGridPoints } from './grid.mjs';
import { writeScan } from './scan-store.mjs';
import { generateGridPoints, radianceToSqm, sqmToBortle } from '../../src/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');
const PUBLIC_DATA = path.join(__dirname, '..', '..', 'public', 'data');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    a[k] = argv[i + 1]; i++;
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv);
  let header, data;
  try {
    ({ header, data } = loadCache(
      path.join(CACHE_DIR, 'viirs_conus_2023.json'),
      path.join(CACHE_DIR, 'viirs_conus_2023.bin'),
    ));
  } catch {
    console.error('Cache missing. Run:\n  node scanner/viirs/download.mjs <file>\n  node --max-old-space-size=2048 scanner/viirs/build-cache.mjs');
    process.exit(1);
  }

  const step = parseFloat(a.step ?? '5');
  let points, metadata, defaultName;

  if (a.bbox) {
    const [minLng, minLat, maxLng, maxLat] = a.bbox.split(',').map(Number);
    points = generateBboxGridPoints(minLng, minLat, maxLng, maxLat, step);
    metadata = { bbox: [minLng, minLat, maxLng, maxLat], stepKm: step, layer: header.layer, source: header.source, startedAt: new Date().toISOString() };
    defaultName = `scan_bbox_${minLng}_${minLat}_${maxLng}_${maxLat}_${step}km.json`;
  } else {
    const lat = parseFloat(a.lat), lng = parseFloat(a.lng), radius = parseFloat(a.radius ?? '200');
    if (Number.isNaN(lat) || Number.isNaN(lng)) { console.error('Need --lat and --lng (or --bbox)'); process.exit(1); }
    points = generateGridPoints(lat, lng, radius, step);
    metadata = { centerLat: lat, centerLng: lng, radiusKm: radius, stepKm: step, layer: header.layer, source: header.source, startedAt: new Date().toISOString() };
    defaultName = `scan_${lat}_${lng}_${radius.toFixed(0)}km.json`;
  }

  const results = points.map(({ lat, lng }) => {
    const radiance = sampleRadiance(header, data, lat, lng);
    if (radiance == null) return { lat, lng, radiance: -1, sqm: -1, bortle: -1 };
    const sqm = radianceToSqm(radiance);
    return { lat, lng, radiance, sqm, bortle: sqmToBortle(sqm) };
  });

  const outputFile = a.output || path.join(PUBLIC_DATA, defaultName);
  writeScan(outputFile, metadata, results, PUBLIC_DATA);

  const valid = results.filter(r => r.sqm > 0);
  console.log(`Wrote ${outputFile}`);
  console.log(`Points: ${results.length} | Valid: ${valid.length}`);
  if (valid.length) {
    const sqms = valid.map(r => r.sqm).sort((x, y) => y - x);
    console.log(`SQM best ${sqms[0]} (Bortle ${sqmToBortle(sqms[0])}) | worst ${sqms[sqms.length - 1]}`);
  }
}

main();
```

- [ ] **Step 2: Regenerate the San Jose scan from the raster**

Run:
```bash
node scanner/viirs/scan-raster.mjs --lat 37.3704 --lng -121.8784 --radius 200 --step 5 --output /tmp/sj_raster.json
```
Expected (within seconds): `Points: ~5015 | Valid: ~5012` and a sensible SQM line. (Outputs to /tmp so it doesn't clobber the committed WMS scan during verification.)

- [ ] **Step 3: Compare against the existing WMS scan (parity check)**

Run:
```bash
node -e "
import('node:fs').then(({ readFileSync }) => {
  const a = JSON.parse(readFileSync('public/data/scan_37.3704_-121.8784_200km.json'));
  const b = JSON.parse(readFileSync('/tmp/sj_raster.json'));
  const map = new Map(b.results.map(r => [r.lat + ',' + r.lng, r]));
  let same = 0, near = 0, n = 0;
  for (const r of a.results) {
    if (r.sqm <= 0) continue;
    const m = map.get(r.lat + ',' + r.lng); if (!m || m.sqm <= 0) continue;
    n++; const d = Math.abs(r.bortle - m.bortle);
    if (d === 0) same++; if (d <= 1) near++;
  }
  console.log('compared', n, '| same Bortle', (100*same/n).toFixed(1)+'%', '| within ±1', (100*near/n).toFixed(1)+'%');
});
"
```
Expected: "within ±1" should be high (≈ 90%+). The radiance source differs, so exact matches won't be 100%; large divergence (e.g. <60% within ±1) means a bug — investigate the row/col orientation in `sampleRadiance`/`build-cache`.

- [ ] **Step 4: Run the full test suite**

Run: `node --test tests/raster-cache.test.mjs tests/grid.test.mjs tests/scan-store.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scanner/viirs/scan-raster.mjs
git commit -m "Add scan-raster CLI orchestrator"
```

---

## Task 9: Generate the national CONUS scan (5 km)

**Files:**
- Create (generated): `public/data/scan_bbox_-125_24_-66.5_50_5km.json`

- [ ] **Step 1: Generate the national scan**

Run:
```bash
node --max-old-space-size=2048 scanner/viirs/scan-raster.mjs --bbox -125,24,-66.5,50 --step 5
```
Expected (seconds–minutes): `Points: ~600k | Valid: ~...` and the file written to `public/data/`. Note: the bbox is a rectangle (includes ocean/Canada/Mexico, all in-window so all "valid"), so the file is large (~80 MB). Confirm this size is acceptable before committing it in Step 4 — an 80 MB JSON noticeably bloats the git repo, and an alternative is to keep it gitignored or ship a coarser overview.

- [ ] **Step 2: Confirm it loads and parses**

Run:
```bash
node -e "import('node:fs').then(({ readFileSync }) => { const d = readFileSync('public/data/scan_bbox_-125_24_-66.5_50_5km.json','utf8'); const j = JSON.parse(d); console.log('size MB', (d.length/1e6).toFixed(1), '| points', j.results.length, '| valid', j.metadata.validPoints); });"
```
Expected: size and point counts print without error.

- [ ] **Step 3: Verify it appears in the web app picker**

Run `npm install` (for `suncalc` from the earlier pull) then `npm run dev`, open http://localhost:5173, and confirm the new `scan_bbox_...` entry is listed in the "Pre-computed Scan" dropdown (served via `index.json`). Pick it, search a US location, confirm results render.

- [ ] **Step 4: Commit** (confirm size is acceptable before committing a large JSON)

```bash
git add public/data/scan_bbox_-125_24_-66.5_50_5km.json public/data/index.json
git commit -m "Add national CONUS 5km light-pollution scan (raster-sampled)"
```

---

## Self-Review notes

- **Spec coverage:** download (Task 3) ✓, CONUS cache (Tasks 4–5) ✓, scan-raster circular+bbox (Tasks 6–8) ✓, schema-compatible output + index (Task 7) ✓, real-radiance accuracy (Task 8 uses `radianceToSqm` on raw radiance) ✓, national 5 km (Task 9) ✓, security/gitignore (Task 1) ✓.
- **Sampling decision:** nearest-cell, implemented in `sampleRadiance` (Task 4), matching the resolved spec decision.
- **Type consistency:** `sampleRadiance(header, data, lat, lng)`, `loadCache(headerPath, binPath) → {header, data}`, `writeScan(outputFile, metadata, results, publicDataDir)`, `rebuildIndex(dataDir)`, `generateBboxGridPoints(minLng, minLat, maxLng, maxLat, stepKm)` — used identically across Tasks 4–9.
- **Risk (auth params):** handled in Task 2 via multi-endpoint fallback + actionable error.
- **Risk (giant TIFF memory):** handled in Task 5 via band-streamed reads.
