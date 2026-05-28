# Deployment & Setup (read me first on a fresh machine)

This guide gets FindDarkSite running on a new machine, including the **local-only
World Atlas light-pollution data** that distinguishes Bortle 1/2/3. It is written so an
agent (or human) can follow it top to bottom and end with a working app.

## TL;DR — the app runs out of the box

The repo already ships a **VIIRS national scan** (`public/data/scan_bbox_-125_24_-66.5_50_5km.json`),
so the app works immediately after install. World Atlas (finer dark-sky gradation) is an
**optional, local-only** add-on covered in section 3.

```bash
npm install
npm run dev          # open the printed http://localhost:5173 (or :5174)
```

Run the unit tests:
```bash
node --test tests/raster-cache.test.mjs tests/grid.test.mjs tests/scan-store.test.mjs tests/convert.test.mjs
# expect: 13 passing
```

## 1. Prerequisites

- **Node 20+** (developed on Node 22). `npm` available.
- Disk: ~1 GB free for the World Atlas path (section 3); ~15 GB if you also rebuild VIIRS (section 4).
- macOS/Linux. Commands below use `bash`/`zsh`.

## 2. Why data needs a setup step

Light-pollution scans are **generated locally** by `scanner/viirs/` from satellite rasters; the
multi-GB rasters and their caches are **gitignored** (`scanner/viirs/cache/`). The committed VIIRS
national scan is enough to run the app. To get **Bortle 1/2/3** gradation you regenerate from the
World Atlas raster (next section).

Pipeline: `download raster → build-cache.mjs (clip CONUS → Float32 cache) → scan-raster.mjs (sample → scan JSON)`.

## 3. World Atlas 2015 setup (Bortle 1/2/3) — recommended, no account needed

> **LICENSE — read this.** The Falchi World Atlas 2015 prohibits **redistribution and commercial
> use** (contact falchi@lightpollution.it for permissions). Therefore:
> - World-Atlas-derived scans are **gitignored** (`public/data/*worldatlas*.json`). **Never commit or
>   push them.** Keep them local only.
> - Do **not** commit the local `public/data/index.json` change that lists a `*worldatlas*` scan
>   (it would point clones at a file they don't have).
> - Any use must **cite** doi `10.5880/GFZ.1.4.2016.001` and Falchi et al. 2016, Science Advances 2(6):e1600377.
> - Do **not** flip the GitHub repo to a setup that publishes this data.

The World Atlas raster is an **open, no-auth** download:

```bash
cd scanner/viirs/cache
curl -L -o World_Atlas_2015.zip \
  "https://datapub.gfz.de/download/10.5880.GFZ.1.4.2016.001/World_Atlas_2015.zip"   # ~652 MB
unzip -o World_Atlas_2015.zip World_Atlas_2015.tif                                   # ~2.8 GB .tif
cd ../../..

# Clip CONUS → compact cache (writes scanner/viirs/cache/worldatlas_conus_2015.{bin,json})
node --max-old-space-size=2048 scanner/viirs/build-cache.mjs \
  --in World_Atlas_2015.tif --out worldatlas_conus_2015

# Generate the national scan from World Atlas (writes public/data/...worldatlas.json, gitignored,
# and updates the LOCAL public/data/index.json so the app's dropdown lists it)
node --max-old-space-size=2048 scanner/viirs/scan-raster.mjs \
  --source worldatlas --bbox -125,24,-66.5,50 --step 5

npm run dev
```

Expected: `build-cache` prints `CONUS window: 7020 x 3120 cells`; `scan-raster` prints
`Points: 596742 | Valid: ~596741`. In the app, pick the `worldatlas` scan in the "Pre-computed Scan"
dropdown and search any US location.

**Sanity check** (optional):
```bash
node -e "
Promise.all([import('./scanner/viirs/raster-cache.mjs'),import('./scanner/viirs/convert.mjs'),import('./src/utils.js')]).then(([rc,cv,u])=>{
  const {header,data}=rc.loadCache('scanner/viirs/cache/worldatlas_conus_2015.json','scanner/viirs/cache/worldatlas_conus_2015.bin');
  for (const [n,lat,lng] of [['NYC',40.7128,-74.006],['Great Basin NV',38.93,-114.3]]) {
    const b=rc.sampleRadiance(header,data,lat,lng); const s=cv.brightnessToSqm(b);
    console.log(n,'Bortle',u.sqmToBortle(s));   // expect NYC=9, Great Basin=1
  }
});"
```

**Regional scan instead of national:** `node scanner/viirs/scan-raster.mjs --source worldatlas --lat 37.37 --lng -121.88 --radius 200 --step 5`.

## 4. VIIRS setup (optional, distributable) — needs a free EOG account

Only needed if you want to regenerate raw-radiance VIIRS scans. The committed national VIIRS scan
already works, so most setups can skip this.

> EOG's programmatic download is **blocked** (since 2025-05-03 it needs a per-account OpenID client
> via eog@mines.edu). Do **not** waste time on password-grant against `eogdata_oidc`/`admin-cli`.
> We log in via the browser auth-code flow with Playwright instead.

```bash
npx playwright install chromium
# Put creds in a gitignored file (matched by *.local):
printf "export EOG_USERNAME='you@example.com'\nexport EOG_PASSWORD='...'\n" > eog.local
set -a; . ./eog.local; set +a

# Log in; this lists the 2023 filename and saves session cookies to cache/eog-cookies.json
node scanner/viirs/browser-login.mjs

# Download with the saved cookie (substitute the filename printed above), then gunzip:
cd scanner/viirs/cache
COOKIES=$(python3 -c "import json;print('; '.join(f\"{x['name']}={x['value']}\" for x in json.load(open('eog-cookies.json'))))")
FILE="VNL_npp_2023_global_vcmslcfg_v2_c202402081600.average_masked.dat.tif.gz"
curl -L -C - -H "Cookie: $COOKIES" -o "$FILE" \
  "https://eogdata.mines.edu/nighttime_light/annual/v22/2023/$FILE"
gunzip -kf "$FILE"
cd ../../..

node --max-old-space-size=2048 scanner/viirs/build-cache.mjs --in "$FILE" --out viirs_conus_2023   # use the .tif name
node scanner/viirs/scan-raster.mjs --lat 37.37 --lng -121.88 --radius 200 --step 5   # default source = viirs
```

## 5. What is and isn't in git

- **Committed (you get on clone):** all code, unit tests, the VIIRS national scan + the smaller
  regional scans, `public/data/index.json` (listing only committed scans).
- **Gitignored (regenerate locally):** `scanner/viirs/cache/` (rasters + caches, multi-GB),
  `public/data/*worldatlas*.json`, `eog.local` (credentials).
- After you generate a World Atlas scan, `public/data/index.json` shows as **modified** locally —
  that's expected; **leave it unstaged**.

## 6. Background / design docs

- Design spec: `docs/superpowers/specs/2026-05-28-raster-backed-scanner-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-28-raster-backed-scanner.md`
