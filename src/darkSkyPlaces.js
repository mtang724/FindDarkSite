/**
 * IDA-certified Dark Sky Places.
 * Data baked at build time by scripts/fetch-dark-sky-places.mjs from Wikidata
 * (CC0). Loaded once per session, then queried in-memory.
 */

import { haversineDistance } from './utils.js';

const DATA_URL = '/data/dark-sky-places.json';

let _cache = null;
let _inflight = null;

export async function loadDarkSkyPlaces() {
    if (_cache) return _cache;
    if (_inflight) return _inflight;
    _inflight = (async () => {
        try {
            const resp = await fetch(DATA_URL);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const json = await resp.json();
            _cache = json.places || [];
            return _cache;
        } catch (err) {
            console.warn('Failed to load dark sky places:', err.message);
            _cache = [];
            return _cache;
        } finally {
            _inflight = null;
        }
    })();
    return _inflight;
}

/**
 * Return all IDA-certified places within `radiusKm` of a point, sorted
 * by distance ascending. `distanceKm` is added to each row.
 */
export function placesNear(places, lat, lng, radiusKm) {
    if (!places || places.length === 0) return [];
    const out = [];
    for (const p of places) {
        const d = haversineDistance(lat, lng, p.lat, p.lng);
        if (d <= radiusKm) out.push({ ...p, distanceKm: d });
    }
    out.sort((a, b) => a.distanceKm - b.distanceKm);
    return out;
}

// Designation → emoji + Bortle-quality colour. Sanctuary > Reserve > Park >
// Community > Urban roughly tracks darkness expectation per IDA's criteria.
const DESIGNATION_META = {
    sanctuary: { icon: '🌌', color: '#a855f7', label: 'Dark Sky Sanctuary' },
    reserve:   { icon: '🌃', color: '#8b5cf6', label: 'Dark Sky Reserve' },
    park:      { icon: '🏞️', color: '#6366f1', label: 'Dark Sky Park' },
    community: { icon: '🏘️', color: '#3b82f6', label: 'Dark Sky Community' },
    urban:     { icon: '🌆', color: '#0ea5e9', label: 'Urban Night Sky Place' },
};

export function designationMeta(d) {
    return DESIGNATION_META[d] || { icon: '⭐', color: '#a5b4fc', label: 'Dark Sky Place' };
}
