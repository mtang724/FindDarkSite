/**
 * Apparent horizon estimation for a site, sampled from Open-Meteo's elevation
 * API (SRTM-derived, free, no key).
 *
 * For each of 8 compass azimuths we sample elevations along a ray (1, 2, 4, 8,
 * 16 km), apply Earth-curvature drop, and compute the maximum elevation angle
 * — that's the apparent horizon in that direction.
 *
 * Astronomy threshold of thumb: anything > 10° is meaningful obstruction;
 * < 3° is clear horizon ("ocean view"). Polar viz colours bands accordingly.
 */

import { get, set } from 'idb-keyval';

const ELEV_ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
const MAX_PER_REQUEST = 100;
const EARTH_RADIUS_M = 6_371_000;

const AZIMUTHS = [
    { name: 'N',  deg: 0   },
    { name: 'NE', deg: 45  },
    { name: 'E',  deg: 90  },
    { name: 'SE', deg: 135 },
    { name: 'S',  deg: 180 },
    { name: 'SW', deg: 225 },
    { name: 'W',  deg: 270 },
    { name: 'NW', deg: 315 },
];
const DISTANCES_M = [1000, 2000, 4000, 8000, 16000];

function cacheKey(lat, lng) {
    return `horizon_${lat.toFixed(3)}_${lng.toFixed(3)}`;
}

/**
 * Offset (lat, lng) by `distance_m` along bearing `azDeg`.
 * Spherical-earth approximation — fine for the 1–16 km we use here.
 */
function offsetCoord(lat, lng, azDeg, distM) {
    const δ = distM / EARTH_RADIUS_M;
    const θ = azDeg * Math.PI / 180;
    const φ1 = lat * Math.PI / 180;
    const λ1 = lng * Math.PI / 180;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(
        Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
        Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );
    return { lat: φ2 * 180 / Math.PI, lng: λ2 * 180 / Math.PI };
}

/**
 * Compute apparent horizon angle (deg above level) per azimuth for one site.
 * Returns { N, NE, E, SE, S, SW, W, NW: number, maxAngle, worstAzimuth, samples }.
 *
 * Eye height (siteElevM) is the site's own elevation; we treat the observer
 * as standing on the ground, so terrain bulges far away can obstruct.
 *
 * If we can't reach Open-Meteo, returns null — callers tolerate that.
 */
export async function computeHorizon(lat, lng, siteElevM, signal) {
    if (siteElevM == null) return null;
    const cached = await get(cacheKey(lat, lng));
    if (cached) return cached;

    // Build the full sample set, batch the elevation call.
    const samples = [];
    for (const az of AZIMUTHS) {
        for (const dist of DISTANCES_M) {
            const p = offsetCoord(lat, lng, az.deg, dist);
            samples.push({ az: az.name, dist, lat: p.lat, lng: p.lng });
        }
    }

    const elevs = await fetchElevationsBatched(samples, signal);
    if (!elevs) return null;

    // Per azimuth, take the max angle across distances.
    const result = { samples: [] };
    let maxAngle = -Infinity, worstAzimuth = null;
    for (const az of AZIMUTHS) {
        let angle = -90;
        for (let i = 0; i < DISTANCES_M.length; i++) {
            const dist = DISTANCES_M[i];
            const idx = samples.findIndex(s => s.az === az.name && s.dist === dist);
            const targetElev = elevs[idx];
            if (targetElev == null) continue;
            // Earth-curvature drop: at distance d, the horizon line drops by d²/(2R)
            const drop = (dist * dist) / (2 * EARTH_RADIUS_M);
            const apparent = targetElev - drop - siteElevM;
            const a = Math.atan2(apparent, dist) * 180 / Math.PI;
            if (a > angle) angle = a;
            result.samples.push({ az: az.name, dist, elev: targetElev, angle: a });
        }
        result[az.name] = Math.max(0, angle);
        if (result[az.name] > maxAngle) {
            maxAngle = result[az.name];
            worstAzimuth = az.name;
        }
    }
    result.maxAngle = maxAngle;
    result.worstAzimuth = worstAzimuth;
    await set(cacheKey(lat, lng), result);
    return result;
}

async function fetchElevationsBatched(samples, signal) {
    const out = new Array(samples.length).fill(null);
    for (let i = 0; i < samples.length; i += MAX_PER_REQUEST) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const batch = samples.slice(i, i + MAX_PER_REQUEST);
        const lats = batch.map(s => s.lat.toFixed(4)).join(',');
        const lngs = batch.map(s => s.lng.toFixed(4)).join(',');
        try {
            const resp = await fetch(`${ELEV_ENDPOINT}?latitude=${lats}&longitude=${lngs}`, { signal });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const json = await resp.json();
            const elevs = json.elevation || [];
            for (let j = 0; j < batch.length; j++) {
                const e = Number(elevs[j]);
                if (Number.isFinite(e)) out[i + j] = e;
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            console.warn('Horizon elevation batch failed:', err.message);
            return null;
        }
    }
    return out;
}

/**
 * Run computeHorizon for a list of sites, in parallel-ish (one request stream
 * per site so we don't blow up the Open-Meteo rate limit). Tolerates partial
 * failure.
 *
 * @param {Array<{lat,lng,elevationM}>} sites
 * @param {AbortSignal} [signal]
 * @param {(done,total)=>void} [onProgress]
 */
export async function computeHorizonsBatch(sites, signal, onProgress) {
    const out = [];
    for (let i = 0; i < sites.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
            out.push(await computeHorizon(sites[i].lat, sites[i].lng, sites[i].elevationM, signal));
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            out.push(null);
        }
        onProgress?.(i + 1, sites.length);
    }
    return out;
}

/**
 * Render an SVG polar plot of the horizon (north up, clockwise).
 * Returns a string of SVG ready for innerHTML.
 */
export function renderHorizonSvg(horizon, size = 110) {
    if (!horizon) return '';
    const cx = size / 2, cy = size / 2;
    const r = size / 2 - 6;
    // Convert horizon angles into a radial polygon: 0° (clear horizon) at full r,
    // 30° obstruction at center.
    const radial = (deg) => Math.max(0, r * (1 - Math.min(deg, 30) / 30));
    const points = AZIMUTHS.map(({ name, deg }) => {
        const θ = (deg - 90) * Math.PI / 180; // north up
        const rad = r - radial(horizon[name] ?? 0);
        const x = cx + rad * Math.cos(θ);
        const y = cy + rad * Math.sin(θ);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const tone = horizon.maxAngle < 5 ? '#34d399' : horizon.maxAngle < 15 ? '#fbbf24' : '#f87171';
    const labelPos = (deg, off) => {
        const θ = (deg - 90) * Math.PI / 180;
        return [cx + (r + off) * Math.cos(θ), cy + (r + off) * Math.sin(θ)];
    };
    const [nx, ny] = labelPos(0, 3);
    const [ex, ey] = labelPos(90, 3);
    const [sx, sy] = labelPos(180, 3);
    const [wx, wy] = labelPos(270, 3);

    return `
    <svg viewBox="0 0 ${size} ${size}" class="horizon-svg" aria-label="Horizon profile">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1e293b" stroke-width="1"/>
      <circle cx="${cx}" cy="${cy}" r="${r * 2 / 3}" fill="none" stroke="#1e293b" stroke-dasharray="2 2" stroke-width="0.5"/>
      <circle cx="${cx}" cy="${cy}" r="${r * 1 / 3}" fill="none" stroke="#1e293b" stroke-dasharray="2 2" stroke-width="0.5"/>
      <polygon points="${points}" fill="${tone}" fill-opacity="0.4" stroke="${tone}" stroke-width="1.4"/>
      <text x="${nx}" y="${ny}" class="horizon-label" text-anchor="middle" dominant-baseline="hanging">N</text>
      <text x="${ex}" y="${ey}" class="horizon-label" text-anchor="start"  dominant-baseline="middle">E</text>
      <text x="${sx}" y="${sy}" class="horizon-label" text-anchor="middle" dominant-baseline="ideographic">S</text>
      <text x="${wx}" y="${wy}" class="horizon-label" text-anchor="end"    dominant-baseline="middle">W</text>
    </svg>
    `;
}
