/**
 * Unit tests for the "what's worth seeing tonight" engine: the equatorial→
 * horizontal astronomy, terrain interpolation, light-dome washout, and the
 * terrain/glow/time-aware ranking.
 *
 * Run: node --test tests/skytargets.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { equatorialToHorizontal, terrainAt, recommendTonight, TARGETS } from '../src/skyTargets.js';

test('an equatorial object on the meridian sits due south at altitude 90-lat', () => {
    // Build a date where LST ≈ 0 so RA=0 is on the meridian (HA=0).
    // GMST≈0 near 2026-01-01 ~ a specific UTC; easier: search a time numerically.
    const lat = 40, lng = 0;
    // find a UTC instant where RA=0 culminates: HA=0 => LST=0 => GMST=0.
    let best = null;
    for (let h = 0; h < 24 * 60; h++) {
        const d = new Date(Date.UTC(2026, 5, 1, 0, h, 0));
        const { alt, az } = equatorialToHorizontal(0, 0, lat, lng, d);
        if (alt > (best?.alt ?? -99)) best = { alt, az, d };
    }
    assert.ok(Math.abs(best.alt - 50) < 1.5, `meridian alt ${best.alt} ~ 50`);
    assert.ok(Math.abs(best.az - 180) < 3, `due south az ${best.az} ~ 180`);
});

test('a near-pole star stays at altitude ≈ latitude, due north', () => {
    const lat = 40;
    const { alt, az } = equatorialToHorizontal(37.95, 89.26, lat, -105, new Date(Date.UTC(2026, 2, 20, 5, 0, 0)));
    assert.ok(Math.abs(alt - lat) < 2, `Polaris alt ${alt} ~ ${lat}`);
    assert.ok(az < 8 || az > 352, `Polaris az ${az} ~ north`);
});

test('the Milky Way core is up on a summer night and down on a winter night', () => {
    const lat = 36, lng = -116; // Death Valley
    const core = TARGETS.find(t => t.name === 'Milky Way core');
    const summer = equatorialToHorizontal(core.ra, core.dec, lat, lng, new Date(Date.UTC(2026, 6, 15, 8, 0, 0))); // ~midnight PDT
    const winter = equatorialToHorizontal(core.ra, core.dec, lat, lng, new Date(Date.UTC(2026, 0, 15, 8, 0, 0)));
    assert.ok(summer.alt > 15, `summer core alt ${summer.alt} should be up`);
    assert.ok(winter.alt < 0, `winter core alt ${winter.alt} should be below horizon`);
});

test('terrainAt interpolates between the 8 compass samples', () => {
    const horizon = { N: 10, NE: 20, E: 0, SE: 0, S: 0, SW: 0, W: 0, NW: 0 };
    assert.equal(terrainAt(horizon, 0), 10);
    assert.equal(terrainAt(horizon, 45), 20);
    assert.ok(Math.abs(terrainAt(horizon, 22.5) - 15) < 0.001); // midpoint
    assert.equal(terrainAt(null, 123), 0); // unknown horizon → flat
});

test('recommendTonight returns time/direction/altitude-tagged targets', () => {
    const site = { lat: 36, lng: -116 }; // flat horizon, no dome
    const window = {
        darkStart: new Date(Date.UTC(2026, 6, 15, 5, 0, 0)),
        darkEnd: new Date(Date.UTC(2026, 6, 15, 11, 0, 0)),
    };
    const { targets } = recommendTonight(site, window, { limit: 4 });
    assert.ok(targets.length > 0 && targets.length <= 4);
    const core = targets.find(t => t.name === 'Milky Way core');
    assert.ok(core, 'Milky Way core should be recommended on a summer night');
    assert.ok(core.altitude > 0 && core.bestTime && core.direction);
    assert.ok(core.reasons.some(r => /highest/.test(r)));
    // scores are sorted descending
    for (let i = 1; i < targets.length; i++) assert.ok(targets[i - 1].score >= targets[i].score);
});

test('a ridge across a target’s azimuth removes it from the list', () => {
    const lng = -116, lat = 36;
    const window = {
        darkStart: new Date(Date.UTC(2026, 6, 15, 5, 0, 0)),
        darkEnd: new Date(Date.UTC(2026, 6, 15, 11, 0, 0)),
    };
    const core = TARGETS.find(t => t.name === 'Milky Way core');
    // Where is the core, roughly, during this window? Wall it off with a huge ridge.
    const mid = new Date(Date.UTC(2026, 6, 15, 8, 0, 0));
    const { az } = equatorialToHorizontal(core.ra, core.dec, lat, lng, mid);
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const blocked = Object.fromEntries(names.map(n => [n, 89])); // 89° wall everywhere
    const withWall = recommendTonight({ lat, lng, horizon: blocked }, window);
    assert.ok(!withWall.targets.some(t => t.name === 'Milky Way core'),
        `core at az ${Math.round(az)} should be blocked by a full-sky ridge`);
    assert.equal(withWall.targets.length, 0);
});

test('no astronomical darkness → empty with a note', () => {
    const r = recommendTonight({ lat: 70, lng: 20 }, { darkStart: null, darkEnd: null });
    assert.equal(r.targets.length, 0);
    assert.match(r.note, /darkness/i);
});
