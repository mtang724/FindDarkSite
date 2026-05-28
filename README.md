# 🌌 FindDarkSite — Dark Sky Site Finder

Find the best stargazing locations near you. FindDarkSite scans for areas with low light pollution using real VIIRS satellite data, then finds nearby campgrounds, parks, and attractions so you can plan your trip.

## Features

- **Real light pollution data** — Queries VIIRS 2023 satellite data from lightpollutionmap.info
- **SQM & Bortle ratings** — Every site shows sky quality (mag/arcsec²) and Bortle class (1–9)
- **Nearby POIs** — Free, no-API-key search via OpenStreetMap (Overpass) + optional Recreation.gov campgrounds
- **Interactive dark map** — Leaflet map with Bortle-colored markers on a dark theme
- **Pre-computed scans** — Scanner publishes to `public/data/`; web app discovers them automatically
- **Live API scanning** — Scan any area in real-time from the browser (cancellable)
- **Favorites** — Save and revisit your best dark sky spots
- **One-click navigation** — Links to Google Maps directions and satellite views

## Quick Start

```bash
# 1. Clone and install
git clone <your-repo-url>
cd FindDarkSite
npm install

# 2. (Optional) configure RIDB key for richer US campground data
cp config.example.js config.js
# Edit config.js — RIDB key is free, everything else works without keys

# 3. Run the dev server
npm run dev
```

Open http://localhost:5173 in your browser.

## API Keys

| Key | Required | Where to get it |
|-----|----------|-----------------|
| OpenStreetMap Overpass | No key needed | Used automatically for POI search (campgrounds, parks, lodging, parking, attractions) |
| Recreation.gov RIDB | Optional | [RIDB Registration](https://ridb.recreation.gov/docs) — adds federal campground details |

> **No paid APIs.** POI search now uses the free Overpass API. The light pollution scanner needs no keys either.

## Grid Scanner

Pre-compute light pollution data for a region. The scanner queries VIIRS satellite data and **writes directly to `public/data/`** — when you reload the web app, the new scan appears in the "Pre-computed Scan" dropdown automatically. An `index.json` next to your scan files is regenerated on every save.

### Python (recommended — zero dependencies)

```bash
# Scan 300km around San Jose at 5km resolution → public/data/scan_37.37_-121.88_300km.json
python3 scanner/scan_grid.py --lat 37.37 --lng -121.88 --radius 300 --step 5

# Resume an interrupted scan
python3 scanner/scan_grid.py --resume public/data/scan_37.37_-121.88_300km.json
```

### Node.js

```bash
# CommonJS version (works on any Node.js, including old versions)
node scanner/scan-grid.cjs --lat 37.37 --lng -121.88 --radius 300 --step 5

# ESM version (requires Node 14+)
node scanner/scan-grid.js --lat 37.37 --lng -121.88 --radius 300 --step 5
```

Pass `--output` to write somewhere else; without it, scans land in `public/data/` automatically.

### Scanner Options

| Option | Default | Description |
|--------|---------|-------------|
| `--lat` | — | Center latitude (required) |
| `--lng` | — | Center longitude (required) |
| `--radius` | 200 | Search radius in km |
| `--step` | 5 | Grid resolution in km |
| `--output` | auto | Output JSON filename |
| `--resume` | — | Resume from existing JSON file |
| `--layer` | VIIRS_2023 | VIIRS data layer |
| `--delay` | 500ms / 0.5s | Delay between requests |

### Time Estimates

| Radius | Step | Points | Est. Time |
|--------|------|--------|-----------|
| 100 km | 5 km | ~1,250 | ~10 min |
| 200 km | 5 km | ~5,000 | ~42 min |
| 300 km | 5 km | ~11,300 | ~95 min |

Reload the web app — your scan appears in the "Pre-computed Scan" dropdown. No copy step needed.

## Project Structure

```
FindDarkSite/
├── index.html              # Main app page
├── style.css               # Full design system
├── config.example.js       # API key template
├── config.js               # Your API keys (gitignored)
├── vite.config.js          # Dev server + RIDB proxy
├── src/
│   ├── main.js             # App entry, UI, map, favorites
│   ├── finder.js           # Search orchestration
│   ├── lightPollution.js   # VIIRS radiance queries + caching
│   ├── poiSearch.js        # Google Places + Recreation.gov
│   └── utils.js            # Geo math, SQM/Bortle conversion
├── scanner/
│   ├── scan_grid.py        # Python grid scanner (zero deps)
│   ├── scan-grid.cjs       # Node.js scanner (CommonJS)
│   ├── scan-grid.js        # Node.js scanner (ESM)
│   └── generate-demo.js    # Demo data generator
└── public/
    └── data/               # Pre-computed scan JSON files
```

## Deployment

### Build for production

```bash
npm run build
# Output in dist/
```

### Security Notes

- **Never commit `config.js`** — it's in `.gitignore`
- For production, consider a backend proxy if you don't want the RIDB key shipped in client JS
- The Overpass and lightpollutionmap.info endpoints don't need keys; in production both will hit upstream directly (no Vite proxy), so be aware of CORS / browser limits

## Tech Stack

- **Frontend:** Vanilla JavaScript + Vite
- **Map:** Leaflet with CARTO Dark Matter tiles
- **Data:** VIIRS 2023 satellite radiance via lightpollutionmap.info GeoServer WMS (proxied through Vite in dev)
- **POIs:** Overpass API (OpenStreetMap) + optional Recreation.gov RIDB
- **Caching:** IndexedDB via idb-keyval

## License

MIT
