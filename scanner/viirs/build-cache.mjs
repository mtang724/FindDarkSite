/**
 * Clip a global GeoTIFF to a CONUS Float32 cache (header + bin).
 * Usage:
 *   node --max-old-space-size=2048 scanner/viirs/build-cache.mjs --in <file.tif> --out <basename>
 * Defaults (VIIRS): auto-find a *.tif containing "VNL", --out viirs_conus_2023.
 * World Atlas:  --in World_Atlas_2015.tif --out worldatlas_conus_2015
 */
import { createWriteStream, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fromFile } from 'geotiff';
import { writeHeader } from './raster-cache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');

const CONUS = { minLng: -125, maxLng: -66.5, minLat: 24, maxLat: 50 };
const BAND_ROWS = 256;

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const inName = args.in || readdirSync(CACHE_DIR).find(n => n.endsWith('.tif') && n.includes('VNL'));
  if (!inName) throw new Error('No input .tif. Pass --in <file.tif>.');
  const outBase = args.out || 'viirs_conus_2023';
  const layer = args.layer || (outBase.includes('worldatlas') ? 'WorldAtlas_2015' : 'VIIRS_2023_VNL_v22');
  const source = args.source || (outBase.includes('worldatlas') ? 'Falchi World Atlas 2015 (mcd/m2)' : 'EOG average_masked');
  const quantity = outBase.includes('worldatlas') ? 'brightness_mcd' : 'radiance';

  const inPath = path.isAbsolute(inName) ? inName : path.join(CACHE_DIR, inName);
  const tiff = await fromFile(inPath);
  const img = await tiff.getImage();
  const [west, south, east, north] = img.getBoundingBox();
  const W = img.getWidth(), H = img.getHeight();
  const resLng = (east - west) / W;
  const resLat = (north - south) / H;
  const gdalNoData = img.getGDALNoData();

  const x0 = Math.max(0, Math.round((CONUS.minLng - west) / resLng));
  const x1 = Math.min(W, Math.round((CONUS.maxLng - west) / resLng));
  const y0 = Math.max(0, Math.round((north - CONUS.maxLat) / resLat));
  const y1 = Math.min(H, Math.round((north - CONUS.minLat) / resLat));
  const width = x1 - x0, height = y1 - y0;

  const header = {
    minLng: west + x0 * resLng, maxLng: west + x1 * resLng,
    minLat: north - y1 * resLat, maxLat: north - y0 * resLat,
    width, height, pixelDegLng: resLng, pixelDegLat: resLat,
    noData: gdalNoData != null ? Number(gdalNoData) : -1,
    quantity, layer, source,
  };
  writeHeader(path.join(CACHE_DIR, outBase + '.json'), header);
  console.log('input:', inName, '| global', W + 'x' + H, '| noData', header.noData);
  console.log('CONUS window:', width, 'x', height, 'cells | bbox',
    header.minLng.toFixed(3), header.minLat.toFixed(3), header.maxLng.toFixed(3), header.maxLat.toFixed(3));

  const out = createWriteStream(path.join(CACHE_DIR, outBase + '.bin'));
  for (let by = y0; by < y1; by += BAND_ROWS) {
    const bandEnd = Math.min(y1, by + BAND_ROWS);
    const rasters = await img.readRasters({ window: [x0, by, x1, bandEnd], samples: [0] });
    const band = rasters[0];
    const f32 = band instanceof Float32Array ? band : Float32Array.from(band);
    if (!out.write(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength))) {
      await new Promise(r => out.once('drain', r));
    }
    console.log(`rows ${by - y0}..${bandEnd - y0} / ${height}`);
  }
  await new Promise(r => out.end(r));
  console.log('Cache written:', outBase, width, 'x', height, 'cells');
}

main().catch(e => { console.error(e.message); process.exit(1); });
