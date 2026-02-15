/**
 * Light Pollution data module
 * Handles both pre-computed scan data and live API queries
 */

import { get, set } from 'idb-keyval';
import { radianceToSqm, sqmToBortle, generateGridPoints, delay, haversineDistance } from './utils.js';

const QUERY_RASTER_URL = 'https://www.lightpollutionmap.info/QueryRaster/';
const DEFAULT_LAYER = 'viirs_2023';
const REQUEST_DELAY_MS = 500; // 2 req/sec

/**
 * Query light pollution radiance for a single point via lightpollutionmap.info
 * Returns { radiance, sqm, bortle } or null on error
 */
export async function queryRadiance(lat, lng, layer = DEFAULT_LAYER) {
    // Check IndexedDB cache first
    const cacheKey = `lp_${lat}_${lng}_${layer}`;
    const cached = await get(cacheKey);
    if (cached) return cached;

    try {
        const url = `${QUERY_RASTER_URL}?ql=${layer}&qd=${lat},${lng}`;
        const resp = await fetch(url, {
            headers: { 'Accept': '*/*' }
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const text = await resp.text();
        const parts = text.trim().split(',');
        const readings = parts[0].split(';');
        const latestReading = readings[readings.length - 1];
        const radiance = parseFloat(latestReading);

        if (isNaN(radiance)) {
            return { radiance: -1, sqm: -1, bortle: -1 };
        }

        const sqm = radianceToSqm(radiance);
        const bortle = sqmToBortle(sqm);
        const result = { radiance, sqm, bortle };

        // Cache in IndexedDB
        await set(cacheKey, result);
        return result;
    } catch (err) {
        console.warn(`Failed to query radiance for ${lat},${lng}:`, err.message);
        return { radiance: -1, sqm: -1, bortle: -1, error: err.message };
    }
}

/**
 * Live grid scan — queries lightpollutionmap.info for each grid point
 * @param {Object} options
 * @param {Function} onProgress - (done, total, lastResult) => void
 * @returns {Array} results
 */
export async function liveGridScan({ centerLat, centerLng, radiusKm, stepKm, onProgress }) {
    const points = generateGridPoints(centerLat, centerLng, radiusKm, stepKm);
    const results = [];

    for (let i = 0; i < points.length; i++) {
        const { lat, lng } = points[i];
        const result = await queryRadiance(lat, lng);
        results.push({ lat, lng, ...result });

        if (onProgress) {
            onProgress(i + 1, points.length, result);
        }

        // Throttle (skip if cached — queryRadiance returns from cache instantly)
        if (!result._cached && i < points.length - 1) {
            await delay(REQUEST_DELAY_MS);
        }
    }

    return results;
}

/**
 * Load pre-computed scan data from a JSON file
 * @param {File} file - JSON file from scan-grid.js
 * @returns {{ metadata, results }}
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
