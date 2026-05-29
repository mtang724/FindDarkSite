/**
 * GLOBE at Night citizen-science sky-brightness observations.
 *   https://globeatnight.org/maps.php   (data downloads)
 *
 * NSF NOIRLab's open dataset of human-observer + SQM readings worldwide.
 * Each record has lat/lng + SQMReading (digital) + LimitingMag (naked eye) +
 * the observer's free-text LocationComment, which is gold for "what's actually
 * here". We bake the US subset of the last two years into a slim JSON the app
 * can load and render as a map overlay.
 *
 * Run: node scripts/fetch-globe-at-night.mjs
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public', 'data', 'sqm-reports.json');

// 2024 + 2025 — fresh enough that sites haven't drifted yet.
const SOURCES = [
    { year: 2025, url: 'https://globeatnight.org/documents/1189/GaN2025.json' },
    { year: 2024, url: 'https://globeatnight.org/documents/925/GaN2024.json' },
];

async function fetchYear(src) {
    const resp = await fetch(src.url, {
        headers: { 'User-Agent': 'FindDarkSite/0.1 (https://github.com/mtang724/FindDarkSite)' },
    });
    if (!resp.ok) throw new Error(`${src.year}: HTTP ${resp.status}`);
    return await resp.json();
}

function main() { return run(); }

async function run() {
    const all = [];
    for (const src of SOURCES) {
        console.log(`Fetching GLOBE at Night ${src.year}…`);
        const recs = await fetchYear(src);
        console.log(`  raw rows: ${recs.length}`);
        all.push(...recs);
    }

    // Filter to US, with valid coordinates and at least one usable reading.
    const cleaned = [];
    for (const r of all) {
        if (!r.Country?.startsWith('United States')) continue;
        const lat = Number(r.Latitude), lng = Number(r.Longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const sqm = r.SQMReading != null && r.SQMReading !== '' ? Number(r.SQMReading) : null;
        const lim = r.LimitingMag != null && r.LimitingMag !== '' ? Number(r.LimitingMag) : null;
        if (sqm == null && lim == null) continue;
        cleaned.push({
            id: r.ID,
            lat: +lat.toFixed(5),
            lng: +lng.toFixed(5),
            elevationM: r['Elevation(m)'] != null ? +Number(r['Elevation(m)']).toFixed(0) : null,
            date: r.LocalDate || null,
            sqm: sqm != null && sqm > 14 && sqm < 23 ? +sqm.toFixed(2) : null,
            limitingMag: lim != null && lim >= 1 && lim <= 8 ? +lim.toFixed(1) : null,
            cloud: r.CloudCover || null,
            comment: (r.LocationComment || '').trim().slice(0, 160) || null,
            stateCountry: r.Country, // keep as-is for filtering later
        });
    }

    // Dedupe near-identical reports (same place, same observer same week).
    // Aggressive: round lat/lng to 4 dp + date to year-month, take the latest.
    const dedup = new Map();
    for (const r of cleaned) {
        const key = `${r.lat.toFixed(4)}_${r.lng.toFixed(4)}_${(r.date || '').slice(0, 7)}`;
        const prev = dedup.get(key);
        if (!prev || (r.date && (!prev.date || r.date > prev.date))) dedup.set(key, r);
    }
    const reports = [...dedup.values()];
    reports.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const payload = {
        source: 'GLOBE at Night (NSF NOIRLab). Public citizen-science dataset.',
        license: 'CC BY 4.0 (citation requested)',
        attribution: 'https://globeatnight.org/',
        years: SOURCES.map(s => s.year),
        generatedAt: new Date().toISOString(),
        count: reports.length,
        reports,
    };

    await writeFile(OUT, JSON.stringify(payload));
    console.log(`Wrote ${OUT} (${reports.length} US reports, ${(JSON.stringify(payload).length / 1024).toFixed(0)} KB).`);

    // Tiny breakdown
    const withSqm = reports.filter(r => r.sqm != null).length;
    const withLim = reports.filter(r => r.limitingMag != null).length;
    console.log(`  with SQM reading: ${withSqm}`);
    console.log(`  with limiting magnitude only: ${reports.length - withSqm}`);
    console.log(`  with both: ${reports.filter(r => r.sqm != null && r.limitingMag != null).length}`);
    console.log(`  pristine (SQM ≥ 21.5): ${reports.filter(r => r.sqm != null && r.sqm >= 21.5).length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
