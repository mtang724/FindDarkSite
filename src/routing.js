/**
 * Driving time/distance via OSRM public demo router
 *   https://router.project-osrm.org
 * No key needed, but it's a shared demo — keep request volume low.
 *
 * Results cached 24h per (origin, dest) pair rounded to 4 decimals.
 */

import { get, set } from 'idb-keyval';

const BASE = 'https://router.project-osrm.org/route/v1/driving';
const TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_DELAY_MS = 250;

function cacheKey(oLat, oLng, dLat, dLng) {
    return `osrm_${oLat.toFixed(4)}_${oLng.toFixed(4)}_${dLat.toFixed(4)}_${dLng.toFixed(4)}`;
}

async function fetchOne(oLat, oLng, dLat, dLng, signal) {
    const key = cacheKey(oLat, oLng, dLat, dLng);
    const cached = await get(key);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

    const url = `${BASE}/${oLng},${oLat};${dLng},${dLat}?overview=false`;
    const resp = await fetch(url, { signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const route = json.routes?.[0];
    if (!route) throw new Error('no route');
    const data = {
        durationSec: Math.round(route.duration),
        distanceKm: route.distance / 1000,
    };
    await set(key, { ts: Date.now(), data });
    return data;
}

/**
 * Driving time from a single origin to many destinations.
 * @returns {Array<{ durationSec, distanceKm } | null>} aligned to input
 */
export async function fetchDrivingTimes(originLat, originLng, dests, signal, onProgress) {
    const out = [];
    for (let i = 0; i < dests.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
            const data = await fetchOne(originLat, originLng, dests[i].lat, dests[i].lng, signal);
            out.push(data);
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            out.push(null);
        }
        onProgress?.(i + 1, dests.length);

        // Throttle only when we actually hit the network — last response wasn't cached
        // (rough heuristic: if it took >50ms, it was probably a network call).
        await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
    }
    return out;
}

export function formatDriveTime(sec) {
    if (sec == null) return '—';
    if (sec < 60) return `${sec}s`;
    const mins = Math.round(sec / 60);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
}
