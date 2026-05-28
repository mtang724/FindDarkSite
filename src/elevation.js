/**
 * Elevation lookups via Open-Meteo Elevation API (free, no key, no CORS issues).
 * Endpoint:  https://api.open-meteo.com/v1/elevation?latitude=X1,X2&longitude=Y1,Y2
 * Returns:   { elevation: [m1, m2, ...] }   -- 90 m SRTM resolution.
 *
 * Batches up to MAX_PER_REQUEST coords per call; caches each point in IndexedDB.
 */

import { get, set } from 'idb-keyval';

const ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
const MAX_PER_REQUEST = 100;

function cacheKey(lat, lng) {
    // 4 decimals ≈ 11 m precision — well below SRTM grid resolution
    return `elev_${lat.toFixed(4)}_${lng.toFixed(4)}`;
}

/**
 * Fetch elevation (meters) for a list of points. Mutates nothing — returns
 * an array same length/order as input, with `elevation` filled in (or null on failure).
 *
 * @param {Array<{lat:number,lng:number}>} points
 * @param {AbortSignal} [signal]
 */
export async function fetchElevations(points, signal) {
    if (!points || points.length === 0) return [];

    // 1. cache lookup
    const out = await Promise.all(points.map(async (p) => {
        const cached = await get(cacheKey(p.lat, p.lng));
        return cached != null ? cached : null;
    }));

    // 2. collect misses, batch network calls
    const misses = [];
    for (let i = 0; i < points.length; i++) {
        if (out[i] == null) misses.push({ idx: i, p: points[i] });
    }

    for (let i = 0; i < misses.length; i += MAX_PER_REQUEST) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const batch = misses.slice(i, i + MAX_PER_REQUEST);
        const lats = batch.map(b => b.p.lat.toFixed(4)).join(',');
        const lngs = batch.map(b => b.p.lng.toFixed(4)).join(',');
        const url = `${ENDPOINT}?latitude=${lats}&longitude=${lngs}`;
        try {
            const resp = await fetch(url, { signal });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const json = await resp.json();
            const elevs = json.elevation || [];
            for (let j = 0; j < batch.length; j++) {
                const m = batch[j];
                const e = Number(elevs[j]);
                if (Number.isFinite(e)) {
                    out[m.idx] = e;
                    await set(cacheKey(m.p.lat, m.p.lng), e);
                }
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            console.warn('Elevation batch failed:', err.message);
            // leave those slots null; downstream tolerates it
        }
    }

    return out;
}
