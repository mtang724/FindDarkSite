/**
 * Finder — Main orchestrator
 * Two-stage algorithm:
 *   1. Find dark seed points (from pre-computed data or live scan)
 *   2. Search nearby POIs for each seed to verify reachability
 */

import { haversineDistance, bearing, bearingToDirection, sqmToBortle, delay } from './utils.js';
import { liveGridScan, loadScanData } from './lightPollution.js';
import { searchNearbyPOIs, searchRIDBCampgrounds } from './poiSearch.js';

/**
 * @typedef {Object} FinderOptions
 * @property {number} centerLat
 * @property {number} centerLng
 * @property {number} radiusKm
 * @property {number} minSqm
 * @property {number} maxResults
 * @property {string} googleApiKey
 * @property {string} ridbApiKey
 * @property {number} poiRadiusM - POI search radius per seed (default 8000)
 * @property {'precomputed'|'live'} dataSource
 * @property {File} [scanFile] - pre-computed scan JSON file
 * @property {number} [gridStepKm] - for live scan
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
        googleApiKey, ridbApiKey,
        poiRadiusM = 8000,
        dataSource = 'precomputed',
        scanFile, gridStepKm = 5,
        onProgress, onStageChange
    } = options;

    // ─── Stage 1: Get seed points ──────────────────────────────────────────
    onStageChange?.('scanning', 'Finding dark sky areas...');

    let allPoints;

    if (dataSource === 'precomputed' && scanFile) {
        onProgress?.(0, 1, 'Loading scan data...');
        const data = await loadScanData(scanFile);
        allPoints = data.results;
        onProgress?.(1, 1, `Loaded ${allPoints.length} points`);
    } else {
        // Live scan
        allPoints = await liveGridScan({
            centerLat, centerLng, radiusKm,
            stepKm: gridStepKm,
            onProgress: (done, total, result) => {
                onProgress?.(done, total, `Scanning: ${done}/${total} points`);
            }
        });
    }

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

    onStageChange?.('poi-search', `Found ${seeds.length} dark areas, searching for nearby facilities...`);

    // ─── Stage 2: POI search for reachability ──────────────────────────────
    // We don't need to search POIs for ALL seeds — group nearby seeds and search once
    const clusteredSeeds = clusterSeeds(seeds, 5); // cluster within 5km
    const sites = [];
    let poiSearchCount = 0;

    for (let i = 0; i < clusteredSeeds.length && sites.length < maxResults * 2; i++) {
        const seed = clusteredSeeds[i];
        onProgress?.(i + 1, Math.min(clusteredSeeds.length, maxResults * 2),
            `Checking facilities: ${i + 1}/${Math.min(clusteredSeeds.length, maxResults * 2)}`);

        // Search Google Places
        let pois = [];
        if (googleApiKey && googleApiKey !== 'YOUR_GOOGLE_MAPS_API_KEY') {
            pois = await searchNearbyPOIs(googleApiKey, seed.lat, seed.lng, poiRadiusM);
            await delay(200); // rate limit
        }

        // Search RIDB campgrounds
        let campgrounds = [];
        if (ridbApiKey && ridbApiKey !== 'YOUR_RIDB_API_KEY') {
            campgrounds = await searchRIDBCampgrounds(ridbApiKey, seed.lat, seed.lng, poiRadiusM / 1000);
            await delay(200);
        }

        // Merge & deduplicate
        const allPois = mergePOIs([...pois, ...campgrounds], seed.lat, seed.lng);

        poiSearchCount++;

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

    // Stats
    const stats = {
        totalScanned: allPoints.length,
        seedsFound: seeds.length,
        sitesWithFacilities: finalSites.filter(s => s.hasNearbyFacilities).length,
        sitesWithoutFacilities: finalSites.filter(s => !s.hasNearbyFacilities).length,
        totalPOIs: finalSites.reduce((sum, s) => sum + s.pois.length, 0),
        bestSqm: Math.max(...finalSites.map(s => s.sqm)),
        bestBortle: Math.min(...finalSites.map(s => s.bortle)),
    };

    onStageChange?.('done', `Found ${finalSites.length} recommended sites!`);

    return { sites: finalSites, stats };
}

/**
 * Cluster nearby seeds to avoid redundant POI searches
 */
function clusterSeeds(seeds, clusterRadiusKm) {
    const clustered = [];
    const used = new Set();

    for (const seed of seeds) {
        if (used.has(`${seed.lat},${seed.lng}`)) continue;

        // Mark all seeds within clusterRadiusKm as used
        for (const other of seeds) {
            if (haversineDistance(seed.lat, seed.lng, other.lat, other.lng) <= clusterRadiusKm) {
                used.add(`${other.lat},${other.lng}`);
            }
        }

        // Use seed with best SQM from cluster
        clustered.push(seed);
    }

    return clustered;
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
