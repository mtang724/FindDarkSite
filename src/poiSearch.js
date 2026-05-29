/**
 * POI Search module
 *  - Overpass API (OpenStreetMap) for general nearby POIs — free, no API key, CORS-friendly
 *  - Recreation.gov RIDB for official US federal campgrounds (still free, needs key)
 */

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// POI types relevant for dark-sky site accessibility.
// `types` are the canonical internal type strings used elsewhere in the app.
export const POI_CATEGORIES = {
    campground: { label: 'Campground', icon: '🏕️', types: ['campground'] },
    rv_park: { label: 'RV Park', icon: '🚐', types: ['rv_park'] },
    parking: { label: 'Parking', icon: '🅿️', types: ['parking'] },
    lodging: { label: 'Lodging', icon: '🏨', types: ['lodging'] },
    park: { label: 'Park', icon: '🌲', types: ['park', 'national_park'] },
    tourist_attraction: { label: 'Attraction', icon: '📍', types: ['tourist_attraction'] },
};

// Map an OSM element's raw tags → our internal POI types.
function osmTagsToTypes(tags = {}) {
    const t = [];
    if (tags.tourism === 'camp_site') t.push('campground');
    if (tags.tourism === 'caravan_site') t.push('rv_park');
    if (['hotel', 'motel', 'guest_house', 'hostel', 'chalet', 'apartment'].includes(tags.tourism)) t.push('lodging');
    if (tags.amenity === 'parking') t.push('parking');
    if (tags.boundary === 'national_park') t.push('national_park');
    if (tags.leisure === 'nature_reserve' || tags.leisure === 'park') t.push('park');
    if (tags.tourism === 'attraction' || tags.tourism === 'viewpoint') t.push('tourist_attraction');
    return t;
}

function osmName(tags = {}) {
    return tags.name || tags['name:en'] || tags['official_name'] || null;
}

function buildOverpassQuery(centers, radiusM) {
    const r = Math.min(Math.round(radiusM), 50000);
    // Overpass "around" filter takes a radius followed by lat,lng,lat,lng,... pairs.
    // Total argument count must be odd (1 radius + 2N coords).
    const coords = centers.map(c => `${c.lat},${c.lng}`).join(',');
    const around = `around:${r},${coords}`;
    return `
        [out:json][timeout:50];
        (
            nwr["tourism"="camp_site"](${around});
            nwr["tourism"="caravan_site"](${around});
            nwr["tourism"~"^(hotel|motel|guest_house|hostel|chalet)$"](${around});
            nwr["amenity"="parking"]["access"!~"private|no"](${around});
            nwr["boundary"="national_park"](${around});
            nwr["leisure"~"^(nature_reserve|park)$"](${around});
            nwr["tourism"~"^(attraction|viewpoint)$"](${around});
        );
        out center tags 1000;
    `.trim();
}

function parseOverpassElements(elements) {
    const seen = new Set();
    const out = [];
    for (const el of elements) {
        const tags = el.tags || {};
        const types = osmTagsToTypes(tags);
        if (types.length === 0) continue;

        const pLat = el.lat ?? el.center?.lat;
        const pLng = el.lon ?? el.center?.lon;
        if (pLat == null || pLng == null) continue;

        const name = osmName(tags);
        // Skip unnamed parking lots — too noisy.
        if (!name && types.includes('parking')) continue;

        const id = `osm_${el.type}_${el.id}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const address = [tags['addr:street'], tags['addr:city'], tags['addr:state']]
            .filter(Boolean).join(', ');

        out.push({
            name: name || `Unnamed ${POI_CATEGORIES[types[0]]?.label || 'Place'}`,
            lat: pLat,
            lng: pLng,
            types,
            address,
            rating: null,
            placeId: id,
            source: 'osm',
            osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        });
    }
    return out;
}

/**
 * Spatial-extent bounding box (km) for a set of centers. Used to decide whether
 * to split a batch into smaller geographic groups.
 */
function spanKm(centers) {
    if (centers.length < 2) return 0;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const c of centers) {
        if (c.lat < minLat) minLat = c.lat;
        if (c.lat > maxLat) maxLat = c.lat;
        if (c.lng < minLng) minLng = c.lng;
        if (c.lng > maxLng) maxLng = c.lng;
    }
    // Diagonal in km — rough but good enough to spot blow-ups.
    const dLat = (maxLat - minLat) * 111;
    const dLng = (maxLng - minLng) * 111 * Math.cos((minLat + maxLat) * Math.PI / 360);
    return Math.sqrt(dLat * dLat + dLng * dLng);
}

/**
 * Split a list of centers into groups so each group spans ≤ MAX_SPAN_KM. Greedy:
 * grow a group around the first unassigned center, peeling off centers within
 * MAX_SPAN_KM of it. Cheaper than k-means and avoids pathological queries.
 */
function groupCenters(centers, maxSpanKm = 250) {
    if (centers.length <= 1 || spanKm(centers) <= maxSpanKm) return [centers];
    const remaining = [...centers];
    const groups = [];
    while (remaining.length > 0) {
        const seed = remaining.shift();
        const group = [seed];
        const halfSpan = maxSpanKm / 2;
        for (let i = remaining.length - 1; i >= 0; i--) {
            const c = remaining[i];
            const dLat = (c.lat - seed.lat) * 111;
            const dLng = (c.lng - seed.lng) * 111 * Math.cos((c.lat + seed.lat) * Math.PI / 360);
            const d = Math.sqrt(dLat * dLat + dLng * dLng);
            if (d <= halfSpan) {
                group.push(c);
                remaining.splice(i, 1);
            }
        }
        groups.push(group);
    }
    return groups;
}

async function postOverpass(query, signal) {
    // Some Overpass mirrors are now stricter — explicit Accept + UA avoid 406s.
    const resp = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        },
        body: 'data=' + encodeURIComponent(query),
        signal,
    });
    if (!resp.ok) {
        const sample = await resp.text().then(t => t.slice(0, 180)).catch(() => '');
        const err = new Error(`Overpass HTTP ${resp.status}${sample ? `: ${sample}` : ''}`);
        err.status = resp.status;
        throw err;
    }
    const data = await resp.json();
    return parseOverpassElements(data.elements || []);
}

/**
 * Batched Overpass query covering many cluster centers at once.
 * Returns `{ pois, error }` so callers can distinguish "no POIs near these
 * seeds" from "Overpass call failed". Splits the call into geographic groups
 * if the centers span more than ~250 km (avoids query-too-expensive rejects).
 *
 * @param {Array<{lat:number,lng:number}>} centers
 * @param {number} radiusM
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ pois: Array, error: string|null }>}
 */
export async function searchNearbyPOIsBatch(centers, radiusM = 8000, signal) {
    if (!centers || centers.length === 0) return { pois: [], error: null };

    const groups = groupCenters(centers);
    const seen = new Set();
    const merged = [];
    const errors = [];

    for (let i = 0; i < groups.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const group = groups[i];
        const query = buildOverpassQuery(group, radiusM);
        try {
            const pois = await postOverpass(query, signal);
            for (const p of pois) {
                if (seen.has(p.placeId)) continue;
                seen.add(p.placeId);
                merged.push(p);
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            console.warn(`Overpass batch ${i + 1}/${groups.length} failed:`, err.message);
            errors.push(err.message);
        }
        // Light pacing between groups so we don't trip per-IP rate-limits
        if (i < groups.length - 1) await new Promise(r => setTimeout(r, 500));
    }

    // Only return an error if every group failed. A partial success still gives
    // the user something useful.
    const error = errors.length === groups.length ? errors[0] : null;
    return { pois: merged, error };
}

/**
 * Single-center Overpass query (kept for one-off lookups / backwards compat).
 */
export async function searchNearbyPOIs(lat, lng, radiusM = 8000, signal) {
    return searchNearbyPOIsBatch([{ lat, lng }], radiusM, signal);
}

/**
 * Search for campgrounds via Recreation.gov RIDB API
 * @param {string} apiKey - RIDB API key
 * @param {number} lat - center latitude
 * @param {number} lng - center longitude
 * @param {number} radiusKm - search radius in km
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array>}
 */
export async function searchRIDBCampgrounds(apiKey, lat, lng, radiusKm = 8, signal) {
    if (!apiKey || apiKey === 'YOUR_RIDB_API_KEY') {
        return [];
    }

    try {
        const radiusMiles = radiusKm * 0.621371;
        // Use Vite proxy in dev to avoid CORS; in production, use a server proxy
        const baseUrl = import.meta.env.DEV
            ? '/api/ridb'
            : 'https://ridb.recreation.gov/api/v1';
        const url = `${baseUrl}/facilities?latitude=${lat}&longitude=${lng}&radius=${radiusMiles}&activity=CAMPING&limit=50`;

        const resp = await fetch(url, {
            headers: {
                'apikey': apiKey,
                'Accept': 'application/json'
            },
            signal,
        });

        if (!resp.ok) {
            console.warn(`RIDB API error: HTTP ${resp.status}`);
            return [];
        }

        const data = await resp.json();
        if (!data.RECDATA) return [];

        return data.RECDATA
            .filter(f => f.FacilityLatitude && f.FacilityLongitude)
            .map(f => ({
                name: f.FacilityName,
                lat: f.FacilityLatitude,
                lng: f.FacilityLongitude,
                types: ['campground'],
                address: `${f.FacilityAddressee || ''}, ${f.FacilityState || ''}`.trim(),
                description: f.FacilityDescription?.replace(/<[^>]*>/g, '').substring(0, 200) || '',
                reservationUrl: f.FacilityReservationURL || `https://www.recreation.gov/camping/campgrounds/${f.FacilityID}`,
                source: 'recreation.gov',
                placeId: `ridb_${f.FacilityID}`
            }));
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        console.warn('RIDB API error:', err.message);
        return [];
    }
}

/**
 * Get category info for a POI's types
 */
export function categorizePOI(types) {
    for (const [key, cat] of Object.entries(POI_CATEGORIES)) {
        if (types.some(t => cat.types.includes(t) || t === key)) {
            return cat;
        }
    }
    return { label: 'Place', icon: '📍' };
}
