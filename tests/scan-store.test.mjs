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
