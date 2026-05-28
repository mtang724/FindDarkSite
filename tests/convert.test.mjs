import test from 'node:test';
import assert from 'node:assert/strict';
import { brightnessToSqm } from '../scanner/viirs/convert.mjs';
import { sqmToBortle } from '../src/utils.js';

test('no artificial light → SQM 22.0 (Bortle 1)', () => {
  assert.equal(brightnessToSqm(0), 22.0);
  assert.equal(sqmToBortle(brightnessToSqm(0)), 1);
});

test('faint glow gives Bortle 2/3 (the distinction VIIRS cannot make)', () => {
  assert.equal(sqmToBortle(brightnessToSqm(0.014)), 2);
  assert.equal(sqmToBortle(brightnessToSqm(0.05)), 3);
});

test('mid and bright levels map sensibly', () => {
  assert.equal(sqmToBortle(brightnessToSqm(1.0)), 5);
  assert.equal(sqmToBortle(brightnessToSqm(100)), 9);
});

test('monotonic: more artificial light → lower SQM', () => {
  const a = brightnessToSqm(0.1), b = brightnessToSqm(1), c = brightnessToSqm(10);
  assert.ok(a > b && b > c, `expected ${a} > ${b} > ${c}`);
});

test('clamps to [16, 22]', () => {
  assert.ok(brightnessToSqm(1e6) >= 16);
  assert.equal(brightnessToSqm(-5), 22.0);
});
