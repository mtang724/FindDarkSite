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
import { seeingScore01, transparencyScore01 } from './astroWeather.js';

const WEIGHTS = {
    cloud: 24,     // generic cloud cover
    sky: 18,       // Bortle quality
    seeing: 10,    // 7Timer seeing (atmospheric stability)
    transp: 8,     // 7Timer transparency
    moon: 14,      // dark hours / moon illumination
    drive: 8,      // closer wins
    remote: 8,     // distance to towns + residential — fights what VIIRS doesn't see
    dew: 5,        // dew margin — gear staying dry
    wind: 3,       // tracking shake guard
    precip: 2,     // wet-out guard
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

    // Remoteness — 25 km from any town = 1.0, 0 km = 0.0. Residential landuse
    // counted at 1/2 weight (cul-de-sacs aren't as bright as town centres).
    const settK = site.nearestSettlementKm;
    const resK  = site.nearestResidentialKm;
    let remoteN = 0.7; // unknown context: neutral-ish
    if (settK != null || resK != null) {
        const settScore = settK != null ? Math.max(0, Math.min(1, settK / 25)) : 1;
        const resScore  = resK  != null ? Math.max(0, Math.min(1, resK  / 15)) : 1;
        remoteN = settScore * 0.7 + resScore * 0.3;
    }
    // Unreachable sites are a hard cap — even a perfect sky doesn't help if
    // you can't drive there. Floor remoteness contribution at 0 in that case.
    if (site.reachable === false) remoteN = 0;
    // Land-status nudges: public land = small bump, military = treat as 0.
    if (site.inMilitary) remoteN = 0;
    else if (site.protectedArea) remoteN = Math.min(1, remoteN + 0.1);
    // IDA-certified Dark Sky Place nearby: bigger nudge — these are vetted
    // for sky quality + light-management commitments, much stronger signal
    // than "happens to fall in a park polygon".
    if (site.darkSkyPlace) {
        const d = site.darkSkyPlace.distanceKm ?? 25;
        // Inside (≤2km) → +0.2, fades to 0 at 25km
        const bump = Math.max(0, 0.2 * (1 - d / 25));
        remoteN = Math.min(1, remoteN + bump);
    }

    // Astro-specific signals — present only when 7Timer data merged into night.
    const seeingN = seeingScore01(night?.seeing);
    const transpN = transparencyScore01(night?.transparency);

    // Dew margin — < 2°C = lots of condensation likely; ≥ 5°C dry-ish.
    const dewM = night?.dewMarginC;
    const dewN = dewM == null ? 0.6 : Math.max(0, Math.min(1, (dewM - 0) / 8));
    // Wind — gusts < 8 kph perfect, > 30 kph forget it (tracking shake).
    const wind = night?.windKph;
    const windN = wind == null ? 0.6 : Math.max(0, Math.min(1, 1 - (wind - 8) / (30 - 8)));

    const parts = {
        cloud:  cloudN  * WEIGHTS.cloud,
        sky:    skyN    * WEIGHTS.sky,
        seeing: (seeingN ?? 0.6) * WEIGHTS.seeing,
        transp: (transpN ?? 0.6) * WEIGHTS.transp,
        moon:   moonN   * WEIGHTS.moon,
        drive:  driveN  * WEIGHTS.drive,
        remote: remoteN * WEIGHTS.remote,
        dew:    dewN    * WEIGHTS.dew,
        wind:   windN   * WEIGHTS.wind,
        precip: precipN * WEIGHTS.precip,
    };
    const score = Math.round(Object.values(parts).reduce((a, b) => a + b, 0));

    const reasons = [];
    if (cloudN >= 0.85) reasons.push(`☁️ ${cc}% cloud — clear`);
    else if (cloudN <= 0.4) reasons.push(`☁️ ${cc}% cloud — bad`);
    if (skyN >= 0.95) reasons.push(`🌌 SQM ${site.sqm.toFixed(1)} — pristine`);
    else if (skyN <= 0.5) reasons.push(`🌌 SQM ${site.sqm.toFixed(1)} — light-polluted`);
    if (moon && moon.illumination < 0.15) reasons.push(`${moon.icon} ${Math.round(moon.illumination*100)}% moon — dark`);
    else if (moon && moon.fractionInterference > 0.6) reasons.push(`${moon.icon} bright moon up most of the night`);
    if (driveSec != null && driveSec < 60*60) reasons.push(`🚗 ${Math.round(driveSec/60)} min drive`);
    else if (driveSec != null && driveSec > 3*3600) reasons.push(`🚗 ${(driveSec/3600).toFixed(1)} h drive — far`);
    if (site.reachable === false) reasons.push(`🚫 no drivable road within 800m`);
    else if (settK != null && settK < 6) reasons.push(`🏘️ ${site.nearestSettlementName || 'town'} only ${settK} km away`);
    else if (settK != null && settK >= 20) reasons.push(`🏞️ ${settK} km from nearest town — quiet`);
    if (site.darkSkyPlace) {
        const d = site.darkSkyPlace.distanceKm ?? 0;
        const verb = d < 2 ? 'inside' : `${d.toFixed(0)} km from`;
        reasons.push(`🌌 ${verb} IDA ${site.darkSkyPlace.name}`);
    }
    if (seeingN != null && seeingN >= 0.85) reasons.push(`👁️ seeing ${night.seeing.toFixed(1)}/8 — sharp`);
    else if (seeingN != null && seeingN <= 0.4) reasons.push(`👁️ seeing ${night.seeing.toFixed(1)}/8 — turbulent`);
    if (transpN != null && transpN >= 0.85) reasons.push(`🔭 transparency — pristine`);
    else if (transpN != null && transpN <= 0.4) reasons.push(`🔭 hazy transparency`);
    if (dewM != null && dewM < 2) reasons.push(`💧 dew margin ${dewM}°C — gear will wet`);
    if (wind != null && wind > 25) reasons.push(`💨 wind ${wind} kph — tracking shake`);
    if (pp >= 50) reasons.push(`💧 ${pp}% precip — likely wet`);

    // Find the lowest-scoring component, naming it so the UI can render
    // "Held back by: cloud" rather than mystery numbers. Skip axes that are
    // pure "unknown defaults" — they shouldn't be the dominant headline.
    const realParts = Object.entries(parts).filter(([k]) => {
        if (k === 'seeing' && seeingN == null) return false;
        if (k === 'transp' && transpN == null) return false;
        if (k === 'dew'    && dewM == null) return false;
        if (k === 'wind'   && wind == null) return false;
        return true;
    });
    const weakest = realParts
        .map(([k, v]) => [k, v / WEIGHTS[k]])
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
    const today = new Date().toISOString().slice(0, 10);
    const rows = [];
    for (const site of sites) {
        const nights = (site.forecast || []).filter(n => n.date >= today);
        for (const night of nights) {
            const s = nightScore(site, night);
            rows.push({ site, night, ...s });
        }
    }
    rows.sort((a, b) => b.score - a.score);
    return rows;
}
