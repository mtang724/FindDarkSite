/**
 * Per-(site, night) viewing score, split into three groups so the headline
 * weight on "tonight" doesn't drown out site quality and vice-versa.
 *
 *   Tonight   (50 pts) — cloud, moon, seeing, transparency, dew, wind, precip
 *   Site      (35 pts) — SQM, horizon clearance, town distance, drive time
 *   Community (15 pts) — IDA, Reddit-vetted, GLOBE at Night agreement
 *
 * Hard gates (not scored — handled by finder filters):
 *   - `reachable === false`  →  filtered out by Hide unreachable
 *   - `inMilitary === true`  →  community + remote forced to 0 here too,
 *                                  so even if surfaced it sinks
 *
 * Score is 0..100; the breakdown explains why. Returned as plain data so the
 * UI can sort, filter, and render reasons without re-deriving anything.
 */

import { moonSummary } from './astronomy.js';
import { seeingScore01, transparencyScore01 } from './astroWeather.js';

const WEIGHTS = {
    // Tonight (50)
    cloud:    20,
    moon:     10,
    seeing:    8,
    transp:    6,
    dew:       3,
    wind:      2,
    precip:    1,
    // Site (35)
    sky:      15,    // SQM/Bortle
    horizon:   8,    // DEM-sampled apparent horizon
    remote:    7,    // settlement + residential distance
    drive:     5,    // OSRM driving time
    // Community (15)
    ida:       5,    // IDA-certified Dark Sky Place proximity
    reddit:    5,    // Reddit-vetted spot proximity
    sqmReport: 5,    // GLOBE at Night model-vs-observation agreement
};

const FLOOR_TO_ZERO = { reddit: true, ida: true, sqmReport: true };

/**
 * @param {Object} site   - finder result (lat, lng, sqm, bortle, optional horizon/driving/
 *                          darkSkyPlace/sqmReport/nearestRedditSpot/reachable/inMilitary)
 * @param {Object} night  - one forecast row, may include seeing/transparency from 7Timer
 */
export function nightScore(site, night) {
    // ─── Tonight subscores ──────────────────────────────────────────────────
    const cc = night?.cloudCover ?? 100;
    const cloudN = Math.max(0, Math.min(1, (100 - cc) / 100));

    const pp = night?.precipProb ?? 0;
    const precipN = Math.max(0, Math.min(1, (100 - pp) / 100));

    // Moon — illumination weighted by fraction-of-night above horizon.
    const moon = moonForNight(site.lat, site.lng, night?.date);
    const moonN = moon ? 1 - moon.fractionInterference : 0.5;

    // 7Timer (1-8 scales, 1 = best).
    const seeingN = seeingScore01(night?.seeing);
    const transpN = transparencyScore01(night?.transparency);

    // Dew margin (T − Tdew). 0°C → instant dew, ≥ 8°C → dry enough.
    const dewM = night?.dewMarginC;
    const dewN = dewM == null ? 0.6 : Math.max(0, Math.min(1, dewM / 8));

    // Wind. < 8 kph perfect, > 30 kph forget it.
    const wind = night?.windKph;
    const windN = wind == null ? 0.6 : Math.max(0, Math.min(1, 1 - (wind - 8) / 22));

    // ─── Site subscores ─────────────────────────────────────────────────────
    // SQM/Bortle: 22 → 1.0, 18 → 0.0
    const skyN = Math.max(0, Math.min(1, (site.sqm - 18) / 4));

    // Horizon clearance: 0° → 1.0, 25°+ → 0. Unknown → 0.6 (don't reward or punish).
    const horizonN = site.horizon
        ? Math.max(0, 1 - Math.min(site.horizon.maxAngle, 25) / 25)
        : 0.6;

    // Remoteness: weighted blend of settlement + residential distance.
    const settK = site.nearestSettlementKm;
    const resK  = site.nearestResidentialKm;
    let remoteN = 0.7;
    if (settK != null || resK != null) {
        const sN = settK != null ? Math.max(0, Math.min(1, settK / 25)) : 1;
        const rN = resK  != null ? Math.max(0, Math.min(1, resK  / 15)) : 1;
        remoteN = sN * 0.7 + rN * 0.3;
    }

    // Drive time. 15 min → 1.0, 4 h → 0.
    const driveSec = site.driving?.durationSec;
    const driveN = driveSec == null
        ? 0.7
        : Math.max(0, Math.min(1, 1 - (driveSec - 900) / (4 * 3600 - 900)));

    // ─── Community subscores ────────────────────────────────────────────────
    // IDA proximity: ≤2km = 1.0, fades to 0 at 25km. Sanctuaries/Reserves rank
    // slightly higher than Parks/Communities/Urban (the IDA designation
    // ladder).
    const ida = site.darkSkyPlace;
    let idaN = 0;
    if (ida) {
        const baseline = Math.max(0, 1 - (ida.distanceKm ?? 25) / 25);
        const tier = { sanctuary: 1.0, reserve: 0.95, park: 0.85, community: 0.7, urban: 0.55 }[ida.designation] ?? 0.75;
        idaN = Math.min(1, baseline * tier + (ida.distanceKm <= 2 ? 0.2 : 0));
    }

    // Reddit proximity. Positive sentiment counted full, mixed at half, negative
    // penalised slightly (the local consensus is "don't bother").
    const r = site.nearestRedditSpot;
    let redditN = 0;
    if (r && r.distanceKm != null) {
        const close = Math.max(0, 1 - r.distanceKm / 30);
        if      (r.sentiment === 'positive') redditN = close;
        else if (r.sentiment === 'mixed')    redditN = close * 0.5;
        else if (r.sentiment === 'negative') redditN = -close * 0.3;
    }
    redditN = Math.max(0, Math.min(1, redditN));

    // GLOBE at Night model-vs-observation agreement.
    // If a real meter reading nearby comes in higher than our model predicts,
    // that's a strong positive (the model under-counts the spot). If much
    // lower, the model is optimistic.
    let sqmReportN = 0.4; // unknown: lean neutral but not bonus
    if (site.sqmReport?.sqm != null) {
        const diff = site.sqmReport.sqm - site.sqm;
        // diff = 0 → 0.6, +1 → 1.0, -1 → 0.2, -2 → 0
        sqmReportN = Math.max(0, Math.min(1, 0.6 + diff * 0.4));
    }

    // ─── Hard penalty / gating ──────────────────────────────────────────────
    // Military overlap or unreachable: zero out remote + community signals so
    // these points can never beat a real candidate.
    if (site.inMilitary) {
        remoteN = idaN = redditN = sqmReportN = 0;
    }
    if (site.reachable === false) {
        remoteN = idaN = redditN = sqmReportN = 0;
    }

    // ─── Assemble ───────────────────────────────────────────────────────────
    const parts = {
        cloud:  cloudN  * WEIGHTS.cloud,
        moon:   moonN   * WEIGHTS.moon,
        seeing: (seeingN ?? 0.6) * WEIGHTS.seeing,
        transp: (transpN ?? 0.6) * WEIGHTS.transp,
        dew:    dewN    * WEIGHTS.dew,
        wind:   windN   * WEIGHTS.wind,
        precip: precipN * WEIGHTS.precip,
        sky:    skyN    * WEIGHTS.sky,
        horizon: horizonN * WEIGHTS.horizon,
        remote: remoteN * WEIGHTS.remote,
        drive:  driveN  * WEIGHTS.drive,
        ida:    idaN    * WEIGHTS.ida,
        reddit: redditN * WEIGHTS.reddit,
        sqmReport: sqmReportN * WEIGHTS.sqmReport,
    };
    const score = Math.round(Object.values(parts).reduce((a, b) => a + b, 0));

    // ─── Reasons (the "why" pills shown in the Best Nights view) ────────────
    const reasons = [];
    // tonight
    if (cloudN >= 0.85) reasons.push(`☁️ ${cc}% cloud — clear`);
    else if (cloudN <= 0.4) reasons.push(`☁️ ${cc}% cloud — bad`);
    if (moon && moon.illumination < 0.15) reasons.push(`${moon.icon} ${Math.round(moon.illumination * 100)}% moon — dark`);
    else if (moon && moon.fractionInterference > 0.6) reasons.push(`${moon.icon} bright moon up most of the night`);
    if (seeingN != null && seeingN >= 0.85) reasons.push(`👁️ seeing ${night.seeing.toFixed(1)}/8 — sharp`);
    else if (seeingN != null && seeingN <= 0.4) reasons.push(`👁️ seeing ${night.seeing.toFixed(1)}/8 — turbulent`);
    if (transpN != null && transpN >= 0.85) reasons.push(`🔭 transparency — pristine`);
    else if (transpN != null && transpN <= 0.4) reasons.push(`🔭 hazy transparency`);
    if (dewM != null && dewM < 2) reasons.push(`💧 dew margin ${dewM}°C — gear will wet`);
    if (wind != null && wind > 25) reasons.push(`💨 wind ${wind} kph — tracking shake`);
    if (pp >= 50) reasons.push(`💧 ${pp}% precip — likely wet`);
    // site
    if (skyN >= 0.95) reasons.push(`🌌 SQM ${site.sqm.toFixed(1)} — pristine`);
    else if (skyN <= 0.5) reasons.push(`🌌 SQM ${site.sqm.toFixed(1)} — light-polluted`);
    if (site.horizon && site.horizon.maxAngle < 5) reasons.push(`🏔️ horizon ${site.horizon.maxAngle.toFixed(1)}° — clear`);
    else if (site.horizon && site.horizon.maxAngle > 15) reasons.push(`🏔️ ${site.horizon.maxAngle.toFixed(0)}° obstruction ${site.horizon.worstAzimuth || ''}`);
    if (site.reachable === false) reasons.push(`🚫 no drivable road within 800m`);
    else if (settK != null && settK < 6) reasons.push(`🏘️ ${site.nearestSettlementName || 'town'} only ${settK} km away`);
    else if (settK != null && settK >= 20) reasons.push(`🏞️ ${settK} km from nearest town`);
    if (driveSec != null && driveSec < 60 * 60) reasons.push(`🚗 ${Math.round(driveSec / 60)} min drive`);
    else if (driveSec != null && driveSec > 3 * 3600) reasons.push(`🚗 ${(driveSec / 3600).toFixed(1)} h drive — far`);
    // community
    if (ida) {
        const d = ida.distanceKm ?? 0;
        const verb = d < 2 ? 'inside' : `${d.toFixed(0)} km from`;
        reasons.push(`🌌 ${verb} IDA ${ida.name}`);
    }
    if (r && r.distanceKm != null && r.distanceKm < 12) {
        const verb = r.distanceKm < 2 ? 'at' : `${r.distanceKm.toFixed(0)} km from`;
        if (r.sentiment === 'positive') reasons.push(`🗣️ ${verb} r/${r.subreddit}'s ${r.name}`);
        else if (r.sentiment === 'negative') reasons.push(`🗣️ locals: skip ${r.name}`);
    }
    if (site.sqmReport?.sqm != null) {
        const obs = site.sqmReport.sqm.toFixed(2);
        const diff = site.sqmReport.sqm - site.sqm;
        if (diff > 0.5) reasons.push(`📍 GLOBE measured ${obs} — darker than model`);
        else if (diff < -0.8) reasons.push(`📍 GLOBE measured ${obs} — model optimistic`);
    }

    // ─── Weakest-axis label for the "held back by" footer ───────────────────
    // Skip axes that are pure unknown defaults so the headline isn't
    // misleading ("seeing" can't be the weakness if we never knew it).
    const realParts = Object.entries(parts).filter(([k]) => {
        if (k === 'seeing' && seeingN == null) return false;
        if (k === 'transp' && transpN == null) return false;
        if (k === 'dew'    && dewM == null) return false;
        if (k === 'wind'   && wind == null) return false;
        if (FLOOR_TO_ZERO[k] && parts[k] === 0) return false;
        return true;
    });
    const weakest = realParts.length
        ? realParts.map(([k, v]) => [k, v / WEIGHTS[k]]).sort((a, b) => a[1] - b[1])[0][0]
        : 'unknown';

    return { score, reasons, weakest, components: parts };
}

/**
 * Compute moon interference for a given calendar night.
 */
function moonForNight(lat, lng, dateStr) {
    if (!dateStr) return null;
    const start = new Date(dateStr + 'T21:00:00');
    const end = new Date(start.getTime() + 8 * 3600 * 1000);
    const m = moonSummary(lat, lng, start);
    let upMinutes = 0;
    const total = 8 * 60;
    if (m.alwaysUp) {
        upMinutes = total;
    } else if (m.moonrise && m.moonset) {
        const rise = m.moonrise.getTime();
        const set = m.moonset.getTime();
        for (let t = start.getTime(); t < end.getTime(); t += 30 * 60 * 1000) {
            const inWindow = set > rise ? (t >= rise && t < set) : (t >= rise || t < set);
            if (inWindow) upMinutes += 30;
        }
    }
    const fractionInterference = (upMinutes / total) * m.illumination;
    return { illumination: m.illumination, icon: m.phaseIcon, fractionInterference };
}

/**
 * Generate (site, night) combos for every site that has a forecast, ranked
 * by score descending. Caller decides how many to display.
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
