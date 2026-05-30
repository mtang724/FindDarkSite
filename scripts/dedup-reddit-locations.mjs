/**
 * Dedup + cross-validate public/data/reddit-locations.json in place.
 *
 * Two problems, two fixes (both non-destructive to the by-metro structure the
 * app relies on):
 *
 *   1. Intra-metro duplicates — the same spot mentioned in several threads of
 *      one metro ("Mt. Wilson Observatory" + "Mount Wilson") geocodes to the
 *      same point and draws a double pin. We merge clusters within MERGE_KM
 *      into one canonical place, keeping the most specific name, unioning the
 *      source threads, and reconciling sentiment.
 *
 *   2. Cross-metro recurrence — a spot recommended from several different
 *      metros ("Enchanted Rock" in both r/Austin and r/sanantonio) is actually
 *      a *stronger* endorsement, not noise. We DON'T delete those (each metro's
 *      by-city lookup still needs its copy); instead we annotate every copy
 *      with `mentions` (total endorsing threads across metros) and
 *      `alsoRecommendedIn` (the other metros), so the UI can show confidence.
 *
 * New optional fields added: `sources` (array of {subreddit, sourceUrl}),
 * `mentions` (int), `alsoRecommendedIn` (array of metro names). Existing scalar
 * fields (sourceUrl, subreddit, why, sentiment) are preserved so current
 * renderers keep working.
 *
 * Run: node scripts/dedup-reddit-locations.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'public', 'data', 'reddit-locations.json');

const MERGE_KM = 1.5; // within this, treat as the same physical spot

function hav(aLat, aLng, bLat, bLng) {
    const R = 6371, t = x => x * Math.PI / 180;
    const dLa = t(bLat - aLat), dLo = t(bLng - aLng);
    const s = Math.sin(dLa / 2) ** 2 + Math.cos(t(aLat)) * Math.cos(t(bLat)) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

function reconcileSentiment(places) {
    const set = new Set(places.map(p => p.sentiment).filter(Boolean));
    if (set.has('positive') && set.has('negative')) return 'mixed';
    if (set.has('positive')) return 'positive';
    if (set.has('negative')) return 'negative';
    return [...set][0] || 'mixed';
}

function sourcesOf(places) {
    const seen = new Set(), out = [];
    for (const p of places) {
        for (const s of (p.sources?.length ? p.sources : [{ subreddit: p.subreddit, sourceUrl: p.sourceUrl }])) {
            const key = s.sourceUrl || `${s.subreddit}`;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(s);
        }
    }
    return out;
}

// Merge a cluster of same-spot places into one canonical entry.
function mergeCluster(places) {
    const geo = places.filter(p => p.lat != null && p.lng != null);
    const anchor = geo[0] || places[0];
    // Prefer a positive entry's `why`, else the longest one (most descriptive).
    const pos = places.find(p => p.sentiment === 'positive');
    const why = (pos || [...places].sort((a, b) => (b.why || '').length - (a.why || '').length)[0]).why;
    // Most specific name = longest.
    const name = [...places].sort((a, b) => (b.name || '').length - (a.name || '').length)[0].name;
    const sources = sourcesOf(places);
    return {
        ...anchor,
        name,
        why,
        sentiment: reconcileSentiment(places),
        subreddit: anchor.subreddit,
        sourceUrl: anchor.sourceUrl,
        sources,
        mentions: sources.length,
    };
}

// Greedy single-link clustering of geocoded places by proximity.
function clusterByProximity(places, km) {
    const geo = places.map((p, i) => ({ p, i })).filter(x => x.p.lat != null && x.p.lng != null);
    const used = new Array(places.length).fill(false);
    const clusters = [];
    for (const { p, i } of geo) {
        if (used[i]) continue;
        const group = [i];
        used[i] = true;
        for (const { p: q, i: j } of geo) {
            if (used[j]) continue;
            if (hav(p.lat, p.lng, q.lat, q.lng) <= km) { used[j] = true; group.push(j); }
        }
        clusters.push(group);
    }
    return clusters;
}

async function main() {
    const data = JSON.parse(await readFile(FILE, 'utf8'));

    // ── 1. Intra-metro merge ─────────────────────────────────────────────────
    let mergedAway = 0;
    for (const m of data.metros) {
        const ungeo = m.places.filter(p => p.lat == null || p.lng == null);
        const clusters = clusterByProximity(m.places, MERGE_KM);
        const merged = clusters.map(group => {
            if (group.length === 1) return m.places[group[0]];
            mergedAway += group.length - 1;
            return mergeCluster(group.map(idx => m.places[idx]));
        });
        m.places = [...merged, ...ungeo];
    }

    // ── 2. Cross-metro recurrence annotation ────────────────────────────────
    // Flatten geocoded places with a back-pointer, cluster globally, annotate.
    const flat = [];
    for (const m of data.metros) {
        for (const p of m.places) {
            if (p.lat != null && p.lng != null) flat.push({ p, metro: m.metro });
        }
    }
    const used = new Array(flat.length).fill(false);
    let crossSpots = 0;
    for (let i = 0; i < flat.length; i++) {
        if (used[i]) continue;
        const group = [i];
        used[i] = true;
        for (let j = i + 1; j < flat.length; j++) {
            if (used[j]) continue;
            if (hav(flat[i].p.lat, flat[i].p.lng, flat[j].p.lat, flat[j].p.lng) <= MERGE_KM) {
                used[j] = true;
                group.push(j);
            }
        }
        const metros = [...new Set(group.map(k => flat[k].metro))];
        const totalMentions = group.reduce((s, k) => s + (flat[k].p.mentions || 1), 0);
        if (metros.length > 1) crossSpots++;
        for (const k of group) {
            const others = metros.filter(mm => mm !== flat[k].metro);
            if (others.length) flat[k].p.alsoRecommendedIn = others;
            flat[k].p.mentions = totalMentions; // endorsing threads across all metros
        }
    }

    // ── Recompute counts ────────────────────────────────────────────────────
    let total = 0, geocoded = 0;
    for (const m of data.metros) for (const p of m.places) {
        total++;
        if (p.lat != null && p.lng != null) geocoded++;
    }
    data.totalPlaces = total;
    data.geocodedPlaces = geocoded;

    await writeFile(FILE, JSON.stringify(data, null, 2));
    console.log(`Merged ${mergedAway} intra-metro duplicate(s).`);
    console.log(`Annotated ${crossSpots} spot(s) recommended across multiple metros.`);
    console.log(`Now ${geocoded}/${total} geocoded across ${data.metros.length} metros. Wrote ${FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
