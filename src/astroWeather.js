/**
 * Astronomy-grade forecast via 7Timer ASTRO endpoint.
 *   https://www.7timer.info/doc.php?lang=en
 *
 * Adds two signals on top of generic cloud cover that astrophotographers
 * actually care about:
 *   - seeing       (atmospheric turbulence; 1 = excellent, 8 = useless)
 *   - transparency (mag/airmass extinction; 1 = excellent, 8 = haze)
 *
 * Returns one summary per local-night, aligned with src/weather.js.
 */

import { get, set } from 'idb-keyval';

// 7Timer doesn't send CORS headers — go through the Vite proxy in dev and
// the upstream URL directly in production (callers need their own proxy or a
// CORS-friendly mirror in prod).
const ENDPOINT = (typeof import.meta !== 'undefined' && import.meta.env?.DEV)
    ? '/api/7timer'
    : 'https://www.7timer.info/bin/astro.php';
const TTL_MS = 2 * 60 * 60 * 1000; // 2 h

// v2 cache prefix — invalidates pre-fix entries that bucketed nights with the
// narrow 21:00–05:00 window (which dropped most 3-hourly samples).
function cacheKey(lat, lng) { return `astro_v2_${lat.toFixed(3)}_${lng.toFixed(3)}`; }

/**
 * Parse the init field "YYYYMMDDHH" (UTC) into a Date.
 */
function parseInit(initStr) {
    const y = parseInt(initStr.slice(0, 4), 10);
    const m = parseInt(initStr.slice(4, 6), 10) - 1;
    const d = parseInt(initStr.slice(6, 8), 10);
    const h = parseInt(initStr.slice(8, 10), 10);
    return new Date(Date.UTC(y, m, d, h));
}

async function fetchOne(lat, lng, signal) {
    const cached = await get(cacheKey(lat, lng));
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

    const url = `${ENDPOINT}?lon=${lng.toFixed(3)}&lat=${lat.toFixed(3)}&ac=0&unit=metric&output=json&tzshift=0`;
    const resp = await fetch(url, { signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const data = summarizeNights(json, lng);
    await set(cacheKey(lat, lng), { ts: Date.now(), data });
    return data;
}

/**
 * Bucket 7Timer 3-hourly samples by local-night (21:00 → 05:00 local).
 * Returns an array of { date, seeingMean, transparencyMean, cloudCode, sampleCount }.
 *
 * "Local" is approximated as UTC + (lng/15) hours — cheap and accurate enough
 * to bucket samples on the right night.
 */
function summarizeNights(json, lng) {
    if (!json?.dataseries || !json?.init) return [];
    const init = parseInit(json.init);
    // Round to nearest hour so dusk/dawn samples land on the right side of midnight.
    const tzOffsetH = Math.round(lng / 15);

    // Per-bucket weighted accumulators: { sSum, sW, tSum, tW, cSum, cW, n }
    const buckets = new Map();
    for (const row of json.dataseries) {
        const utc = new Date(init.getTime() + row.timepoint * 3600 * 1000);
        const local = new Date(utc.getTime() + tzOffsetH * 3600 * 1000);
        const hour = local.getUTCHours();
        // "Today's night" anchor: every sample after local noon belongs to
        // tonight; everything before noon belongs to the previous night.
        // Avoids dropping dusk/dawn samples to a rounding edge.
        const dateStr = hour >= 12
            ? local.toISOString().slice(0, 10)
            : new Date(local.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);

        if (!buckets.has(dateStr)) {
            buckets.set(dateStr, { sSum: 0, sW: 0, tSum: 0, tW: 0, cSum: 0, cW: 0, n: 0 });
        }
        const b = buckets.get(dateStr);
        // Weight observing-window samples 4× the afternoon ones.
        const w = (hour >= 18 || hour < 6) ? 1 : 0.25;
        if (row.seeing       != null) { b.sSum += row.seeing       * w; b.sW += w; }
        if (row.transparency != null) { b.tSum += row.transparency * w; b.tW += w; }
        if (row.cloudcover   != null) { b.cSum += row.cloudcover   * w; b.cW += w; }
        b.n++;
    }
    const out = [];
    for (const [date, b] of buckets) {
        out.push({
            date,
            seeingMean:       b.sW > 0 ? b.sSum / b.sW : null,
            transparencyMean: b.tW > 0 ? b.tSum / b.tW : null,
            cloudCodeMean:    b.cW > 0 ? b.cSum / b.cW : null,
            sampleCount: b.n,
        });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out.slice(0, 7);
}

/**
 * Convert 7Timer's 1-8 seeing scale to a 0..1 score (1 = perfect).
 */
export function seeingScore01(v) {
    if (v == null) return null;
    return Math.max(0, Math.min(1, 1 - (v - 1) / 7));
}

/**
 * Convert 7Timer's 1-8 transparency scale to a 0..1 score (1 = perfect).
 */
export function transparencyScore01(v) {
    if (v == null) return null;
    return Math.max(0, Math.min(1, 1 - (v - 1) / 7));
}

/**
 * Short verbal label so the UI doesn't have to translate every cell.
 */
export function seeingLabel(v) {
    if (v == null) return '—';
    if (v <= 1.5) return 'excellent';
    if (v <= 2.5) return 'good';
    if (v <= 4)   return 'fair';
    if (v <= 6)   return 'poor';
    return 'awful';
}
export function transparencyLabel(v) {
    if (v == null) return '—';
    if (v <= 1.5) return 'pristine';
    if (v <= 2.5) return 'clear';
    if (v <= 4)   return 'hazy';
    if (v <= 6)   return 'milky';
    return 'opaque';
}

/**
 * Batch wrapper, mirrors weather.js style. Sequential with a small delay so
 * we don't hammer the public 7Timer endpoint.
 *
 * @param {Array<{lat,lng}>} points
 * @param {AbortSignal} [signal]
 * @param {(done,total)=>void} [onProgress]
 */
export async function fetchAstroBatch(points, signal, onProgress) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
            const nights = await fetchOne(points[i].lat, points[i].lng, signal);
            out.push({ nights });
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            out.push({ nights: [], error: err.message });
        }
        onProgress?.(i + 1, points.length);
        // Light pacing — 7Timer is a free public service.
        await new Promise(r => setTimeout(r, 250));
    }
    return out;
}

/**
 * Look up the astro summary for a specific date inside a site's nights array.
 * Returns null when the site has no forecast or the date isn't covered.
 */
export function astroForDate(astroNights, date) {
    if (!astroNights || !date) return null;
    return astroNights.find(n => n.date === date) || null;
}
