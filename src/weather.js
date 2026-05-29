/**
 * Cloud-cover forecast via Open-Meteo (free, no key).
 *
 * For each point, fetches a 7-day forecast and computes a per-night summary:
 * cloud cover %, precipitation probability %, visibility — averaged over the
 * astronomical night window (21:00–05:00 local, an OK proxy without per-site
 * astronomy lookups).
 */

import { get, set } from 'idb-keyval';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheKey(lat, lng) {
    return `wx_${lat.toFixed(3)}_${lng.toFixed(3)}`;
}

async function fetchOne(lat, lng, signal) {
    const cached = await get(cacheKey(lat, lng));
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

    const url = `${ENDPOINT}?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}`
        + `&hourly=cloudcover,precipitation_probability,visibility,temperature_2m,dewpoint_2m,windspeed_10m,relativehumidity_2m`
        + `&timezone=auto&forecast_days=7`;
    const resp = await fetch(url, { signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const data = summarizeNights(json);
    await set(cacheKey(lat, lng), { ts: Date.now(), data });
    return data;
}

/**
 * Reduce an Open-Meteo response to a per-night array.
 * "Night" = the 21:00 of day D through 05:00 of day D+1, in the response's local TZ.
 */
function summarizeNights(json) {
    const hourly = json.hourly || {};
    const times = hourly.time || [];
    const cc    = hourly.cloudcover || [];
    const pp    = hourly.precipitation_probability || [];
    const vis   = hourly.visibility || [];
    const temp  = hourly.temperature_2m || [];
    const dew   = hourly.dewpoint_2m || [];
    const wind  = hourly.windspeed_10m || [];
    const rh    = hourly.relativehumidity_2m || [];

    // Group hour indices by night-of (the date the night starts on, local TZ).
    // Open-Meteo `time` strings are ISO-like in the requested timezone, with no offset.
    const nightBuckets = new Map();
    for (let i = 0; i < times.length; i++) {
        const t = times[i];                       // "2026-05-28T21:00"
        const hour = parseInt(t.slice(11, 13), 10);
        if (hour < 5 || hour >= 21) {
            // belongs to a "night-of" — for hours 0..4 that's the previous date
            const dateStr = hour < 5
                ? shiftDate(t.slice(0, 10), -1)
                : t.slice(0, 10);
            if (!nightBuckets.has(dateStr)) nightBuckets.set(dateStr, []);
            nightBuckets.get(dateStr).push(i);
        }
    }

    const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const max  = (arr) => arr.length ? Math.max(...arr) : null;

    const nights = [];
    for (const [date, idxs] of nightBuckets) {
        if (idxs.length === 0) continue;
        const sample = (arr) => idxs.map(i => arr[i]).filter(v => v != null);
        const ccVals  = sample(cc);
        const ppVals  = sample(pp);
        const visVals = sample(vis);
        const tempVals = sample(temp);
        const dewVals  = sample(dew);
        const windVals = sample(wind);
        const rhVals   = sample(rh);

        const tMean  = mean(tempVals);
        const dewMean = mean(dewVals);

        nights.push({
            date,
            cloudCover: ccVals.length  ? Math.round(mean(ccVals))  : null,
            precipProb: ppVals.length  ? Math.round(mean(ppVals))  : null,
            visibilityM: visVals.length ? Math.round(mean(visVals)) : null,
            tempC:       tMean  != null ? +tMean.toFixed(1)  : null,
            dewpointC:   dewMean != null ? +dewMean.toFixed(1) : null,
            // Margin matters more than absolute dewpoint — < 2°C ≈ dew risk all night.
            dewMarginC:  (tMean != null && dewMean != null) ? +(tMean - dewMean).toFixed(1) : null,
            windKph:     windVals.length ? Math.round(max(windVals)) : null,
            humidityPct: rhVals.length   ? Math.round(mean(rhVals))  : null,
        });
    }
    // Sort by date and only keep first 7
    nights.sort((a, b) => a.date.localeCompare(b.date));
    return nights.slice(0, 7);
}

function shiftDate(yyyymmdd, days) {
    const d = new Date(yyyymmdd + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
}

/**
 * Fetch nightly cloud/precip forecasts for a batch of sites.
 * Sequential with a small delay to keep Open-Meteo happy.
 *
 * @returns {Array<{ nights: Array, error?: string }>} aligned to input
 */
export async function fetchForecastsBatch(points, signal, onProgress) {
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
    }
    return out;
}

/** Pick the best (lowest cloud) night from a forecast array. */
export function bestNight(nights) {
    if (!nights || nights.length === 0) return null;
    return [...nights].sort((a, b) => (a.cloudCover ?? 100) - (b.cloudCover ?? 100))[0];
}
