#!/usr/bin/env node
/**
 * Generate sample scan data for testing FindDarkSite
 * This creates a realistic-looking dataset centered on a US location
 * without actually hitting the lightpollutionmap.info API.
 */

import fs from 'fs';

const CENTER_LAT = 36.24;  // Death Valley area
const CENTER_LNG = -116.82;
const RADIUS_KM = 100;
const STEP_KM = 5;

const EARTH_RADIUS_KM = 6371;
function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

function haversineDistance(lat1, lng1, lat2, lng2) {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function radianceToSqm(radiance) {
    if (radiance <= 0) return 22.0;
    // World Atlas approximation: natural sky background ~0.171 nW/cm²/sr
    const sqm = 22.0 - 2.5 * Math.log10(1 + radiance / 0.171);
    return Math.min(22.0, Math.max(16.0, Math.round(sqm * 100) / 100));
}

function sqmToBortle(sqm) {
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

// Light sources (cities/towns) that increase radiance nearby
const LIGHT_SOURCES = [
    { lat: 36.17, lng: -115.14, intensity: 50, name: 'Las Vegas' },
    { lat: 36.21, lng: -116.77, intensity: 2, name: 'Furnace Creek' },
    { lat: 35.61, lng: -117.67, intensity: 5, name: 'Ridgecrest' },
    { lat: 36.60, lng: -116.47, intensity: 1.5, name: 'Beatty' },
    { lat: 36.04, lng: -115.87, intensity: 3, name: 'Pahrump' },
    { lat: 35.94, lng: -116.27, intensity: 0.5, name: 'Shoshone' },
    { lat: 36.90, lng: -116.76, intensity: 1, name: 'Scotty\'s Junction' },
];

function generateRadiance(lat, lng) {
    // Base radiance for truly dark sky (~0.05-0.15 nW/cm²/sr)
    let radiance = 0.05 + Math.random() * 0.08;

    // Add contribution from each light source (inverse square falloff)
    for (const source of LIGHT_SOURCES) {
        const dist = haversineDistance(lat, lng, source.lat, source.lng);
        if (dist < 0.5) {
            radiance += source.intensity;
            continue;
        }
        radiance += source.intensity / (dist * dist) * 2;
    }

    // Add some natural variation
    radiance += (Math.random() - 0.5) * 0.03;
    radiance = Math.max(0.02, radiance);

    return Math.round(radiance * 10000) / 10000;
}

// Generate grid points
const results = [];
const latStep = toDeg(STEP_KM / EARTH_RADIUS_KM);
const latMin = CENTER_LAT - toDeg(RADIUS_KM / EARTH_RADIUS_KM);
const latMax = CENTER_LAT + toDeg(RADIUS_KM / EARTH_RADIUS_KM);

for (let lat = latMin; lat <= latMax; lat += latStep) {
    const cosLat = Math.cos(toRad(lat));
    const lngStep = toDeg(STEP_KM / (EARTH_RADIUS_KM * cosLat));
    const lngRange = toDeg(RADIUS_KM / (EARTH_RADIUS_KM * cosLat));
    const lngMin = CENTER_LNG - lngRange;
    const lngMax = CENTER_LNG + lngRange;

    for (let lng = lngMin; lng <= lngMax; lng += lngStep) {
        if (haversineDistance(CENTER_LAT, CENTER_LNG, lat, lng) <= RADIUS_KM) {
            const rLat = Math.round(lat * 100000) / 100000;
            const rLng = Math.round(lng * 100000) / 100000;
            const radiance = generateRadiance(rLat, rLng);
            const sqm = radianceToSqm(radiance);
            const bortle = sqmToBortle(sqm);

            results.push({ lat: rLat, lng: rLng, radiance, sqm, bortle });
        }
    }
}

const data = {
    metadata: {
        centerLat: CENTER_LAT,
        centerLng: CENTER_LNG,
        radiusKm: RADIUS_KM,
        stepKm: STEP_KM,
        layer: 'demo_simulated',
        startedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        totalPoints: results.length,
        validPoints: results.filter(r => r.sqm > 0).length,
        note: 'This is SIMULATED demo data for testing. Run scan-grid.js for real data.'
    },
    results
};

const outputFile = 'demo-scan-death-valley.json';
fs.writeFileSync(outputFile, JSON.stringify(data, null, 2));

console.log(`✅ Generated ${results.length} demo data points`);
console.log(`📁 Saved to: ${outputFile}`);
console.log(`\n📊 SQM range: ${Math.min(...results.map(r => r.sqm)).toFixed(1)} - ${Math.max(...results.map(r => r.sqm)).toFixed(1)}`);
console.log(`🌟 Dark sites (SQM ≥ 20.5): ${results.filter(r => r.sqm >= 20.5).length}`);
