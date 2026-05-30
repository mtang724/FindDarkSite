/**
 * "What's worth looking at tonight" — ranked per site by the three things that
 * actually decide whether a target is observable from a *specific* dark spot:
 *
 *   1. Time window  — only the real astronomical-dark hours (and, if the moon
 *                      is up and bright, the darker stretch around it).
 *   2. Terrain      — the site's DEM horizon profile (site.horizon): a target
 *                      sitting behind a ridge in that azimuth is out.
 *   3. Light dome   — the surrounding city glow direction (site.lightDome): a
 *                      faint target low in the glow is washed out; high or
 *                      glow-opposite targets are fine.
 *
 * Targets are fixed deep-sky objects + the Milky Way core (the flagship
 * dark-sky sight) with J2000 equatorial coordinates, plus the Moon. Planets
 * are intentionally omitted — their positions need an ephemeris we don't ship,
 * and we'd rather show nothing than something wrong.
 */

import { bearingToDirection } from './utils.js';
import SunCalc from 'suncalc';

// name, ra/dec in degrees (J2000), type, an emoji, and a prominence weight
// (how much of a "don't miss it" this is, 0..1) used to break ties.
export const TARGETS = [
    { name: 'Milky Way core',     ra: 266.40, dec: -29.00, type: 'galaxy core',  icon: '🌌', prom: 1.00, blurb: 'the bright Sagittarius bulge — the signature naked-eye dark-sky sight' },
    { name: 'Andromeda (M31)',    ra: 10.68,  dec: 41.27,  type: 'galaxy',       icon: '🌀', prom: 0.85, blurb: 'nearest big galaxy, naked-eye from a dark site' },
    { name: 'Orion Nebula (M42)', ra: 83.82,  dec: -5.39,  type: 'nebula',       icon: '☁️', prom: 0.90, blurb: 'bright star-forming nebula in Orion’s sword' },
    { name: 'Pleiades (M45)',     ra: 56.75,  dec: 24.12,  type: 'open cluster', icon: '✨', prom: 0.75, blurb: 'the Seven Sisters — a naked-eye blue cluster' },
    { name: 'Lagoon Nebula (M8)', ra: 270.92, dec: -24.38, type: 'nebula',       icon: '☁️', prom: 0.70, blurb: 'big emission nebula near the galactic core' },
    { name: 'Hercules Cluster (M13)', ra: 250.42, dec: 36.46, type: 'globular',  icon: '🔵', prom: 0.70, blurb: 'the best northern globular cluster' },
    { name: 'Double Cluster',     ra: 34.75,  dec: 57.13,  type: 'open cluster', icon: '✨', prom: 0.65, blurb: 'twin open clusters in Perseus' },
    { name: 'Bode’s Galaxies (M81/82)', ra: 148.97, dec: 69.07, type: 'galaxy', icon: '🌀', prom: 0.60, blurb: 'a galaxy pair high in the north' },
    { name: 'Sagittarius Star Cloud (M24)', ra: 274.30, dec: -18.50, type: 'star cloud', icon: '🌌', prom: 0.65, blurb: 'dense Milky Way star field' },
    { name: 'Ring Nebula (M57)',  ra: 283.40, dec: 33.03,  type: 'nebula',       icon: '💍', prom: 0.55, blurb: 'compact planetary nebula in Lyra' },
    { name: 'Whirlpool (M51)',    ra: 202.47, dec: 47.20,  type: 'galaxy',       icon: '🌀', prom: 0.60, blurb: 'face-on spiral near the Big Dipper’s handle' },
    { name: 'Beehive (M44)',      ra: 130.10, dec: 19.67,  type: 'open cluster', icon: '🐝', prom: 0.55, blurb: 'large bright cluster in Cancer' },
];

const RAD = Math.PI / 180, DEG = 180 / Math.PI;

/** Julian Date from a JS Date. */
function julianDate(date) {
    return date.getTime() / 86400000 + 2440587.5;
}

/** Greenwich Mean Sidereal Time in degrees. */
function gmstDeg(date) {
    const d = julianDate(date) - 2451545.0;
    return ((280.46061837 + 360.98564736629 * d) % 360 + 360) % 360;
}

/**
 * Equatorial (RA/Dec, deg) → horizontal (alt/az, deg) for an observer.
 * Azimuth is measured from North, clockwise (N=0, E=90, S=180, W=270).
 */
export function equatorialToHorizontal(raDeg, decDeg, lat, lng, date) {
    const lst = (gmstDeg(date) + lng) % 360;
    let ha = (lst - raDeg) % 360;
    if (ha < -180) ha += 360; if (ha > 180) ha -= 360;
    const haR = ha * RAD, decR = decDeg * RAD, latR = lat * RAD;
    const sinAlt = Math.sin(decR) * Math.sin(latR) + Math.cos(decR) * Math.cos(latR) * Math.cos(haR);
    const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
    let cosAz = (Math.sin(decR) - Math.sin(latR) * sinAlt) / (Math.cos(latR) * Math.cos(alt));
    cosAz = Math.max(-1, Math.min(1, cosAz));
    let az = Math.acos(cosAz) * DEG;
    if (Math.sin(haR) > 0) az = 360 - az; // object west of meridian
    return { alt: alt * DEG, az };
}

/**
 * Terrain obstruction angle (deg) at an arbitrary azimuth, linearly
 * interpolated from the site's 8-point horizon profile. Unknown → 0 (flat).
 */
export function terrainAt(horizon, az) {
    if (!horizon) return 0;
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const a = ((az % 360) + 360) % 360;
    const i = Math.floor(a / 45);
    const frac = (a - i * 45) / 45;
    const lo = horizon[names[i]] ?? 0;
    const hi = horizon[names[(i + 1) % 8]] ?? 0;
    return lo + (hi - lo) * frac;
}

/** Angular separation between two azimuths, 0..180. */
function azDelta(a, b) {
    let d = Math.abs(((a - b) % 360 + 360) % 360);
    return d > 180 ? 360 - d : d;
}

/**
 * Light-dome washout factor 0..1 (1 = no impact, 0 = fully washed out) for a
 * target at (alt, az). The glow only bites near the horizon and only in its
 * own direction; high targets and glow-opposite targets are unaffected.
 */
function domeClarity(lightDome, alt, az) {
    if (!lightDome || lightDome.concentration <= 0.3) return 1;
    if (alt >= 35) return 1;                       // well clear of any dome
    const aligned = 1 - azDelta(az, lightDome.azimuth) / 90; // 1 at glow bearing, 0 at 90°+
    if (aligned <= 0) return 1;
    const lowness = 1 - alt / 35;                  // 1 at horizon, 0 at 35°
    const hit = aligned * lowness * lightDome.concentration;
    return Math.max(0, 1 - hit);
}

function fmtTime(d) {
    return d?.toLocaleTimeString?.([], { hour: '2-digit', minute: '2-digit' }) ?? '';
}

/**
 * Rank tonight's targets for one site.
 *
 * @param {Object} site   - needs lat, lng; optional horizon, lightDome.
 * @param {Object} window - { darkStart:Date, darkEnd:Date } (from
 *                          moonInterferenceForNight). If absent/zero-length,
 *                          returns { targets: [], note }.
 * @param {Object} [opts] - { limit=4, stepMin=20, minAlt=15 }
 * @returns {{ targets: Array, note?: string }}
 */
export function recommendTonight(site, window, opts = {}) {
    const { limit = 4, stepMin = 20, minAlt = 15 } = opts;
    if (!window?.darkStart || !window?.darkEnd || window.darkEnd <= window.darkStart) {
        return { targets: [], note: 'No real astronomical darkness tonight.' };
    }
    const { lat, lng } = site;
    const stepMs = stepMin * 60 * 1000;

    // Moon position over the window — used to penalise targets it sits near.
    const illum = SunCalc.getMoonIllumination(window.darkStart).fraction;

    const ranked = [];
    for (const t of TARGETS) {
        let best = null; // { alt, az, time, clarity }
        for (let ms = window.darkStart.getTime(); ms <= window.darkEnd.getTime(); ms += stepMs) {
            const when = new Date(ms);
            const { alt, az } = equatorialToHorizontal(t.ra, t.dec, lat, lng, when);
            if (alt < minAlt) continue;
            const terrain = terrainAt(site.horizon, az);
            if (alt <= terrain + 2) continue;            // hidden behind the ridge there
            const clarity = domeClarity(site.lightDome, alt, az);
            // Prefer the highest moment that also clears terrain & glow.
            const moment = alt * 0.7 + clarity * 30 + (alt - terrain) * 0.3;
            if (!best || moment > best.moment) best = { alt, az, time: when, terrain, clarity, moment };
        }
        if (!best) continue;

        // Moon proximity penalty (only when the moon is up & bright at that time).
        let moonPenalty = 0;
        if (illum > 0.3) {
            const mp = SunCalc.getMoonPosition(best.time, lat, lng);
            if (mp.altitude > 0) {
                const mAz = (mp.azimuth * DEG + 180) % 360; // SunCalc: 0=south → convert to from-North
                const sep = Math.hypot(best.alt - mp.altitude * DEG, azDelta(best.az, mAz));
                if (sep < 35) moonPenalty = (1 - sep / 35) * illum * 25;
            }
        }

        // At a genuinely dark site "what it is" matters as much as "how high":
        // a 25° Milky Way core beats an overhead minor cluster. Altitude is
        // useful but plateaus at 40° (anything that high is comfortably
        // observable); prominence carries the most weight.
        const score =
            Math.min(best.alt, 40) / 40 * 30 +   // altitude — above terrain & out of the murk
            best.clarity * 25 +                  // clear of the light dome
            t.prom * 45 -                        // how much of a must-see it is
            moonPenalty;

        const dir = bearingToDirection(best.az);
        const reasons = [];
        reasons.push(`highest ~${fmtTime(best.time)}, ${Math.round(best.alt)}° up in the ${dir}`);
        if (best.terrain > 5) reasons.push(`clears the ${Math.round(best.terrain)}° ridge there`);
        if (best.clarity < 0.85) reasons.push(`a bit into the ${site.lightDome?.direction || ''} glow — wait for it to rise`);
        else if (site.lightDome?.concentration > 0.45 && azDelta(best.az, (site.lightDome.azimuth + 180) % 360) < 60) reasons.push('opposite the city glow');
        if (moonPenalty > 8) reasons.push('moon sits nearby — fainter than ideal');

        ranked.push({
            name: t.name, icon: t.icon, type: t.type, blurb: t.blurb,
            bestTime: fmtTime(best.time), altitude: Math.round(best.alt), direction: dir,
            score: Math.round(score), reasons,
        });
    }

    ranked.sort((a, b) => b.score - a.score);
    return { targets: ranked.slice(0, limit) };
}
