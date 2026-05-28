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
    console.error('Cache missing. Build it first:\n  node scanner/viirs/browser-login.mjs\n  (download the .tif.gz, gunzip into scanner/viirs/cache/)\n  node --max-old-space-size=2048 scanner/viirs/build-cache.mjs');
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
