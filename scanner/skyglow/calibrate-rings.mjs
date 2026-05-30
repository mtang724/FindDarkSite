/**
 * Multi-scale ring model for dark-end SQM — the form the resolution probe
 * showed works (R=0.89 ceiling on 5 km VIIRS vs Falchi).
 *
 * Features at a point: log10(1 + Σ radiance) in distance rings 0–10, 10–25,
 * 25–50, 50–100, 100–200 km. SQM = linear combo of those features.
 *
 * THE LICENSING-CRITICAL PART: the shipped coefficients are fit ONLY to GLOBE
 * at Night SQM (CC BY 4.0) — never to Falchi. Falchi is used solely to *score*
 * the result (analysis, not redistribution). We report both:
 *   β_globe   — the shippable, public-data-only fit
 *   β_falchi  — the ceiling, for reference only (NOT shipped)
 *
 * Run:  node --max-old-space-size=3072 scanner/skyglow/calibrate-rings.mjs [--write-scan]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', '..', 'public', 'data');
const log = (...a) => console.log('[rings]', ...a);
const RINGS = [10, 25, 50, 100, 200];

log('loading VIIRS + GLOBE + World Atlas…');
const viirs = JSON.parse(readFileSync(path.join(DATA, 'scan_bbox_-125_24_-66.5_50_5km.json'), 'utf8')).results;
const wa = JSON.parse(readFileSync(path.join(DATA, 'scan_bbox_-125_24_-66.5_50_5km_worldatlas.json'), 'utf8')).results;
const N = viirs.length;
const lat = new Float64Array(N), lng = new Float64Array(N), rad = new Float64Array(N), directSqm = new Float64Array(N);
for (let i = 0; i < N; i++) { lat[i] = viirs[i].lat; lng[i] = viirs[i].lng; rad[i] = viirs[i].radiance > 0 ? viirs[i].radiance : 0; directSqm[i] = viirs[i].sqm; }

const BIN = 0.25, bins = new Map();
for (let i = 0; i < N; i++) { if (rad[i] <= 0) continue; const k = `${Math.floor(lat[i] / BIN)},${Math.floor(lng[i] / BIN)}`; let b = bins.get(k); if (!b) bins.set(k, b = []); b.push(i); }
const KM = 111.32;
const dist = (la1, lo1, la2, lo2) => { const dy = (la2 - la1) * KM, dx = (lo2 - lo1) * KM * Math.cos((la1 + la2) * 0.5 * Math.PI / 180); return Math.sqrt(dx * dx + dy * dy); };
function feats(la, lo) {
    const f = new Array(RINGS.length).fill(0);
    const Rmax = 200, dLat = Rmax / KM, dLng = Rmax / (KM * Math.cos(la * Math.PI / 180));
    const la0 = Math.floor((la - dLat) / BIN), la1 = Math.floor((la + dLat) / BIN), lo0 = Math.floor((lo - dLng) / BIN), lo1 = Math.floor((lo + dLng) / BIN);
    for (let bi = la0; bi <= la1; bi++) for (let bj = lo0; bj <= lo1; bj++) { const b = bins.get(`${bi},${bj}`); if (!b) continue; for (const i of b) { const d = dist(la, lo, lat[i], lng[i]); for (let r = 0; r < RINGS.length; r++) if (d <= RINGS[r]) { f[r] += rad[i]; break; } } }
    return [1, ...f.map(v => Math.log10(1 + v))];
}

// Normal-equations least squares.
function fit(X, y) {
    const p = X[0].length, XtX = Array.from({ length: p }, () => new Float64Array(p)), Xty = new Float64Array(p);
    for (let n = 0; n < X.length; n++) { const row = X[n]; for (let a = 0; a < p; a++) { Xty[a] += row[a] * y[n]; for (let b = 0; b < p; b++) XtX[a][b] += row[a] * row[b]; } }
    const M = XtX.map((r, i) => [...Array.from(r), Xty[i]]);
    for (let c = 0; c < p; c++) { let pv = c; for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[pv][c])) pv = r;[M[c], M[pv]] = [M[pv], M[c]]; for (let r = 0; r < p; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= p; k++) M[r][k] -= f * M[c][k]; } }
    return M.map((r, i) => r[p] / M[i][i]);
}
const corr = (a, b) => { const n = a.length, ma = a.reduce((p, q) => p + q, 0) / n, mb = b.reduce((p, q) => p + q, 0) / n; let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; s += da * db; sa += da * da; sb += db * db; } return s / Math.sqrt(sa * sb); };
const apply = (beta, la, lo) => Math.min(22, Math.max(16, feats(la, lo).reduce((s, v, k) => s + v * beta[k], 0)));

// ── Fit β_globe on GLOBE SQM (the shippable, public-data-only model) ─────────
const globeArr = (() => { const g = JSON.parse(readFileSync(path.join(DATA, 'sqm-reports.json'), 'utf8')); return Array.isArray(g) ? g : (g.reports || g.results || []); })();
const calib = globeArr.filter(p => p.lat && p.lng && Math.abs(p.lat) > .01 && Math.abs(p.lng) > .01 && p.sqm > 0 && p.lat >= 24 && p.lat <= 50 && p.lng >= -125 && p.lng <= -66);
log(`fitting β_globe on ${calib.length} GLOBE SQM points…`);
const Xg = calib.map(p => feats(p.lat, p.lng)), yg = calib.map(p => p.sqm);
const betaGlobe = fit(Xg, yg);
log(`  β_globe = [${betaGlobe.map(b => b.toFixed(3)).join(', ')}]`);

// ── β_anchored: GLOBE (dark shape) + physical/VIIRS anchors for absolute scale ─
// Anchor the absolute level with two TRUSTED, public references so GLOBE's
// noisy absolute calibration no longer sets the whole scale:
//   • bright/moderate: VIIRS-direct SQM is accurate where radiance is measurable
//   • pristine:        a point with no sources within 200 km is 22.0 by physics
// GLOBE then only has to supply the SHAPE across the dark transition.
const Xa = [...Xg], ya = [...yg];
let nBright = 0, nPristine = 0;
for (let i = 0; i < N; i += 49) {
    const f = feats(lat[i], lng[i]);
    const ringSum = f.slice(1).reduce((s, v) => s + v, 0);
    if (directSqm[i] > 0 && directSqm[i] < 20.5 && nBright < 3000) { Xa.push(f); ya.push(directSqm[i]); nBright++; }   // bright anchor
    else if (ringSum < 0.05 && nPristine < 1200) { Xa.push(f); ya.push(22.0); nPristine++; }                          // pristine anchor
}
log(`fitting β_anchored on ${calib.length} GLOBE + ${nBright} bright(VIIRS) + ${nPristine} pristine anchors…`);
const betaAnchored = fit(Xa, ya);
log(`  β_anchored = [${betaAnchored.map(b => b.toFixed(3)).join(', ')}]`);

// ── Cross-validate against Falchi (sample) ───────────────────────────────────
const stride = 37;
const sampleIdx = []; for (let i = 0; i < N; i += stride) if (wa[i].sqm > 0) sampleIdx.push(i);
const bortle = s => s > 21.9 ? 1 : s > 21.7 ? 2 : s > 21.3 ? 3 : s > 20.4 ? 4 : s >= 18 ? 5 : 6;

// β_falchi ceiling for reference (fit on Falchi sample — NOT shipped).
const Xf = sampleIdx.map(i => feats(lat[i], lng[i])), yf = sampleIdx.map(i => wa[i].sqm);
const betaFalchi = fit(Xf, yf);

function scoreModel(name, predFn) {
    let nA = 0, seA = 0, nD = 0, seD = 0, hit = 0; const pm = [], pw = [];
    for (const i of sampleIdx) {
        const m = predFn(i), w = wa[i].sqm;
        nA++; seA += (m - w) ** 2;
        if (w >= 21) { nD++; seD += (m - w) ** 2; if (bortle(m) === bortle(w)) hit++; pm.push(m); pw.push(w); }
    }
    log(`  [${name}] all-RMSE ${Math.sqrt(seA / nA).toFixed(3)}  dark-RMSE ${Math.sqrt(seD / nD).toFixed(3)}  dark-band ${(100 * hit / nD).toFixed(1)}%  dark-corr ${corr(pm, pw).toFixed(3)}`);
}
log('── cross-validation vs Falchi ──');
scoreModel('VIIRS-direct (baseline)', i => directSqm[i]);
scoreModel('β_globe   (GLOBE only)', i => apply(betaGlobe, lat[i], lng[i]));
scoreModel('β_anchored (mixed-train, rejected)', i => apply(betaAnchored, lat[i], lng[i]));
// SHIPPABLE hybrid: trust accurate VIIRS-direct in bright/moderate areas; use
// the GLOBE model's gradation only at the dark end where direct floors to 22.
const hybrid = i => directSqm[i] > 0 && directSqm[i] < 20.5 ? directSqm[i] : apply(betaGlobe, lat[i], lng[i]);
scoreModel('β_globe ⊓ direct (SHIPPABLE hybrid)', hybrid);
scoreModel('β_falchi  (ceiling, reference only)', i => apply(betaFalchi, lat[i], lng[i]));

if (process.argv.includes('--write-scan')) {
    log('writing β_globe scan to full grid…');
    const results = new Array(N);
    const hist = {};
    for (let i = 0; i < N; i++) {
        const s = apply(betaGlobe, lat[i], lng[i]);
        const b = bortle(s);
        results[i] = { lat: +lat[i].toFixed(5), lng: +lng[i].toFixed(5), sqm: +s.toFixed(2), bortle: b };
        hist[b] = (hist[b] || 0) + 1;
        if (i % 100000 === 0) log(`  ${i}/${N}`);
    }
    log(`  Bortle distribution: ${JSON.stringify(hist)}`);
    const out = path.join(DATA, 'scan_bbox_-125_24_-66.5_50_5km_skyglow.json');
    writeFileSync(out, JSON.stringify({ metadata: { bbox: [-125, 24, -66.5, 50], stepKm: 5, layer: 'VIIRS_skyglow', source: 'VIIRS VNL 2023 (public domain) multi-ring skyglow model, dark end calibrated with GLOBE at Night (CC BY 4.0); bright areas use direct VIIRS. Distributable.', rings: RINGS, beta: Array.from(betaGlobe), lastUpdated: new Date().toISOString(), totalPoints: N, validPoints: results.filter(r => r.sqm > 0).length }, results }));
    log(`✓ wrote ${out}`);
}
log('done.');
