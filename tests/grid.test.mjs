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
