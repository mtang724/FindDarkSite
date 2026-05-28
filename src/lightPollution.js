/**
 * Light Pollution data module
 * Handles both pre-computed scan data and live API queries.
 *
 * Live queries go through the lightpollutionmap.info GeoServer WMS
 * GetFeatureInfo endpoint — same protocol as scanner/*. In dev we route via
 * the Vite proxy at /api/lp to bypass CORS; in prod we hit the upstream
 * directly (browsers will likely block this without a server-side proxy).
 */

import { get, set } from 'idb-keyval';
import {
    radianceToSqm, sqmToBortle, pixelToRadiance,
    generateGridPoints, delay, haversineDistance
} from './utils.js';

const WMS_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.DEV)
    ? '/api/lp'
    : 'https://www.lightpollutionmap.info/geoserver/gwc/service/wms';
const DEFAULT_LAYER = 'VIIRS_2023';
const REQUEST_DELAY_MS = 500; // 2 req/sec

function buildWmsUrl(lat, lng, layer) {
    const d = 0.005; // ~0.5km at mid-latitudes
    const bbox = `${lng - d},${lat - d},${lng + d},${lat + d}`;
    const params = new URLSearchParams({
        SERVICE: 'WMS',
        VERSION: '1.1.1',
        REQUEST: 'GetFeatureInfo',
        LAYERS: `PostGIS:${layer}`,
        QUERY_LAYERS: `PostGIS:${layer}`,
        INFO_FORMAT: 'application/json',
        SRS: 'EPSG:4326',
        BBOX: bbox,
        WIDTH: '256',
        HEIGHT: '256',
        X: '128',
        Y: '128',
    });
    return `${WMS_BASE}?${params.toString()}`;
}

/**
 * Query light pollution radiance for a single point.
 * Returns { radiance, sqm, bortle, pixel } on success,
 *         { radiance: -1, sqm: -1, bortle: -1, error } on failure.
 * Only successful results are cached; errors are retried next run.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {string} [layer]
 * @param {AbortSignal} [signal]
 */
export async function queryRadiance(lat, lng, layer = DEFAULT_LAYER, signal) {
    const cacheKey = `lp_${lat}_${lng}_${layer}`;
    const cached = await get(cacheKey);
    if (cached) return { ...cached, _cached: true };

    try {
        const resp = await fetch(buildWmsUrl(lat, lng, layer), {
            headers: { 'Accept': 'application/json, */*' },
            signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const json = await resp.json();
        const features = json.features || [];
        if (features.length === 0) {
            return { radiance: -1, sqm: -1, bortle: -1, error: 'no features' };
        }

        const props = features[0].properties || {};
        // Distinguish "missing key" (no data) from legitimate pixel 0 (truly dark).
        const rawPixel = props.RED_BAND ?? props.GRAY_INDEX;
        if (rawPixel == null) {
            return { radiance: -1, sqm: -1, bortle: -1, error: 'no pixel' };
        }

        const pixel = Number(rawPixel);
        if (!Number.isFinite(pixel) || pixel < 0) {
            return { radiance: -1, sqm: -1, bortle: -1, error: 'bad pixel' };
        }

        const radiance = pixelToRadiance(pixel);
        const sqm = radianceToSqm(radiance);
        const bortle = sqmToBortle(sqm);
        const result = { radiance, sqm, bortle, pixel };

        // Cache only successful, well-formed results
        await set(cacheKey, result);
        return result;
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        console.warn(`Failed to query radiance for ${lat},${lng}:`, err.message);
        return { radiance: -1, sqm: -1, bortle: -1, error: err.message };
    }
}

/**
 * Live grid scan — queries lightpollutionmap.info for each grid point.
 * @param {Object} options
 * @param {number} options.centerLat
 * @param {number} options.centerLng
 * @param {number} options.radiusKm
 * @param {number} options.stepKm
 * @param {string} [options.layer]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onProgress] - (done, total, lastResult) => void
 * @returns {Promise<Array>}
 */
export async function liveGridScan({
    centerLat, centerLng, radiusKm, stepKm,
    layer = DEFAULT_LAYER, signal, onProgress,
}) {
    const points = generateGridPoints(centerLat, centerLng, radiusKm, stepKm);
    const results = [];

    for (let i = 0; i < points.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const { lat, lng } = points[i];
        const result = await queryRadiance(lat, lng, layer, signal);
        results.push({ lat, lng, ...result });

        onProgress?.(i + 1, points.length, result);

        // Only throttle when we actually hit the network
        if (!result._cached && i < points.length - 1) {
            await delay(REQUEST_DELAY_MS);
        }
    }

    return results;
}

/**
 * Load pre-computed scan data from a JSON file
 * @param {File} file - JSON file from scan-grid.js
 * @returns {Promise<{ metadata: Object, results: Array }>}
 */
export async function loadScanData(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                if (!data.results || !Array.isArray(data.results)) {
                    throw new Error('Invalid scan data format');
                }
                resolve(data);
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
    });
}

/**
 * Filter scan results by SQM threshold and distance from center
 * @returns {Array} filtered results sorted by SQM descending
 */
export function filterSeedPoints(results, { minSqm, centerLat, centerLng, radiusKm }) {
    return results
        .filter(r => r.sqm >= minSqm && r.sqm > 0)
        .filter(r => {
            if (centerLat != null && centerLng != null && radiusKm != null) {
                return haversineDistance(centerLat, centerLng, r.lat, r.lng) <= radiusKm;
            }
            return true;
        })
        .sort((a, b) => b.sqm - a.sqm);
}
