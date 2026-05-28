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
