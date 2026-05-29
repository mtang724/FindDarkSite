/**
 * Finder — Main orchestrator
 * Two-stage algorithm:
 *   1. Find dark seed points (from pre-computed data or live scan)
 *   2. Search nearby POIs for each seed to verify reachability
 */

import { haversineDistance, bearing, bearingToDirection, sqmToBortle, delay } from './utils.js';
import { liveGridScan, loadScanData } from './lightPollution.js';
import { searchNearbyPOIsBatch, searchRIDBCampgrounds } from './poiSearch.js';
import { fetchElevations } from './elevation.js';
import { fetchForecastsBatch } from './weather.js';
import { fetchDrivingTimes } from './routing.js';

/**
 * @typedef {Object} FinderOptions
 * @property {number} centerLat
 * @property {number} centerLng
 * @property {number} radiusKm
 * @property {number} minSqm
 * @property {number} maxResults
 * @property {string} [ridbApiKey] - Recreation.gov RIDB key (optional)
 * @property {number} poiRadiusM - POI search radius per seed (default 8000)
 * @property {'precomputed'|'live'} dataSource
 * @property {File} [scanFile] - pre-computed scan JSON file (file upload)
 * @property {Object} [scanData] - pre-parsed scan data (dropdown fetch)
 * @property {number} [gridStepKm] - for live scan
 * @property {number} [minElevationM] - drop seeds below this elevation (default 0 = no filter)
 * @property {boolean} [enrichWeather] - fetch cloud-cover forecast for top N (default true)
 * @property {boolean} [enrichDriving] - fetch driving time for top N (default true)
 * @property {Function} onProgress
 * @property {Function} onStageChange
 */

/**
 * Run the two-stage dark site finder
 * @param {FinderOptions} options
 * @returns {{ sites: Array, stats: Object }}
 */
export async function findDarkSites(options) {
    const {
        centerLat, centerLng, radiusKm, minSqm, maxResults = 25,
        ridbApiKey,
        poiRadiusM = 8000,
        dataSource = 'precomputed',
        scanFile, scanData, gridStepKm = 5,
        minElevationM = 0,
        enrichWeather = true,
        enrichDriving = true,
        signal,
        onProgress, onStageChange
    } = options;

    const throwIfAborted = () => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    };

    // ─── Stage 1: Get seed points ──────────────────────────────────────────
    onStageChange?.('scanning', 'Finding dark sky areas...');

    let allPoints;

    if (dataSource === 'precomputed' && (scanFile || scanData)) {
        onProgress?.(0, 1, 'Loading scan data...');
        const data = scanData || await loadScanData(scanFile);
        allPoints = data.results;
        onProgress?.(1, 1, `Loaded ${allPoints.length} points`);
    } else {
        // Live scan
        allPoints = await liveGridScan({
            centerLat, centerLng, radiusKm,
            stepKm: gridStepKm,
            signal,
            onProgress: (done, total, result) => {
                onProgress?.(done, total, `Scanning: ${done}/${total} points`);
            }
        });
    }

    throwIfAborted();

    // Filter by SQM threshold and distance
    const seeds = allPoints
        .filter(r => r.sqm >= minSqm && r.sqm > 0)
        .map(r => ({
            ...r,
            distance: haversineDistance(centerLat, centerLng, r.lat, r.lng),
            bearing: bearing(centerLat, centerLng, r.lat, r.lng),
            direction: bearingToDirection(bearing(centerLat, centerLng, r.lat, r.lng)),
            bortle: sqmToBortle(r.sqm)
        }))
        .filter(r => r.distance <= radiusKm)
        .sort((a, b) => a.distance - b.distance);

    // ─── Stage 2: POI search for reachability ──────────────────────────────
    // We don't need to search POIs for ALL seeds — group nearby seeds first,
    // then make ONE Overpass query covering every cluster center at once.
    const clusteredSeeds = clusterSeeds(seeds, 5); // cluster within 5km
    let candidateSeeds = clusteredSeeds.slice(0, maxResults * 2);

    // ─── Stage 2a: Elevation enrichment (cheap, all candidates) ────────────
    if (candidateSeeds.length > 0) {
        onStageChange?.('elevation', `Looking up elevation for ${candidateSeeds.length} sites...`);
        const elevs = await fetchElevations(
            candidateSeeds.map(s => ({ lat: s.lat, lng: s.lng })),
            signal
        );
        throwIfAborted();
        candidateSeeds.forEach((s, i) => { s.elevationM = elevs[i] ?? null; });
        if (minElevationM > 0) {
            candidateSeeds = candidateSeeds.filter(
                s => s.elevationM == null || s.elevationM >= minElevationM
            );
        }
    }

    onStageChange?.('poi-search', `Found ${candidateSeeds.length} dark areas, searching for nearby facilities...`);
    onProgress?.(0, 1, `Fetching facilities for ${candidateSeeds.length} dark areas...`);
    const overpassResult = candidateSeeds.length
        ? await searchNearbyPOIsBatch(candidateSeeds.map(s => ({ lat: s.lat, lng: s.lng })), poiRadiusM, signal)
        : { pois: [], error: null };
    const overpassPOIs = overpassResult.pois;
    const overpassError = overpassResult.error;
    onProgress?.(1, 1, overpassError
        ? `Overpass call failed — see results panel for details`
        : `Got ${overpassPOIs.length} OSM facilities`);
    throwIfAborted();

    const poiRadiusKm = poiRadiusM / 1000;
    const useRidb = ridbApiKey && ridbApiKey !== 'YOUR_RIDB_API_KEY';
    const sites = [];

    for (let i = 0; i < candidateSeeds.length; i++) {
        throwIfAborted();
        const seed = candidateSeeds[i];
        onProgress?.(i + 1, candidateSeeds.length,
            `Checking facilities: ${i + 1}/${candidateSeeds.length}`);

        // Per-seed: filter the batched Overpass result to POIs within poiRadius of THIS seed
        const localOsm = overpassPOIs.filter(p =>
            haversineDistance(seed.lat, seed.lng, p.lat, p.lng) <= poiRadiusKm
        );

        // RIDB still per-seed (it has its own radius parameter; calls are fast)
        let campgrounds = [];
        if (useRidb) {
            campgrounds = await searchRIDBCampgrounds(ridbApiKey, seed.lat, seed.lng, poiRadiusKm, signal);
            await delay(200);
        }

        const allPois = mergePOIs([...localOsm, ...campgrounds], seed.lat, seed.lng);
        sites.push({
            ...seed,
            pois: allPois,
            hasNearbyFacilities: allPois.length > 0,
            amenityCounts: countAmenities(allPois),
        });
    }

    // Sort: prioritize sites with facilities, then by distance
    sites.sort((a, b) => {
        // Sites with facilities first
        if (a.hasNearbyFacilities && !b.hasNearbyFacilities) return -1;
        if (!a.hasNearbyFacilities && b.hasNearbyFacilities) return 1;
        // Then by distance
        return a.distance - b.distance;
    });

    const finalSites = sites.slice(0, maxResults);

    // ─── Stage 3: Enrich top sites with weather & driving time ─────────────
    // Cap network calls — these hit external APIs per-site.
    const ENRICH_TOP_N = Math.min(finalSites.length, 12);
    const topSites = finalSites.slice(0, ENRICH_TOP_N);

    if (enrichWeather && topSites.length > 0) {
        onStageChange?.('weather', `Fetching cloud-cover forecast for top ${topSites.length}...`);
        try {
            const forecasts = await fetchForecastsBatch(
                topSites.map(s => ({ lat: s.lat, lng: s.lng })),
                signal,
                (done, total) => onProgress?.(done, total, `Weather: ${done}/${total}`)
            );
            topSites.forEach((s, i) => { s.forecast = forecasts[i]?.nights || []; });
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            console.warn('Weather enrichment failed:', err.message);
        }
    }
    throwIfAborted();

    if (enrichDriving && topSites.length > 0) {
        onStageChange?.('driving', `Fetching driving time for top ${topSites.length}...`);
        try {
            const drives = await fetchDrivingTimes(
                centerLat, centerLng,
                topSites.map(s => ({ lat: s.lat, lng: s.lng })),
                signal,
                (done, total) => onProgress?.(done, total, `Driving time: ${done}/${total}`)
            );
            topSites.forEach((s, i) => { s.driving = drives[i] || null; });
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            console.warn('Driving enrichment failed:', err.message);
        }
    }
    throwIfAborted();

    // Stats
    const stats = {
        totalScanned: allPoints.length,
        seedsFound: seeds.length,
        sitesWithFacilities: finalSites.filter(s => s.hasNearbyFacilities).length,
        sitesWithoutFacilities: finalSites.filter(s => !s.hasNearbyFacilities).length,
        totalPOIs: finalSites.reduce((sum, s) => sum + s.pois.length, 0),
        bestSqm: finalSites.length ? Math.max(...finalSites.map(s => s.sqm)) : null,
        bestBortle: finalSites.length ? Math.min(...finalSites.map(s => s.bortle)) : null,
        overpassError, // null on success, error message string when every Overpass call failed
    };

    onStageChange?.('done', `Found ${finalSites.length} recommended sites!`);

    return { sites: finalSites, stats };
}

/**
 * Cluster nearby seeds to avoid redundant POI searches.
 * Iterates from darkest seed downward; each cluster's representative is the
 * darkest unused seed, and all other seeds within clusterRadiusKm are absorbed.
 */
function clusterSeeds(seeds, clusterRadiusKm) {
    const byDarkness = [...seeds].sort((a, b) => b.sqm - a.sqm);
    const clustered = [];
    const used = new Set();

    for (const seed of byDarkness) {
        const key = `${seed.lat},${seed.lng}`;
        if (used.has(key)) continue;

        for (const other of byDarkness) {
            if (haversineDistance(seed.lat, seed.lng, other.lat, other.lng) <= clusterRadiusKm) {
                used.add(`${other.lat},${other.lng}`);
            }
        }
        clustered.push(seed);
    }

    // Preserve distance-ascending order for downstream POI work / progress UX
    return clustered.sort((a, b) => a.distance - b.distance);
}

/**
 * Merge and deduplicate POIs, adding distance from seed
 */
function mergePOIs(pois, seedLat, seedLng) {
    const seen = new Set();
    return pois
        .filter(p => {
            const key = p.placeId || `${p.lat},${p.lng}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .map(p => ({
            ...p,
            distanceFromSeed: haversineDistance(seedLat, seedLng, p.lat, p.lng)
        }))
        .sort((a, b) => a.distanceFromSeed - b.distanceFromSeed);
}

/**
 * Count amenities by category
 */
function countAmenities(pois) {
    const counts = {};
    const categoryMap = {
        campground: '🏕️ Campgrounds',
        rv_park: '🚐 RV Parks',
        parking: '🅿️ Parking',
        lodging: '🏨 Lodging',
        park: '🌲 Parks',
        national_park: '🌲 Parks',
        tourist_attraction: '📍 Attractions',
    };

    for (const poi of pois) {
        for (const type of poi.types) {
            const label = categoryMap[type];
            if (label) {
                counts[label] = (counts[label] || 0) + 1;
            }
        }
    }

    // If no specific category matched, count as generic
    if (Object.keys(counts).length === 0 && pois.length > 0) {
        counts['📍 Places'] = pois.length;
    }

    return counts;
}
