/**
 * Astronomy helpers — moon phase / illumination / rise+set, sun set/rise.
 * Backed by suncalc.
 */

import SunCalc from 'suncalc';

const PHASE_NAMES = [
    { max: 0.03, name: 'New Moon', icon: '🌑' },
    { max: 0.22, name: 'Waxing Crescent', icon: '🌒' },
    { max: 0.28, name: 'First Quarter', icon: '🌓' },
    { max: 0.47, name: 'Waxing Gibbous', icon: '🌔' },
    { max: 0.53, name: 'Full Moon', icon: '🌕' },
    { max: 0.72, name: 'Waning Gibbous', icon: '🌖' },
    { max: 0.78, name: 'Last Quarter', icon: '🌗' },
    { max: 0.97, name: 'Waning Crescent', icon: '🌘' },
    { max: 1.01, name: 'New Moon', icon: '🌑' },
];

function classifyPhase(phase) {
    for (const p of PHASE_NAMES) if (phase < p.max) return p;
    return PHASE_NAMES[0];
}

/**
 * Tonight's moon summary for a given date+location.
 * `date` defaults to "next sunset" — i.e. the upcoming local evening.
 */
export function moonSummary(lat, lng, date = new Date()) {
    const illum = SunCalc.getMoonIllumination(date);
    const times = SunCalc.getMoonTimes(date, lat, lng);
    const sun = SunCalc.getTimes(date, lat, lng);
    const cls = classifyPhase(illum.phase);
    return {
        phase: illum.phase,
        phaseName: cls.name,
        phaseIcon: cls.icon,
        illumination: illum.fraction, // 0..1
        moonrise: times.rise || null,
        moonset: times.set || null,
        alwaysUp: !!times.alwaysUp,
        alwaysDown: !!times.alwaysDown,
        sunset: sun.sunset || null,
        sunrise: sun.sunrise || null,
        nauticalDusk: sun.nauticalDusk || null,
        nauticalDawn: sun.nauticalDawn || null,
        astronomicalDusk: sun.nightEnd ? null : sun.night, // night = astro dusk start
        astronomicalDawn: sun.nightEnd || null,
    };
}

/**
 * Estimate "darkness window" tonight — start at astronomical dusk (or nautical
 * if astro never reached), end at astronomical dawn (or moonset/sunrise,
 * whichever is sooner past the moon being up).
 *
 * Returns { darkStart, darkEnd, hoursDark, moonInterferes }.
 * Anything that can't be computed comes back as null.
 */
export function darknessWindow(lat, lng, date = new Date()) {
    const sun = SunCalc.getTimes(date, lat, lng);
    const dusk = sun.night || sun.nauticalDusk || sun.dusk || null;
    const dawn = sun.nightEnd || sun.nauticalDawn || sun.dawn || null;
    if (!dusk || !dawn || isNaN(dusk) || isNaN(dawn)) {
        return { darkStart: null, darkEnd: null, hoursDark: null, moonInterferes: false };
    }
    // dawn next morning is later than dusk this evening
    const darkStart = dusk;
    const darkEnd = dawn > dusk ? dawn : new Date(dawn.getTime() + 24 * 3600 * 1000);
    const hoursDark = (darkEnd - darkStart) / 3600000;

    // Check moon during window
    const times = SunCalc.getMoonTimes(date, lat, lng);
    const illum = SunCalc.getMoonIllumination(darkStart);
    const moonUpDuringWindow = (times.alwaysUp)
        || (times.rise && times.rise < darkEnd && (!times.set || times.set > darkStart));
    const moonInterferes = !!(moonUpDuringWindow && illum.fraction > 0.25);

    return { darkStart, darkEnd, hoursDark, moonInterferes };
}

export function formatLocalTime(d) {
    if (!d) return '—';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Moon interference over the *real* astronomical-dark window for a given
 * calendar night, rather than a fixed 21:00–05:00 block. Samples actual moon
 * altitude across [astro dusk → astro dawn] so summer short-nights, high
 * latitudes, and mid-window moonsets are all handled correctly.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {string} dateStr - 'YYYY-MM-DD' (the evening this night begins)
 * @returns {null | {
 *   illumination:number, icon:string, fractionInterference:number,
 *   darkStart:Date, darkEnd:Date, hoursDark:number,
 *   moonUpFraction:number, moonsetDuringWindow:Date|null
 * }}  fractionInterference is moon-up-fraction × illumination, in 0..1.
 */
export function moonInterferenceForNight(lat, lng, dateStr) {
    if (!dateStr) return null;
    // Anchor at noon of that date so getTimes() returns this evening's dusk.
    const anchor = new Date(dateStr + 'T12:00:00');
    if (isNaN(anchor)) return null;

    const sun = SunCalc.getTimes(anchor, lat, lng);
    // Prefer astronomical night; degrade to nautical / civil / sunset if the
    // sun never dips far enough (high-latitude summer).
    let darkStart = sun.night || sun.nauticalDusk || sun.dusk || sun.sunset;
    let darkEnd = sun.nightEnd || sun.nauticalDawn || sun.dawn || sun.sunrise;
    if (!darkStart || !darkEnd || isNaN(darkStart) || isNaN(darkEnd)) {
        // Polar / undefined twilight: approximate a fixed 21:00→05:00 block.
        darkStart = new Date(anchor.getTime() + 9 * 3600e3);
        darkEnd = new Date(anchor.getTime() + 17 * 3600e3);
    }
    if (darkEnd <= darkStart) darkEnd = new Date(darkEnd.getTime() + 24 * 3600e3);

    const illum = SunCalc.getMoonIllumination(darkStart);
    const stepMs = 20 * 60 * 1000;
    let up = 0, total = 0, prevUp = null, moonsetDuringWindow = null;
    for (let t = darkStart.getTime(); t <= darkEnd.getTime(); t += stepMs) {
        const alt = SunCalc.getMoonPosition(new Date(t), lat, lng).altitude;
        const isUp = alt > 0;
        if (isUp) up++;
        total++;
        if (prevUp === true && !isUp && moonsetDuringWindow == null) {
            moonsetDuringWindow = new Date(t);
        }
        prevUp = isUp;
    }
    const moonUpFraction = total ? up / total : 0;
    const cls = classifyPhase(illum.phase);
    return {
        illumination: illum.fraction,
        icon: cls.icon,
        fractionInterference: moonUpFraction * illum.fraction,
        darkStart,
        darkEnd,
        hoursDark: (darkEnd - darkStart) / 3600000,
        moonUpFraction,
        moonsetDuringWindow,
    };
}
