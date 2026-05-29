/**
 * GLOBE at Night citizen-science SQM observations.
 * Loaded lazily, then queried in memory for proximity lookups.
 */

import { haversineDistance } from './utils.js';

const DATA_URL = '/data/sqm-reports.json';

let _cache = null;
let _inflight = null;

export async function loadSqmReports() {
    if (_cache) return _cache;
    if (_inflight) return _inflight;
    _inflight = (async () => {
        try {
            const resp = await fetch(DATA_URL);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const json = await resp.json();
            _cache = json.reports || [];
            return _cache;
        } catch (err) {
            console.warn('Failed to load SQM reports:', err.message);
            _cache = [];
            return _cache;
        } finally {
            _inflight = null;
        }
    })();
    return _inflight;
}

export function reportsNear(reports, lat, lng, radiusKm) {
    if (!reports?.length) return [];
    const out = [];
    for (const r of reports) {
        const d = haversineDistance(lat, lng, r.lat, r.lng);
        if (d <= radiusKm) out.push({ ...r, distanceKm: d });
    }
    out.sort((a, b) => a.distanceKm - b.distanceKm);
    return out;
}

/**
 * Best SQM measurement among the reports within `radiusKm` of (lat, lng), or
 * null if none had a digital reading. We prefer digital SQM over limiting-mag.
 */
export function bestNearbyMeasurement(reports, lat, lng, radiusKm) {
    const near = reportsNear(reports, lat, lng, radiusKm);
    if (!near.length) return null;
    const withSqm = near.filter(r => r.sqm != null);
    if (withSqm.length) {
        return withSqm.reduce((best, r) => r.sqm > best.sqm ? r : best, withSqm[0]);
    }
    return near[0]; // limiting-mag-only fallback
}

/**
 * Map an SQM reading to a colour matching the app's Bortle palette.
 */
export function sqmColor(sqm) {
    if (sqm == null) return '#94a3b8';
    if (sqm >= 21.9) return '#1e1b4b';
    if (sqm >= 21.5) return '#312e81';
    if (sqm >= 21.0) return '#3730a3';
    if (sqm >= 20.5) return '#1b9aaa';
    if (sqm >= 19.5) return '#4ecdc4';
    if (sqm >= 18.9) return '#f7dc6f';
    if (sqm >= 18.0) return '#f0932b';
    return '#eb4d4b';
}
