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
