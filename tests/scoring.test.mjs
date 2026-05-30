/**
 * Unit tests for the per-(site, night) scorer — the product's core ranking
 * logic, previously untested. Covers the score contract, the hard gates
 * (military / unreachable), the real-darkness-window moon term, and the
 * light-dome reason pill.
 *
 * Run: node --test tests/scoring.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nightScore } from '../src/scoring.js';
import { moonInterferenceForNight } from '../src/astronomy.js';

// A genuinely good site on a great night: dark, high, remote, clear, new-moon-ish.
const GOOD_SITE = {
    lat: 38.0, lng: -114.0, sqm: 21.8,
    horizon: { maxAngle: 3 },
    nearestSettlementKm: 30, nearestResidentialKm: 20,
    driving: { durationSec: 45 * 60 },
    reachable: true,
};
const GREAT_NIGHT = {
    date: '2026-06-15', cloudCover: 5, precipProb: 0,
    seeing: 7, transparency: 7, dewMarginC: 9, windKph: 5,
};

test('score is an integer in 0..100 and matches its component sum', () => {
    const { score, components } = nightScore(GOOD_SITE, GREAT_NIGHT);
    assert.ok(Number.isInteger(score));
    assert.ok(score >= 0 && score <= 100, `score ${score} out of range`);
    const sum = Math.round(Object.values(components).reduce((a, b) => a + b, 0));
    assert.equal(score, sum);
});

test('a clear night scores higher than a clouded-over one, same site', () => {
    const clear = nightScore(GOOD_SITE, GREAT_NIGHT).score;
    const cloudy = nightScore(GOOD_SITE, { ...GREAT_NIGHT, cloudCover: 100, precipProb: 90 }).score;
    assert.ok(clear > cloudy, `clear ${clear} should beat cloudy ${cloudy}`);
});

test('inside a military zone forces community + remoteness components to 0', () => {
    const site = {
        ...GOOD_SITE, inMilitary: true,
        darkSkyPlace: { designation: 'sanctuary', distanceKm: 1, name: 'X' },
        nearestRedditSpot: { distanceKm: 1, sentiment: 'positive', subreddit: 'x', name: 'Y' },
        sqmReport: { sqm: 22.5 },
    };
    const { components } = nightScore(site, GREAT_NIGHT);
    assert.equal(components.remote, 0);
    assert.equal(components.ida, 0);
    assert.equal(components.reddit, 0);
    assert.equal(components.sqmReport, 0);
});

test('an unreachable site is gated the same way as a military one', () => {
    const site = {
        ...GOOD_SITE, reachable: false,
        darkSkyPlace: { designation: 'park', distanceKm: 1, name: 'X' },
    };
    const { components } = nightScore(site, GREAT_NIGHT);
    assert.equal(components.remote, 0);
    assert.equal(components.ida, 0);
});

test('positive Reddit proximity adds, negative subtracts (signed sentiment)', () => {
    const base = { ...GOOD_SITE };
    const pos = nightScore({ ...base, nearestRedditSpot: { distanceKm: 2, sentiment: 'positive', subreddit: 's', name: 'n' } }, GREAT_NIGHT);
    const neg = nightScore({ ...base, nearestRedditSpot: { distanceKm: 2, sentiment: 'negative', subreddit: 's', name: 'n' } }, GREAT_NIGHT);
    assert.ok(pos.components.reddit > 0);
    assert.equal(neg.components.reddit, 0); // negative clamps the floor to 0, never a bonus
    assert.ok(pos.score > neg.score);
});

test('light-dome reason pill appears only when the glow is directional', () => {
    const directional = nightScore({ ...GOOD_SITE, lightDome: { direction: 'SE', concentration: 0.8 } }, GREAT_NIGHT);
    assert.ok(directional.reasons.some(r => r.includes('light dome') && r.includes('SE')));

    const diffuse = nightScore({ ...GOOD_SITE, lightDome: { direction: 'SE', concentration: 0.2 } }, GREAT_NIGHT);
    assert.ok(!diffuse.reasons.some(r => r.includes('light dome')));
});

test('a Reddit spot vetted across multiple threads surfaces the cross-validation', () => {
    const vetted = nightScore({
        ...GOOD_SITE,
        nearestRedditSpot: { distanceKm: 1, sentiment: 'positive', subreddit: 'austin', name: 'Enchanted Rock', mentions: 3 },
    }, GREAT_NIGHT);
    assert.ok(vetted.reasons.some(r => r.includes('Enchanted Rock') && r.includes('3 threads')));

    const oneOff = nightScore({
        ...GOOD_SITE,
        nearestRedditSpot: { distanceKm: 1, sentiment: 'positive', subreddit: 'austin', name: 'Enchanted Rock', mentions: 1 },
    }, GREAT_NIGHT);
    assert.ok(!oneOff.reasons.some(r => r.includes('threads')));
});

test('nightScore tolerates a bare site/night with no enrichment', () => {
    const { score, reasons, weakest } = nightScore({ lat: 40, lng: -100, sqm: 20 }, { date: '2026-06-15' });
    assert.ok(Number.isInteger(score));
    assert.ok(Array.isArray(reasons));
    assert.ok(typeof weakest === 'string');
});

// ─── Real-darkness-window moon term (the ① fix) ───────────────────────────────

test('moonInterferenceForNight returns a coherent dark window', () => {
    const m = moonInterferenceForNight(40, -105, '2026-01-15');
    assert.ok(m, 'expected a result for a mid-latitude winter night');
    assert.ok(m.darkStart < m.darkEnd, 'darkStart must precede darkEnd');
    assert.ok(m.hoursDark > 0 && m.hoursDark < 24);
    assert.ok(m.fractionInterference >= 0 && m.fractionInterference <= 1);
    assert.ok(m.illumination >= 0 && m.illumination <= 1);
});

test('winter nights have a longer astronomical-dark window than summer', () => {
    const winter = moonInterferenceForNight(35, -111, '2026-12-15').hoursDark;
    const summer = moonInterferenceForNight(35, -111, '2026-06-15').hoursDark;
    assert.ok(winter > summer, `winter ${winter}h should exceed summer ${summer}h at 35°N`);
});

test('the dark window is data-driven (not the old hardcoded 8h block)', () => {
    // A short mid-summer northern night is genuinely ~1.5h, nothing like 8h —
    // the exact failure mode the old fixed 21:00–05:00 window got wrong.
    const summer48 = moonInterferenceForNight(48, -110, '2026-06-15').hoursDark;
    assert.ok(summer48 < 3, `expected a short summer dark window at 48°N, got ${summer48}h`);
    // And it varies with latitude on the same date — proof it isn't a constant.
    const summer25 = moonInterferenceForNight(25, -100, '2026-06-15').hoursDark;
    assert.ok(Math.abs(summer25 - summer48) > 1, 'window should vary by latitude');
});
