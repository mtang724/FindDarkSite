/**
 * Per-(site, night) viewing score.
 *
 * Combines the things astrophotographers actually decide on:
 *   - sky darkness (SQM/Bortle)        — already in site
 *   - cloud cover that night           — from open-meteo
 *   - moon interference                — from suncalc (illumination + whether it's up)
 *   - drive time penalty               — too far on a Tuesday isn't realistic
 *   - precipitation guard              — wet nights are non-starters
 *
 * Score is 0..100; the breakdown explains why. Returned as plain data so the
 * UI can sort, filter and render reasons without re-deriving anything.
 */

import { moonSummary } from './astronomy.js';

const WEIGHTS = {
    cloud: 35,     // single biggest factor
    sky: 25,       // Bortle quality
    moon: 20,      // dark hours / moon illumination
    drive: 12,     // closer wins
    precip: 8,     // wet-out guard
};

/**
 * @param {Object} site    - finder result (lat, lng, sqm, bortle, driving?)
 * @param {Object} night   - { date, cloudCover, precipProb, visibilityM }
 * @returns {{ score:number, reasons:string[], weakest:string }}
 */
export function nightScore(site, night) {
    // SQM / Bortle subscore — 22 -> 1.0, 18 -> 0.0
    const skyN = Math.max(0, Math.min(1, (site.sqm - 18) / 4));

    // Cloud subscore — 0% cover -> 1.0, 100% -> 0.0 (linear)
    const cc = night?.cloudCover ?? 100;
    const cloudN = Math.max(0, Math.min(1, (100 - cc) / 100));

    // Precip — anything > 50% probability roughly zeroes the score
    const pp = night?.precipProb ?? 0;
    const precipN = Math.max(0, Math.min(1, (100 - pp) / 100));

    // Moon — given the date, compute illumination + how much of astronomical
    // night the moon is below the horizon. We approximate "the night" as a
    // 9-hour window starting at local 21:00 (matches summarizeNights).
    const moon = moonForNight(site.lat, site.lng, night?.date);
    const moonN = moon ? 1 - moon.fractionInterference : 0.5;

    // Drive time — 15 min = 1.0, 4h+ = 0.0
    const driveSec = site.driving?.durationSec;
    const driveN = driveSec == null
        ? 0.7  // unknown: don't reward, don't crush
        : Math.max(0, Math.min(1, 1 - (driveSec - 900) / (4 * 3600 - 900)));

    const parts = {
        cloud: cloudN * WEIGHTS.cloud,
        sky:   skyN   * WEIGHTS.sky,
        moon:  moonN  * WEIGHTS.moon,
        drive: driveN * WEIGHTS.drive,
        precip: precipN * WEIGHTS.precip,
    };
    const score = Math.round(parts.cloud + parts.sky + parts.moon + parts.drive + parts.precip);

    const reasons = [];
    if (cloudN >= 0.85) reasons.push(`☁️ ${cc}% cloud — clear`);
    else if (cloudN <= 0.4) reasons.push(`☁️ ${cc}% cloud — bad`);
    if (skyN >= 0.95) reasons.push(`🌌 SQM ${site.sqm.toFixed(1)} — pristine`);
    else if (skyN <= 0.5) reasons.push(`🌌 SQM ${site.sqm.toFixed(1)} — light-polluted`);
    if (moon && moon.illumination < 0.15) reasons.push(`${moon.icon} ${Math.round(moon.illumination*100)}% moon — dark`);
    else if (moon && moon.fractionInterference > 0.6) reasons.push(`${moon.icon} bright moon up most of the night`);
    if (driveSec != null && driveSec < 60*60) reasons.push(`🚗 ${Math.round(driveSec/60)} min drive`);
    else if (driveSec != null && driveSec > 3*3600) reasons.push(`🚗 ${(driveSec/3600).toFixed(1)} h drive — far`);
    if (pp >= 50) reasons.push(`💧 ${pp}% precip — likely wet`);

    // Find the lowest-scoring component, naming it so the UI can render
    // "Held back by: cloud" rather than mystery numbers.
    const weakest = Object.entries(parts)
        .map(([k, v]) => [k, v / WEIGHTS[k]])           // normalize to 0..1 per axis
        .sort((a, b) => a[1] - b[1])[0][0];

    return { score, reasons, weakest, components: parts };
}

/**
 * Compute moon interference for a given calendar night, expressed as the
 * fraction of the 21:00→05:00 window during which the (illuminated) moon
 * is up. illumination 0..1 weights the interference linearly.
 */
function moonForNight(lat, lng, dateStr) {
    if (!dateStr) return null;
    const start = new Date(dateStr + 'T21:00:00');
    const end = new Date(start.getTime() + 8 * 3600 * 1000);
    const m = moonSummary(lat, lng, start);
    let upMinutes = 0;
    const total = 8 * 60;
    // Walk 30-min steps; suncalc-derived rise/set is good enough at this granularity.
    // We treat the moon as up if (rise<=t<set) or (alwaysUp).
    if (m.alwaysUp) {
        upMinutes = total;
    } else if (m.moonrise && m.moonset) {
        const rise = m.moonrise.getTime();
        const set = m.moonset.getTime();
        for (let t = start.getTime(); t < end.getTime(); t += 30 * 60 * 1000) {
            const inWindow = set > rise
                ? (t >= rise && t < set)
                : (t >= rise || t < set);
            if (inWindow) upMinutes += 30;
        }
    }
    const fractionInterference = (upMinutes / total) * m.illumination;
    return {
        illumination: m.illumination,
        icon: m.phaseIcon,
        fractionInterference,
    };
}

/**
 * Generate (site, night) combos for every site that has a forecast, ranked by
 * score descending. Caller decides how many to display.
 */
export function rankSiteNights(sites) {
    const rows = [];
    for (const site of sites) {
        const nights = site.forecast || [];
        for (const night of nights) {
            const s = nightScore(site, night);
            rows.push({ site, night, ...s });
        }
    }
    rows.sort((a, b) => b.score - a.score);
    return rows;
}
