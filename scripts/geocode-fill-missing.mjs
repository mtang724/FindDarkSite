/**
 * Non-destructive gap-filler for public/data/reddit-locations.json.
 *
 * Unlike geocode-extracted-places.mjs (which rebuilds the whole file from the
 * gitignored .cache/reddit-extracted.json), this reads the SHIPPABLE file
 * in place and only geocodes places that are still missing lat/lng. Every
 * already-located place and all other fields are preserved untouched. Safe to
 * run on a machine that doesn't have the deep-scrape intermediate caches.
 *
 * For each missing place it tries the full name first, then a parenthetical-
 * stripped fallback ("La Ventana Arch (El Malpais NM)" -> "La Ventana Arch"),
 * scoped to the metro's state to avoid homonyms.
 *
 * Run: node scripts/geocode-fill-missing.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'public', 'data', 'reddit-locations.json');

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'FindDarkSite/0.1 (https://github.com/mtang724/FindDarkSite)';
const DELAY_MS = 1100; // Nominatim policy: max 1 req/sec from a single source.

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function geocodeQuery(name, state) {
    // state === '' → nationwide fallback (no state scoping). Many Reddit dark-sky
    // spots are across a state line from the metro, so the metro-state constraint
    // wrongly excludes them; retry without it as a last resort.
    const q = state ? `${name}, ${state}, USA` : `${name}, USA`;
    const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=us&email=finddarksite@users.github.io`;
    const resp = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!resp.ok) throw new Error(`Nominatim ${resp.status}`);
    const json = await resp.json();
    if (!json.length) return null;
    const h = json[0];
    return {
        lat: +parseFloat(h.lat).toFixed(5),
        lng: +parseFloat(h.lon).toFixed(5),
        displayName: h.display_name,
    };
}

// Generate query variants, most-specific first. The parenthetical fallback
// turns "Foo (Bar National Monument)" into both "Foo" and "Bar National Monument".
function variants(name) {
    const out = [name];
    const paren = /\(([^)]+)\)/.exec(name);
    const stripped = name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    if (stripped && stripped !== name) out.push(stripped);
    if (paren && paren[1] && !out.includes(paren[1])) out.push(paren[1].trim());
    return out;
}

async function main() {
    const data = JSON.parse(await readFile(FILE, 'utf8'));

    const missing = [];
    for (const m of data.metros) {
        for (const p of m.places) {
            if (p.lat == null || p.lng == null) missing.push({ p, state: p.state || m.state });
        }
    }
    console.log(`${missing.length} places missing coords (of ${data.metros.reduce((s, m) => s + m.places.length, 0)} total).`);

    const cache = new Map();
    let filled = 0;
    for (let i = 0; i < missing.length; i++) {
        const { p, state } = missing[i];
        let hit = null;
        // Try every name variant scoped to the metro state first (precise, avoids
        // homonyms); only if all of those miss, retry each variant nationwide.
        const vs = variants(p.name);
        const attempts = [...vs.map(v => [v, state]), ...vs.map(v => [v, ''])];
        for (const [v, st] of attempts) {
            const key = `${v.toLowerCase()}|${st}`;
            if (cache.has(key)) { hit = cache.get(key); if (hit) break; else continue; }
            try {
                hit = await geocodeQuery(v, st);
            } catch (err) {
                console.warn(`  ! ${v} (${st || 'US'}): ${err.message}`);
                hit = null;
            }
            cache.set(key, hit);
            await sleep(DELAY_MS);
            if (hit) break;
        }
        if (hit) {
            p.lat = hit.lat; p.lng = hit.lng; p.displayName = hit.displayName;
            filled++;
        }
        if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${missing.length} (${filled} newly located)`);
    }

    // Recompute the geocoded count across the whole file.
    let geocoded = 0;
    for (const m of data.metros) for (const p of m.places) if (p.lat != null && p.lng != null) geocoded++;
    data.geocodedPlaces = geocoded;

    await writeFile(FILE, JSON.stringify(data, null, 2));
    console.log(`Filled ${filled} new coords. geocodedPlaces now ${geocoded}/${data.totalPlaces}. Wrote ${FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
