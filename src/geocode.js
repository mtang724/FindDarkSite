/**
 * Resolve free-form location input to (lat, lng).
 *
 * Order of attempts:
 *   1. Parse "lat, lng" / "lat lng" directly — instant, no network.
 *   2. Nominatim free-form search (handles US ZIPs, addresses, "Joshua Tree",
 *      "Cupertino, CA", "M5V 3L9", etc.). Free, no key, returns CORS-friendly.
 *
 * Results cached in IndexedDB for a month to avoid hitting Nominatim for the
 * same query twice. Per Nominatim's usage policy we keep request volume low
 * (a single call per submit, cached aggressively) and identify the app via
 * the `email` parameter.
 */

import { get, set } from 'idb-keyval';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;        // 30 days
const APP_EMAIL = 'finddarksite@users.github.io'; // contact for Nominatim ops; harmless if it bounces

const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/;

/**
 * @typedef {Object} ResolvedLocation
 * @property {number} lat
 * @property {number} lng
 * @property {string} source           - 'coords' | 'nominatim' | 'cache'
 * @property {string} [displayName]    - human-readable label (Nominatim only)
 */

/**
 * Synchronous coord parser, kept here so callers can pre-check without going
 * async when the input is already a lat/lng pair.
 * @param {string} input
 * @returns {{lat:number,lng:number} | null}
 */
export function parseCoords(input) {
    if (!input) return null;
    const m = COORD_RE.exec(input);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
}

function cacheKey(q) {
    return `geocode_${q.trim().toLowerCase()}`;
}

/**
 * Resolve a free-form input to (lat, lng) + a display label.
 * Throws on unrecoverable parse errors so the UI can surface them.
 *
 * @param {string} input
 * @param {AbortSignal} [signal]
 * @returns {Promise<ResolvedLocation>}
 */
export async function resolveLocation(input, signal) {
    const trimmed = (input || '').trim();
    if (!trimmed) throw new Error('Please enter a location.');

    // 1. Direct coords — fastest path, no network.
    const coords = parseCoords(trimmed);
    if (coords) return { ...coords, source: 'coords' };

    // 2. Cached geocode lookup?
    const ck = cacheKey(trimmed);
    const cached = await get(ck);
    if (cached && Date.now() - cached.ts < TTL_MS) {
        return { ...cached.data, source: 'cache' };
    }

    // 3. Nominatim free-form search. US ZIPs benefit from countrycodes=us
    //    (otherwise "10001" matches German postal codes too); other inputs
    //    fall through to global search.
    const isUsZip = /^\d{5}(?:-\d{4})?$/.test(trimmed);
    const params = new URLSearchParams({
        q: trimmed,
        format: 'json',
        limit: '1',
        addressdetails: '1',
        email: APP_EMAIL,
    });
    if (isUsZip) {
        params.set('countrycodes', 'us');
        params.set('postalcode', trimmed.split('-')[0]); // also send as structured postcode for higher hit rate
        params.delete('q');
    }

    const resp = await fetch(`${NOMINATIM_URL}?${params}`, {
        signal,
        headers: { 'Accept': 'application/json' },
    });
    if (!resp.ok) {
        throw new Error(`Geocode HTTP ${resp.status}`);
    }
    const json = await resp.json();
    if (!Array.isArray(json) || json.length === 0) {
        throw new Error(`Couldn't find "${trimmed}". Try a ZIP, city, or "lat, lng".`);
    }
    const first = json[0];
    const lat = parseFloat(first.lat);
    const lng = parseFloat(first.lon);
    if (!isFinite(lat) || !isFinite(lng)) {
        throw new Error('Geocode returned malformed coordinates.');
    }
    const data = {
        lat, lng,
        displayName: shortDisplayName(first, trimmed),
    };
    await set(ck, { ts: Date.now(), data });
    return { ...data, source: 'nominatim' };
}

/**
 * Nominatim's `display_name` is sometimes a 60-char "Cupertino, Santa Clara
 * County, California, United States" mouthful. Pull out the place + state for
 * a compact hint. Falls back to the full name if we can't parse it.
 */
function shortDisplayName(hit, query) {
    const a = hit.address || {};
    const place = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || a.locality || a.neighbourhood;
    const region = a.state || a.region || a.country_code?.toUpperCase();
    if (place && region) return `${place}, ${region}`;
    // ZIPs get a clean "ZIP 95014 — Cupertino, CA"-style label
    if (a.postcode && place) return `ZIP ${a.postcode} — ${place}${region ? `, ${region}` : ''}`;
    if (hit.display_name) return hit.display_name.split(',').slice(0, 3).join(',');
    return query;
}
