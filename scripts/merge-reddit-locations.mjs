/**
 * Merge a new round of LLM-extracted Reddit locations with the already-shipped
 * public/data/reddit-locations.json. Re-geocodes only NEW unique entries via
 * Nominatim so we don't burn a full N×1.1s pass every time we refresh.
 *
 * Run AFTER `scripts/.cache/reddit-extracted.json` exists.
 *   node scripts/merge-reddit-locations.mjs
 *
 * Output: public/data/reddit-locations.json (refreshed)
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEW_EXT  = path.join(__dirname, '.cache', 'reddit-extracted.json');
const SHIPPED  = path.join(__dirname, '..', 'public', 'data', 'reddit-locations.json');

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'FindDarkSite/0.1 (https://github.com/mtang724/FindDarkSite)';
const DELAY_MS = 1100;

function placeKey(p) {
    return `${(p.metro || '').toLowerCase()}::${(p.name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()}`;
}

async function geocode(name, state) {
    const q = `${name}, ${state}, USA`;
    const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=us&email=finddarksite@users.github.io`;
    try {
        const resp = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
        if (!resp.ok) return null;
        const json = await resp.json();
        if (!json.length) return null;
        const h = json[0];
        return {
            lat: +parseFloat(h.lat).toFixed(5),
            lng: +parseFloat(h.lon).toFixed(5),
            displayName: h.display_name,
        };
    } catch {
        return null;
    }
}

async function main() {
    const shipped = JSON.parse(await readFile(SHIPPED, 'utf8'));
    const newExt  = JSON.parse(await readFile(NEW_EXT, 'utf8'));

    // Flatten the shipped tree into a flat list of records (the file groups
    // by metro under .metros[].places[]).
    const shippedFlat = [];
    for (const m of shipped.metros) {
        for (const p of (m.places || [])) {
            shippedFlat.push({ ...p, metro: m.metro, state: m.state });
        }
    }

    // Merge by (metro, name). Prefer the version with coords; among coord-bearers,
    // prefer the one with a longer `why`.
    const byKey = new Map();
    for (const list of [shippedFlat, newExt]) {
        for (const p of list) {
            const k = placeKey(p);
            const prior = byKey.get(k);
            if (!prior) { byKey.set(k, p); continue; }
            // Decide which to keep
            const priorHasCoord = prior.lat != null;
            const newHasCoord = p.lat != null;
            if (newHasCoord && !priorHasCoord) byKey.set(k, p);
            else if (newHasCoord && priorHasCoord) {
                if ((p.why || '').length > (prior.why || '').length) byKey.set(k, p);
            }
        }
    }
    const merged = [...byKey.values()];
    console.log(`Merged ${shippedFlat.length} + ${newExt.length} → ${merged.length} unique places.`);

    // Geocode any without coords (the brand-new entries).
    const needGeocode = merged.filter(p => p.lat == null);
    console.log(`Geocoding ${needGeocode.length} new places…`);
    const cache = new Map();
    for (let i = 0; i < needGeocode.length; i++) {
        const p = needGeocode[i];
        const key = `${(p.name || '').toLowerCase()}|${p.state || ''}`;
        let c = cache.get(key);
        if (c === undefined) {
            c = await geocode(p.name, p.state || '');
            cache.set(key, c);
            await new Promise(r => setTimeout(r, DELAY_MS));
        }
        if (c) {
            p.lat = c.lat;
            p.lng = c.lng;
            p.displayName = c.displayName;
        }
        if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${needGeocode.length}`);
    }
    const withCoords = merged.filter(p => p.lat != null).length;
    console.log(`Coords now: ${withCoords}/${merged.length}`);

    // Re-group by metro for the app's shape.
    const byMetro = {};
    for (const p of merged) {
        if (!byMetro[p.metro]) byMetro[p.metro] = { metro: p.metro, state: p.state, places: [] };
        byMetro[p.metro].places.push({
            name: p.name,
            why: p.why,
            sentiment: p.sentiment,
            subreddit: p.subreddit,
            sourceUrl: p.sourceUrl,
            lat: p.lat ?? null,
            lng: p.lng ?? null,
            displayName: p.displayName,
        });
    }
    // Sort metros + places (positive first inside a metro)
    const metros = Object.values(byMetro).sort((a, b) => a.metro.localeCompare(b.metro));
    for (const m of metros) {
        m.places.sort((a, b) =>
            (a.sentiment === 'positive' ? 0 : 1) - (b.sentiment === 'positive' ? 0 : 1));
    }

    const payload = {
        source: shipped.source,
        attribution: shipped.attribution,
        generatedAt: new Date().toISOString(),
        totalPlaces: merged.length,
        geocodedPlaces: withCoords,
        metros,
    };
    await writeFile(SHIPPED, JSON.stringify(payload, null, 2));
    console.log(`Wrote ${SHIPPED}: ${merged.length} places across ${metros.length} metros (${withCoords} with coords).`);
}

main().catch(e => { console.error(e); process.exit(1); });
