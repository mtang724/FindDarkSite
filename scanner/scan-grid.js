#!/usr/bin/env node
/**
 * FindDarkSite — Standalone Grid Scanner
 * 
 * Run this on your server to pre-compute light pollution data for a region.
 * It queries lightpollutionmap.info's GeoServer WMS endpoint for each grid point
 * and saves results to a JSON file.
 * 
 * Usage:
 *   node scan-grid.js --lat 34.05 --lng -118.24 --radius 200 --step 5
 *   node scan-grid.js --lat 34.05 --lng -118.24 --radius 200 --step 5 --output my-scan.json
 *   node scan-grid.js --resume my-scan.json   # resume an interrupted scan
 * 
 * Output: JSON file with array of {lat, lng, radiance, sqm, bortle}
 * 
 * Rate limiting: ~2 requests/sec to be respectful. 
 * A 200km radius at 5km step ≈ 5000 points ≈ ~42 min.
 * A 300km radius at 5km step ≈ 11300 points ≈ ~95 min.
 */

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const parsed = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--lat') parsed.lat = parseFloat(args[++i]);
        else if (args[i] === '--lng') parsed.lng = parseFloat(args[++i]);
        else if (args[i] === '--radius') parsed.radius = parseFloat(args[++i]);
        else if (args[i] === '--step') parsed.step = parseFloat(args[++i]);
        else if (args[i] === '--output') parsed.output = args[++i];
        else if (args[i] === '--resume') parsed.resume = args[++i];
        else if (args[i] === '--layer') parsed.layer = args[++i];
        else if (args[i] === '--delay') parsed.delay = parseInt(args[++i]);
        else if (args[i] === '--help' || args[i] === '-h') {
            printHelp();
            process.exit(0);
        }
    }
    return parsed;
}

function printHelp() {
    console.log(`
FindDarkSite Grid Scanner
========================

Scans a grid of coordinates for light pollution data and saves to JSON.

Options:
  --lat <number>      Center latitude (required unless --resume)
  --lng <number>      Center longitude (required unless --resume)  
  --radius <km>       Search radius in km (default: 200)
  --step <km>         Grid step size in km (default: 5)
  --output <file>     Output JSON filename (default: scan_<lat>_<lng>_<radius>km.json)
  --resume <file>     Resume an interrupted scan from existing JSON file
  --layer <name>      VIIRS layer name (default: VIIRS_2023)
  --delay <ms>        Delay between requests in ms (default: 500)
  --help, -h          Show this help

Examples:
  # Scan 200km around Los Angeles at 5km resolution
  node scan-grid.js --lat 34.05 --lng -118.24 --radius 200 --step 5

  # Scan 100km around your location with finer resolution
  node scan-grid.js --lat 40.71 --lng -74.01 --radius 100 --step 3

  # Resume an interrupted scan
  node scan-grid.js --resume scan_34.05_-118.24_200km.json
  `);
}

// ─── Geo Utilities ───────────────────────────────────────────────────────────

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

function generateGridPoints(centerLat, centerLng, radiusKm, stepKm) {
    const points = [];
    const latStep = toDeg(stepKm / EARTH_RADIUS_KM);
    const latMin = centerLat - toDeg(radiusKm / EARTH_RADIUS_KM);
    const latMax = centerLat + toDeg(radiusKm / EARTH_RADIUS_KM);

    for (let lat = latMin; lat <= latMax; lat += latStep) {
        const lngStep = toDeg(stepKm / (EARTH_RADIUS_KM * Math.cos(toRad(lat))));
        const lngRange = toDeg(radiusKm / (EARTH_RADIUS_KM * Math.cos(toRad(lat))));
        const lngMin = centerLng - lngRange;
        const lngMax = centerLng + lngRange;

        for (let lng = lngMin; lng <= lngMax; lng += lngStep) {
            // Double check it's within the circle
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

// ─── Light Pollution API ─────────────────────────────────────────────────────

// The lightpollutionmap.info GeoServer WMS returns grayscale pixel values (0-255).
// This maps pixel brightness to approximate VIIRS radiance (nW/cm²/sr) using
// a logarithmic scale derived from the site's rendering:
//   pixel ≤5   => ~0 nW   (no artificial light — Bortle 1)
//   pixel ~50  => ~0.17 nW (natural sky background level — Bortle 4)
//   pixel ~128 => ~2 nW    (suburban — Bortle 6-7)
//   pixel ~250 => ~100 nW  (city center — Bortle 9)
function pixelToRadiance(pixel) {
    if (pixel <= 5) return 0;  // darkest reading — no artificial light
    // Logarithmic mapping from pixel 6-255 to radiance 0.01-100 nW
    // radiance = 0.01 * 10^(k * (pixel - 6))  where pixel=250 → 100 nW
    // k = log10(100 / 0.01) / (250 - 6) = 4 / 244 ≈ 0.01639
    var k = 4.0 / (250 - 6);
    return Math.round(0.01 * Math.pow(10, k * (pixel - 6)) * 10000) / 10000;
}

function radianceToSqm(radiance) {
    if (radiance <= 0) return 22.0;
    // World Atlas approximation: natural sky background ~0.171 nW/cm²/sr
    var sqm = 22.0 - 2.5 * Math.log10(1 + radiance / 0.171);
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

var WMS_BASE = 'https://www.lightpollutionmap.info/geoserver/gwc/service/wms';

function fetchUrl(url) {
    return new Promise(function (resolve, reject) {
        var client = url.startsWith('https') ? https : http;
        var req = client.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; FindDarkSite-Scanner/1.0)',
                'Accept': 'application/json, */*',
            }
        }, function (res) {
            if (res.statusCode === 301 || res.statusCode === 302) {
                fetchUrl(res.headers.location).then(resolve).catch(reject);
                return;
            }
            var data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () { resolve({ status: res.statusCode, data: data }); });
        });
        req.on('error', reject);
        req.setTimeout(15000, function () { req.destroy(); reject(new Error('Timeout')); });
    });
}

function queryRadiance(lat, lng, layer) {
    layer = layer || 'VIIRS_2023';
    // Build WMS GetFeatureInfo URL.
    // Use a small BBOX centered on the point in EPSG:4326.
    var d = 0.005; // ~0.5km at mid-latitudes
    var bbox = (lng - d) + ',' + (lat - d) + ',' + (lng + d) + ',' + (lat + d);
    var url = WMS_BASE +
        '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo' +
        '&LAYERS=PostGIS:' + layer +
        '&QUERY_LAYERS=PostGIS:' + layer +
        '&INFO_FORMAT=application/json' +
        '&SRS=EPSG:4326' +
        '&BBOX=' + bbox +
        '&WIDTH=256&HEIGHT=256&X=128&Y=128';

    return fetchUrl(url).then(function (resp) {
        if (resp.status !== 200) {
            throw new Error('HTTP ' + resp.status);
        }

        var json = JSON.parse(resp.data);
        if (!json.features || json.features.length === 0) {
            return { radiance: -1, sqm: -1, bortle: -1, raw: 'no features' };
        }

        var props = json.features[0].properties;
        var pixel = props.RED_BAND || props.GRAY_INDEX || 0;

        if (pixel <= 0) {
            return { radiance: -1, sqm: -1, bortle: -1, pixel: pixel };
        }

        var radiance = pixelToRadiance(pixel);
        var sqm = radianceToSqm(radiance);
        var bortle = sqmToBortle(sqm);
        return { radiance: radiance, sqm: sqm, bortle: bortle, pixel: pixel };
    }).catch(function (err) {
        return { radiance: -1, sqm: -1, bortle: -1, error: err.message };
    });
}

// ─── Progress & Save ─────────────────────────────────────────────────────────

function formatDuration(ms) {
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const hr = Math.floor(min / 60);
    if (hr > 0) return `${hr}h ${min % 60}m ${sec % 60}s`;
    if (min > 0) return `${min}m ${sec % 60}s`;
    return `${sec}s`;
}

function printProgress(done, total, startTime, lastResult) {
    const pct = ((done / total) * 100).toFixed(1);
    const elapsed = Date.now() - startTime;
    const rate = done / (elapsed / 1000);
    const eta = (total - done) / rate * 1000;
    const sqmStr = (lastResult && lastResult.sqm > 0) ? 'SQM=' + lastResult.sqm : 'n/a';

    process.stdout.write(
        `\r[${done}/${total}] ${pct}% | ${sqmStr} | ` +
        `${rate.toFixed(1)} pts/sec | ETA: ${formatDuration(eta)}    `
    );
}

function saveResults(outputFile, metadata, results) {
    const data = {
        metadata: {
            ...metadata,
            lastUpdated: new Date().toISOString(),
            totalPoints: results.length,
            validPoints: results.filter(r => r.sqm > 0).length,
        },
        results
    };
    fs.writeFileSync(outputFile, JSON.stringify(data, null, 2));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const opts = parseArgs();

    let metadata, allPoints, results, outputFile, startIndex;

    if (opts.resume) {
        // Resume mode
        console.log(`📂 Resuming scan from ${opts.resume}...`);
        const existing = JSON.parse(fs.readFileSync(opts.resume, 'utf-8'));
        metadata = existing.metadata;
        results = existing.results;
        outputFile = opts.resume;

        // Regenerate full grid to know what's left
        allPoints = generateGridPoints(
            metadata.centerLat, metadata.centerLng,
            metadata.radiusKm, metadata.stepKm
        );

        // Build a set of already-scanned points
        const scannedSet = new Set(results.map(r => `${r.lat},${r.lng}`));
        const remaining = allPoints.filter(p => !scannedSet.has(`${p.lat},${p.lng}`));

        console.log(`✅ Found ${results.length} existing results, ${remaining.length} remaining`);
        allPoints = remaining;
        startIndex = results.length;
    } else {
        // New scan
        if (!opts.lat || !opts.lng) {
            console.error('❌ --lat and --lng are required. Use --help for options.');
            process.exit(1);
        }

        const lat = opts.lat;
        const lng = opts.lng;
        const radius = opts.radius || 200;
        const step = opts.step || 5;
        var layer = opts.layer || 'VIIRS_2023';

        metadata = {
            centerLat: lat,
            centerLng: lng,
            radiusKm: radius,
            stepKm: step,
            layer,
            startedAt: new Date().toISOString(),
        };

        outputFile = opts.output || `scan_${lat}_${lng}_${radius}km.json`;
        allPoints = generateGridPoints(lat, lng, radius, step);
        results = [];
        startIndex = 0;

        console.log(`🌌 FindDarkSite Grid Scanner`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`📍 Center: ${lat}, ${lng}`);
        console.log(`📏 Radius: ${radius} km | Step: ${step} km`);
        console.log(`📊 Total grid points: ${allPoints.length}`);
        console.log(`📁 Output: ${outputFile}`);
        console.log(`⏱️  Est. time: ${formatDuration(allPoints.length * (opts.delay || 500))}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log('');
    }

    const delay = opts.delay || 500;
    var layer = metadata.layer || 'VIIRS_2023';
    const totalPoints = startIndex + allPoints.length;
    const startTime = Date.now();
    let errorCount = 0;
    let saveInterval = 100; // Save every 100 points

    // Handle graceful shutdown
    let interrupted = false;
    process.on('SIGINT', () => {
        if (interrupted) process.exit(1);
        interrupted = true;
        console.log('\n\n⚠️  Interrupted! Saving progress...');
        saveResults(outputFile, metadata, results);
        console.log(`💾 Saved ${results.length} results to ${outputFile}`);
        console.log(`   Resume with: node scan-grid.js --resume ${outputFile}`);
        process.exit(0);
    });

    for (let i = 0; i < allPoints.length; i++) {
        if (interrupted) break;

        const { lat, lng } = allPoints[i];
        const result = await queryRadiance(lat, lng, layer);

        results.push({ lat, lng, ...result });

        if (result.error) errorCount++;

        printProgress(startIndex + i + 1, totalPoints, startTime, result);

        // Periodic save
        if ((i + 1) % saveInterval === 0) {
            saveResults(outputFile, metadata, results);
        }

        // Throttle
        if (i < allPoints.length - 1) {
            await new Promise(r => setTimeout(r, delay));
        }
    }

    // Final save
    saveResults(outputFile, metadata, results);

    console.log('\n');
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`✅ Scan complete!`);
    console.log(`📊 Total: ${results.length} points | Valid: ${results.filter(r => r.sqm > 0).length} | Errors: ${errorCount}`);
    console.log(`⏱️  Duration: ${formatDuration(Date.now() - startTime)}`);
    console.log(`💾 Saved to: ${outputFile}`);

    // Quick stats
    const validResults = results.filter(r => r.sqm > 0);
    if (validResults.length > 0) {
        const sqms = validResults.map(r => r.sqm).sort((a, b) => b - a);
        console.log(`\n🌟 SQM Stats:`);
        console.log(`   Best:    ${sqms[0]} (Bortle ${sqmToBortle(sqms[0])})`);
        console.log(`   Median:  ${sqms[Math.floor(sqms.length / 2)]} (Bortle ${sqmToBortle(sqms[Math.floor(sqms.length / 2)])})`);
        console.log(`   Worst:   ${sqms[sqms.length - 1]} (Bortle ${sqmToBortle(sqms[sqms.length - 1])})`);

        const bortleCounts = {};
        validResults.forEach(r => {
            bortleCounts[r.bortle] = (bortleCounts[r.bortle] || 0) + 1;
        });
        console.log(`\n📊 Bortle Distribution:`);
        for (let b = 1; b <= 9; b++) {
            if (bortleCounts[b]) {
                const bar = '█'.repeat(Math.ceil(bortleCounts[b] / validResults.length * 50));
                console.log(`   Bortle ${b}: ${bar} ${bortleCounts[b]} (${(bortleCounts[b] / validResults.length * 100).toFixed(1)}%)`);
            }
        }
    }

    console.log(`\n📋 Next step: Copy ${outputFile} to public/data/ in your FindDarkSite web app.`);
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    process.exit(1);
});
