/**
 * Pull the IDA-certified Dark Sky Places list from Wikidata (CC0 licence)
 * and bake it into public/data/dark-sky-places.json so the app can ship it
 * with the bundle and use it offline.
 *
 * Run with:  node scripts/fetch-dark-sky-places.mjs
 *
 * Five designations are covered (Park / Reserve / Sanctuary / Community /
 * Urban Night Sky Place — see darksky.org/places). Wikidata's `wdt:P1435`
 * (heritage designation) is the link; the Q-IDs below are pinned because
 * the labels are stable but the SPARQL full-text path is slow.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public', 'data', 'dark-sky-places.json');

const ENDPOINT = 'https://query.wikidata.org/sparql';
const DESIGNATIONS = {
    Q52216504: 'park',
    Q72114283: 'reserve',
    Q72114299: 'sanctuary',
    Q72114249: 'community',
    Q72114320: 'urban',
};

const QUERY = `
SELECT ?place ?placeLabel ?coord ?designation ?countryLabel WHERE {
  VALUES ?designation { ${Object.keys(DESIGNATIONS).map(id => 'wd:' + id).join(' ')} }
  ?place wdt:P1435 ?designation .
  OPTIONAL { ?place wdt:P625 ?coord }
  OPTIONAL { ?place wdt:P17 ?country }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
`;

async function main() {
    console.log('Querying Wikidata SPARQL…');
    const url = `${ENDPOINT}?query=${encodeURIComponent(QUERY)}`;
    const resp = await fetch(url, {
        headers: {
            'Accept': 'application/sparql-results+json',
            'User-Agent': 'FindDarkSite/0.1 (https://github.com/mtang724/FindDarkSite)',
        },
    });
    if (!resp.ok) throw new Error(`Wikidata HTTP ${resp.status}`);
    const json = await resp.json();

    const places = [];
    const seenIds = new Set();
    for (const b of json.results.bindings) {
        const id = b.place.value.split('/').pop();
        const desigQ = b.designation.value.split('/').pop();
        const designation = DESIGNATIONS[desigQ];
        if (!designation) continue;
        const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord?.value || '');
        if (!m) continue;                // skip rows with no coordinates
        const lng = parseFloat(m[1]);
        const lat = parseFloat(m[2]);
        if (!isFinite(lat) || !isFinite(lng)) continue;
        // Some places get split into multiple Wikidata items; key by id+coord
        // so a re-listing under another Q-ID isn't collapsed.
        const key = `${id}@${lat.toFixed(4)},${lng.toFixed(4)}`;
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        places.push({
            id,
            name: b.placeLabel.value,
            lat: +lat.toFixed(5),
            lng: +lng.toFixed(5),
            designation,
            country: b.countryLabel?.value || null,
        });
    }
    places.sort((a, b) => a.name.localeCompare(b.name));

    const payload = {
        source: 'Wikidata (CC0). Queried IDA-certified Dark Sky Places via wdt:P1435.',
        license: 'CC0',
        attribution: 'https://www.wikidata.org',
        generatedAt: new Date().toISOString(),
        count: places.length,
        places,
    };

    await writeFile(OUT, JSON.stringify(payload, null, 2));
    console.log(`Wrote ${OUT} (${places.length} places).`);

    // Tiny per-type breakdown
    const by = {};
    for (const p of places) by[p.designation] = (by[p.designation] || 0) + 1;
    for (const [k, v] of Object.entries(by)) console.log(`  ${k}: ${v}`);
}

main().catch(e => { console.error(e); process.exit(1); });
