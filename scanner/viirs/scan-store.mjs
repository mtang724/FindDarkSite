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
