/**
 * Reddit-sourced "locals say" stargazing spots.
 *
 * Pipeline (offline, refreshable):
 *   1. scripts/fetch-reddit-stargazing.mjs    — Playwright scrape across 50 metros
 *   2. (Claude Code Agent)                    — extract specific named places
 *   3. scripts/geocode-extracted-places.mjs   — Nominatim geocode each name
 *   4. ships as public/data/reddit-locations.json
 *
 * The app loads the file lazily and finds the closest metro to the user's
 * resolved location. If anything within 250 km is available, the results
 * panel surfaces the "🗣️ Locals say…" section and the map drops orange pins.
 */

import { haversineDistance } from './utils.js';

const DATA_URL = '/data/reddit-locations.json';

let _cache = null;
let _inflight = null;

export async function loadRedditLocations() {
    if (_cache) return _cache;
    if (_inflight) return _inflight;
    _inflight = (async () => {
        try {
            const resp = await fetch(DATA_URL);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            _cache = await resp.json();
            return _cache;
        } catch (err) {
            console.warn('Failed to load Reddit locations:', err.message);
            _cache = { metros: [] };
            return _cache;
        } finally {
            _inflight = null;
        }
    })();
    return _inflight;
}

/**
 * Pick the closest covered metro to a user point, within `maxKm`. The data
 * file stores metros by display name + state; we use the parent metro's
 * coords from the manifest (not the extracted place coords) to score.
 */
export function nearestCoveredMetro(data, lat, lng, maxKm = 250) {
    if (!data?.metros?.length) return null;
    let best = null;
    let bestD = Infinity;
    for (const m of data.metros) {
        if (!m.places?.length) continue;
        // Each metro entry has its own places, but the metro center isn't
        // stored on the entry — we have it on the script-side us-metros list.
        // Approximate: use the centroid of its geocoded places.
        const coords = m.places.filter(p => p.lat != null && p.lng != null);
        if (!coords.length) continue;
        const cLat = coords.reduce((s, p) => s + p.lat, 0) / coords.length;
        const cLng = coords.reduce((s, p) => s + p.lng, 0) / coords.length;
        const d = haversineDistance(lat, lng, cLat, cLng);
        if (d < bestD && d <= maxKm) { bestD = d; best = m; }
    }
    return best ? { ...best, distanceKm: bestD } : null;
}

/**
 * Sentiment → colour tone.
 */
export function sentimentColor(s) {
    if (s === 'positive') return 'var(--accent-success)';
    if (s === 'negative') return 'var(--accent-danger)';
    return 'var(--accent-warning)'; // mixed / unknown
}
