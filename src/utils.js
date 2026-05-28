/**
 * Utility functions for FindDarkSite
 */

export const EARTH_RADIUS_KM = 6371;

export function toRad(deg) { return deg * Math.PI / 180; }
export function toDeg(rad) { return rad * 180 / Math.PI; }

/**
 * Haversine distance between two coordinates in km
 */
export function haversineDistance(lat1, lng1, lat2, lng2) {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compass bearing from point 1 to point 2
 */
export function bearing(lat1, lng1, lat2, lng2) {
    const dLng = toRad(lng2 - lng1);
    const y = Math.sin(dLng) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
        Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Compass direction string from bearing
 */
export function bearingToDirection(b) {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
        'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(b / 22.5) % 16];
}

/**
 * Convert lightpollutionmap.info WMS pixel intensity (0–255) to approximate
 * VIIRS radiance (nW/cm²/sr). pixel ≤ 5 is treated as natural-dark (radiance 0).
 * pixel 6 → 0.01 nW, pixel 250 → 100 nW on a log scale.
 */
export function pixelToRadiance(pixel) {
    if (pixel <= 5) return 0;
    const k = 4.0 / (250 - 6); // log10(100/0.01) / (250-6)
    return Math.round(0.01 * Math.pow(10, k * (pixel - 6)) * 10000) / 10000;
}

/**
 * Convert VIIRS radiance (nW/cm²/sr) to SQM (mag/arcsec²)
 */
export function radianceToSqm(radiance) {
    if (radiance <= 0) return 22.0;
    // World Atlas approximation: natural sky background ~0.171 nW/cm²/sr
    const sqm = 22.0 - 2.5 * Math.log10(1 + radiance / 0.171);
    return Math.min(22.0, Math.max(16.0, Math.round(sqm * 100) / 100));
}

/**
 * Convert SQM to Bortle class
 */
export function sqmToBortle(sqm) {
    if (sqm >= 21.99) return 1;
    if (sqm >= 21.89) return 2;
    if (sqm >= 21.69) return 3;
    if (sqm >= 20.49) return 4;
    if (sqm >= 19.50) return 5;
    if (sqm >= 18.94) return 6;
    if (sqm >= 18.38) return 7;
    if (sqm >= 17.50) return 8;
    return 9;
}

/**
 * Bortle class description
 */
export function bortleDescription(bortle) {
    const desc = {
        1: 'Excellent Dark',
        2: 'Truly Dark',
        3: 'Rural Sky',
        4: 'Rural/Suburban',
        5: 'Suburban Sky',
        6: 'Bright Suburban',
        7: 'Suburban/Urban',
        8: 'City Sky',
        9: 'Inner City'
    };
    return desc[bortle] || 'Unknown';
}

/**
 * Generate grid points within a circle
 */
export function generateGridPoints(centerLat, centerLng, radiusKm, stepKm) {
    const points = [];
    const latStep = toDeg(stepKm / EARTH_RADIUS_KM);
    const latMin = centerLat - toDeg(radiusKm / EARTH_RADIUS_KM);
    const latMax = centerLat + toDeg(radiusKm / EARTH_RADIUS_KM);

    for (let lat = latMin; lat <= latMax; lat += latStep) {
        const cosLat = Math.cos(toRad(lat));
        if (cosLat === 0) continue;
        const lngStep = toDeg(stepKm / (EARTH_RADIUS_KM * cosLat));
        const lngRange = toDeg(radiusKm / (EARTH_RADIUS_KM * cosLat));
        const lngMin = centerLng - lngRange;
        const lngMax = centerLng + lngRange;

        for (let lng = lngMin; lng <= lngMax; lng += lngStep) {
            if (haversineDistance(centerLat, centerLng, lat, lng) <= radiusKm) {
                points.push({
                    lat: Math.round(lat * 100000) / 100000,
                    lng: Math.round(lng * 100000) / 100000
                });
            }
        }
    }
    return points;
}

/**
 * Format distance for display
 */
export function formatDistance(km) {
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
}

/**
 * Delay helper
 */
export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Escape untrusted text for safe inclusion in an HTML string (innerHTML / template literals)
 */
export function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Return a URL only if it parses and uses http(s); otherwise return '' so callers
 * can fall back. Prevents javascript:/data: URLs from sneaking into href attrs.
 */
export function safeHttpUrl(value) {
    if (!value) return '';
    try {
        const u = new URL(value);
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    } catch { /* fall through */ }
    return '';
}
