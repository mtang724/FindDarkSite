# 🌌 FindDarkSite — Dark Sky Site Finder

Find the best stargazing locations near you. FindDarkSite scans for areas with low light pollution using real VIIRS satellite data, then finds nearby campgrounds, parks, and attractions so you can plan your trip.

## Features

- **Real light pollution data** — Queries VIIRS 2023 satellite data from lightpollutionmap.info
- **SQM & Bortle ratings** — Every site shows sky quality (mag/arcsec²) and Bortle class (1–9)
- **Nearby POIs** — Finds campgrounds, parks, lodging & attractions via Google Places and Recreation.gov
- **Interactive dark map** — Leaflet map with Bortle-colored markers on a dark theme
- **Pre-computed scans** — Upload JSON scan files for instant results (no API wait)
- **Live API scanning** — Scan any area in real-time from the browser
- **Favorites** — Save and revisit your best dark sky spots
- **One-click navigation** — Links to Google Maps directions and satellite views

## Quick Start

```bash
# 1. Clone and install
git clone <your-repo-url>
cd FindDarkSite
npm install

# 2. Configure API keys
cp config.example.js config.js
# Edit config.js with your keys (see API Keys section below)

# 3. Run the dev server
npm run dev
```

Open http://localhost:5173 in your browser.

## API Keys

Create `config.js` from `config.example.js` and add your keys:

| Key | Required | Where to get it |
|-----|----------|-----------------|
| Google Maps API | For POI search | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) — enable "Places API (New)" |
| Recreation.gov RIDB | For federal campgrounds | [RIDB Registration](https://ridb.recreation.gov/docs) (free) |

> **Note:** The light pollution scanner works without any API keys.

## Grid Scanner

Pre-compute light pollution data for a region. The scanner queries VIIRS satellite data and saves results to a JSON file you can load in the web app.

### Python (recommended — zero dependencies)

```bash
# Scan 300km around San Jose at 5km resolution
python3 scanner/scan_grid.py --lat 37.37 --lng -121.88 --radius 300 --step 5

# Resume an interrupted scan
python3 scanner/scan_grid.py --resume scan_37.37_-121.88_300km.json
```

### Node.js

```bash
# CommonJS version (works on any Node.js, including old versions)
node scanner/scan-grid.cjs --lat 37.37 --lng -121.88 --radius 300 --step 5

# ESM version (requires Node 14+)
node scanner/scan-grid.js --lat 37.37 --lng -121.88 --radius 300 --step 5
```

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

After scanning, copy the JSON file to `public/data/` and select it in the web app's "Pre-computed Scan" mode.

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
- **Restrict your Google Maps API key** by HTTP referrer in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
- **Set a billing budget** on Google Cloud to prevent surprise charges
- For production, consider a backend proxy to keep API keys server-side

## Tech Stack

- **Frontend:** Vanilla JavaScript + Vite
- **Map:** Leaflet with CARTO Dark Matter tiles
- **Data:** VIIRS 2023 satellite radiance via lightpollutionmap.info GeoServer WMS
- **POIs:** Google Places API (New) + Recreation.gov RIDB API
- **Caching:** IndexedDB via idb-keyval

## License

MIT
