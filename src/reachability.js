/**
 * Reachability + remoteness signals via OSM Overpass.
 *
 * For each candidate seed we want two real-world questions answered:
 *   1. Can I actually drive (and park) here?
 *        → look for a `highway=` way with a polyline node within ~800 m.
 *   2. How quiet is the local night sky beyond what VIIRS sees?
 *        → distance to nearest settlement node (city/town/village)
 *          and nearest `landuse=residential` area.
 *
 * One Overpass call per batch covers all seeds. Same defensive headers /
 * geographic splitting as the POI call: see poiSearch.js for the pattern.
 */

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// "Drivable" highway classes. Tracks and unclassified roads are included
// because real-world dark sites are often on a forest service road. Excludes
// footway/path/cycleway/steps which can't take a car.
const DRIVABLE_HIGHWAY_RE = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|track|tertiary_link|secondary_link|primary_link|motorway_link|trunk_link)$';
const SETTLEMENT_RE = '^(city|town|village|hamlet|suburb|neighbourhood)$';

const ROAD_RADIUS_M = 800;          // within this = drivable
const SETTLEMENT_RADIUS_M = 25000;  // 25 km is roughly the glow-on-horizon distance for a small town
const RESIDENTIAL_RADIUS_M = 12000;

function buildQuery(centers) {
    const coords = centers.map(c => `${c.lat},${c.lng}`).join(',');
    // Use separate (...)-> sets so we can request the right output mode per
    // type: ways need geom for accurate per-seed distance; nodes/centers don't.
    // Protected-area polygons need full geom for point-in-polygon.
    const protectedRadius = 5000; // pick up parks the seed is inside or right next to
    return `
        [out:json][timeout:90];
        ( way["highway"~"${DRIVABLE_HIGHWAY_RE}"](around:${ROAD_RADIUS_M},${coords}); )->.roads;
        ( node["place"~"${SETTLEMENT_RE}"](around:${SETTLEMENT_RADIUS_M},${coords}); )->.settlements;
        ( way["landuse"="residential"](around:${RESIDENTIAL_RADIUS_M},${coords}); )->.residential;
        ( way["boundary"="protected_area"](around:${protectedRadius},${coords});
          relation["boundary"="protected_area"](around:${protectedRadius},${coords});
          way["boundary"="national_park"](around:${protectedRadius},${coords});
          relation["boundary"="national_park"](around:${protectedRadius},${coords}); )->.protected;
        ( way["landuse"="military"](around:${protectedRadius},${coords}); )->.military;
        .roads out geom 4000;
        .settlements out 1500;
        .residential out center 1500;
        .protected out geom 600;
        .military out geom 200;
    `.trim();
}

async function postOverpass(query, signal) {
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
    return (await resp.json()).elements || [];
}

// Same geographic splitter as searchNearbyPOIsBatch — duplicated locally so
// reachability can fail/retry independent of POI search.
function spanKm(centers) {
    if (centers.length < 2) return 0;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const c of centers) {
        if (c.lat < minLat) minLat = c.lat; if (c.lat > maxLat) maxLat = c.lat;
        if (c.lng < minLng) minLng = c.lng; if (c.lng > maxLng) maxLng = c.lng;
    }
    const dLat = (maxLat - minLat) * 111;
    const dLng = (maxLng - minLng) * 111 * Math.cos((minLat + maxLat) * Math.PI / 360);
    return Math.sqrt(dLat * dLat + dLng * dLng);
}
function groupCenters(centers, maxSpanKm = 250) {
    if (centers.length <= 1 || spanKm(centers) <= maxSpanKm) return [centers];
    const remaining = [...centers];
    const out = [];
    while (remaining.length > 0) {
        const seed = remaining.shift();
        const group = [seed];
        for (let i = remaining.length - 1; i >= 0; i--) {
            const c = remaining[i];
            const dLat = (c.lat - seed.lat) * 111;
            const dLng = (c.lng - seed.lng) * 111 * Math.cos((c.lat + seed.lat) * Math.PI / 360);
            if (Math.sqrt(dLat * dLat + dLng * dLng) <= maxSpanKm / 2) {
                group.push(c);
                remaining.splice(i, 1);
            }
        }
        out.push(group);
    }
    return out;
}

/**
 * Fetch the reachability context for many candidate seeds in one (or few)
 * Overpass calls. Returns `{ elements, error }`.
 */
export async function fetchReachabilityContext(centers, signal) {
    if (!centers || centers.length === 0) return { elements: [], error: null };
    const groups = groupCenters(centers);
    const merged = [];
    const errors = [];
    for (let i = 0; i < groups.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
            const els = await postOverpass(buildQuery(groups[i]), signal);
            merged.push(...els);
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            console.warn(`Reachability batch ${i + 1}/${groups.length} failed:`, err.message);
            errors.push(err.message);
        }
        if (i < groups.length - 1) await new Promise(r => setTimeout(r, 500));
    }
    return {
        elements: merged,
        error: errors.length === groups.length ? errors[0] : null,
    };
}

/**
 * Point-in-polygon (ray casting) for a polygon given as [{lat,lon}, ...].
 * Lat/lon ordering is consistent with Overpass `out geom` elements.
 */
function pointInPolygon(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i].lon, yi = ring[i].lat;
        const xj = ring[j].lon, yj = ring[j].lat;
        const intersect = ((yi > lat) !== (yj > lat))
            && (lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

/**
 * Extract polygon rings from a `boundary=*` Overpass element. Handles both
 * way (geometry: [{lat,lon},...]) and relation (members[].geometry).
 * Returns an array of rings (so multipolygons land as a flat list).
 */
function extractRings(el) {
    if (el.type === 'way' && Array.isArray(el.geometry)) {
        return [el.geometry];
    }
    if (el.type === 'relation' && Array.isArray(el.members)) {
        const rings = [];
        for (const m of el.members) {
            if ((m.role === 'outer' || m.role === '' || m.role === 'inner') && Array.isArray(m.geometry)) {
                // Treat outer + inner alike for our coarse "is the site inside" test —
                // we just want a yes/no, not exact area.
                rings.push(m.geometry);
            }
        }
        return rings;
    }
    return [];
}

/**
 * Pull out a sensible human-readable name + class for a protected area.
 */
function protectedAreaLabel(el) {
    const t = el.tags || {};
    const name = t.name || t['name:en'] || t['official_name'] || null;
    // protect_class: IUCN 1a/1b/2/3/4/5/6 maps to a label, else fall back to tags.
    const cls = t.protect_class || t.protection_title || t.designation || t.protection_object || null;
    const ownership = t.ownership || t.operator || null;
    return { name, cls, ownership };
}

// Tiny haversine local copy so this module is self-contained.
function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6_371_000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
        * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Classify a single site against the pooled OSM context.
 * Returns the metrics the UI shows + a `reachable` boolean.
 */
export function classifySite(site, elements) {
    let nearestRoadM = Infinity;
    let roadSurface = null;
    let roadHighway = null;
    let nearestSettlementKm = Infinity;
    let nearestSettlementName = null;
    let nearestResidentialKm = Infinity;
    let protectedArea = null;
    let inMilitary = false;

    for (const el of elements) {
        // Highway way — use the polyline nodes for accurate per-seed distance.
        if (el.type === 'way' && el.tags?.highway && Array.isArray(el.geometry)) {
            let wayMin = Infinity;
            for (const n of el.geometry) {
                const d = haversineM(site.lat, site.lng, n.lat, n.lon);
                if (d < wayMin) wayMin = d;
                if (wayMin < 50) break;
            }
            if (wayMin < nearestRoadM) {
                nearestRoadM = wayMin;
                roadSurface = el.tags.surface || null;
                roadHighway = el.tags.highway || null;
            }
        }
        // Settlement node — single point, simple distance.
        else if (el.type === 'node' && el.tags?.place && /^(city|town|village|hamlet|suburb|neighbourhood)$/.test(el.tags.place)) {
            const km = haversineM(site.lat, site.lng, el.lat, el.lon) / 1000;
            const weight = settlementWeight(el.tags.place, parseInt(el.tags.population) || 0);
            const effectiveKm = km / weight;
            if (effectiveKm < nearestSettlementKm) {
                nearestSettlementKm = effectiveKm;
                nearestSettlementName = el.tags.name || el.tags['name:en'] || el.tags.place;
            }
        }
        // Residential landuse — way center (approximate).
        else if (el.type === 'way' && el.tags?.landuse === 'residential' && el.center) {
            const km = haversineM(site.lat, site.lng, el.center.lat, el.center.lon) / 1000;
            if (km < nearestResidentialKm) nearestResidentialKm = km;
        }
        // Protected area / national park — point-in-polygon
        else if ((el.tags?.boundary === 'protected_area' || el.tags?.boundary === 'national_park')) {
            const rings = extractRings(el);
            if (rings.some(r => pointInPolygon(site.lat, site.lng, r))) {
                const label = protectedAreaLabel(el);
                if (!protectedArea || (label.name && !protectedArea.name)) {
                    protectedArea = { ...label, boundary: el.tags.boundary };
                }
            }
        }
        // Military area — flag the site, but only outright reject if seed
        // actually falls inside the polygon.
        else if (el.tags?.landuse === 'military' && Array.isArray(el.geometry)) {
            if (pointInPolygon(site.lat, site.lng, el.geometry)) inMilitary = true;
        }
    }

    return {
        nearestRoadM: Number.isFinite(nearestRoadM) ? Math.round(nearestRoadM) : null,
        roadSurface,
        roadHighway,
        nearestSettlementKm: Number.isFinite(nearestSettlementKm) ? +nearestSettlementKm.toFixed(1) : null,
        nearestSettlementName,
        nearestResidentialKm: Number.isFinite(nearestResidentialKm) ? +nearestResidentialKm.toFixed(1) : null,
        protectedArea,
        inMilitary,
        // Reachable if any drivable road has a node within ROAD_RADIUS_M.
        reachable: Number.isFinite(nearestRoadM) && nearestRoadM <= ROAD_RADIUS_M,
    };
}

/**
 * Extract protected-area polygons from the Overpass element pool so main.js
 * can paint them as a Leaflet layer. Returns
 *   [{ name, cls, ownership, boundary, rings: [[{lat,lon},...], ...] }, ...]
 * with one entry per OSM area (a relation produces one entry whose `rings`
 * holds all its outer + inner ways flattened).
 */
export function extractProtectedAreas(elements) {
    const out = [];
    for (const el of elements) {
        if (el.tags?.boundary !== 'protected_area' && el.tags?.boundary !== 'national_park') continue;
        const rings = extractRings(el);
        if (rings.length === 0) continue;
        const label = protectedAreaLabel(el);
        out.push({
            id: `${el.type}_${el.id}`,
            name: label.name,
            cls:  label.cls,
            ownership: label.ownership,
            boundary: el.tags.boundary,
            rings,
        });
    }
    return out;
}

function settlementWeight(place, pop) {
    // Larger places "reach further" — their light glow degrades sky further out.
    if (pop > 500_000 || place === 'city') return 4.0;
    if (pop > 50_000  || place === 'town') return 2.0;
    if (place === 'village') return 1.0;
    return 0.5; // hamlet / suburb / neighbourhood
}

export const REACHABILITY_DEFAULTS = {
    ROAD_RADIUS_M,
    SETTLEMENT_RADIUS_M,
    RESIDENTIAL_RADIUS_M,
};
