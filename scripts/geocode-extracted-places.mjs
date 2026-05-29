/**
 * Take the LLM-extracted Reddit locations file
 *   scripts/.cache/reddit-extracted.json   ([{metro, name, why, sentiment, sourceUrl}, ...])
 * and resolve each `name` to (lat, lng) via Nominatim. Results are scoped to
 * the metro's state to avoid global homonyms ("Springfield" matching the
 * wrong one). Writes the final shippable file:
 *   public/data/reddit-locations.json
 *
 * Run: node scripts/geocode-extracted-places.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IN  = path.join(__dirname, '.cache', 'reddit-extracted.json');
const OUT = path.join(__dirname, '..', 'public', 'data', 'reddit-locations.json');

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'FindDarkSite/0.1 (https://github.com/mtang724/FindDarkSite)';
// Nominatim usage policy: max 1 req/sec from a single source.
const DELAY_MS = 1100;

async function geocode(name, state, country = 'us') {
    const q = `${name}, ${state}, USA`;
    const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=${country}&email=finddarksite@users.github.io`;
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

async function main() {
    const extracted = JSON.parse(await readFile(IN, 'utf8'));
    console.log(`Geocoding ${extracted.length} extracted places…`);

    // Cache by query so duplicate names within a metro don't re-fetch.
    const cache = new Map();
    let withCoords = 0;
    for (let i = 0; i < extracted.length; i++) {
        const p = extracted[i];
        const key = `${p.name.toLowerCase()}|${p.state || ''}`;
        if (cache.has(key)) {
            const c = cache.get(key);
            if (c) Object.assign(p, c);
            if (c) withCoords++;
            continue;
        }
        try {
            const c = await geocode(p.name, p.state || '');
            cache.set(key, c);
            if (c) {
                p.lat = c.lat; p.lng = c.lng; p.displayName = c.displayName;
                withCoords++;
            }
        } catch (err) {
            console.warn(`  ! ${p.name} (${p.state}): ${err.message}`);
            cache.set(key, null);
        }
        if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${extracted.length} (${withCoords} located)`);
        await new Promise(r => setTimeout(r, DELAY_MS));
    }

    // Group by metro for the app's lookup-by-city flow.
    const byMetro = {};
    for (const p of extracted) {
        if (!byMetro[p.metro]) byMetro[p.metro] = { metro: p.metro, state: p.state, places: [] };
        byMetro[p.metro].places.push(p);
    }

    const payload = {
        source: 'Reddit posts in 50 US city subreddits, queried for "stargazing", extracted via Claude.',
        attribution: 'Posts: reddit.com authors. Extraction: anthropic.com. Geocoding: nominatim.openstreetmap.org (ODbL).',
        generatedAt: new Date().toISOString(),
        totalPlaces: extracted.length,
        geocodedPlaces: withCoords,
        metros: Object.values(byMetro),
    };
    await writeFile(OUT, JSON.stringify(payload, null, 2));
    console.log(`Wrote ${OUT}: ${extracted.length} places, ${withCoords} with coords.`);
}

main().catch(e => { console.error(e); process.exit(1); });
