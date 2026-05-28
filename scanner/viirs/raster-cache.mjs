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
