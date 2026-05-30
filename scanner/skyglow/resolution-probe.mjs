/**
 * De-risking probe for the DIY skyglow model. Before committing to a multi-GB
 * raw-VIIRS download + Garstang kernel, answer ONE question:
 *
 *   How much of Falchi's dark-end SQM variance can ANY model extract from the
 *   committed 5 km VIIRS radiance grid?
 *
 * We build multi-scale radiance features (summed radiance in distance rings
 * 0–10, 10–25, 25–50, 50–100, 100–200 km) at dark sample points and fit a
 * linear regression to Falchi SQM. The multiple-R is the *ceiling* for any
 * 5 km-VIIRS-based predictor, kernel shape aside.
 *
 *   |R| high  (>~0.7) → 5 km is enough; the single-scatter prototype's weakness
 *                       is the kernel/calibration, fixable WITHOUT a download.
 *   |R| ~0.5         → resolution is the binding constraint; raw ~500 m VIIRS
 *                       is mandatory to approach Falchi.
 *
 * Run:  node --max-old-space-size=3072 scanner/skyglow/resolution-probe.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', '..', 'public', 'data');
const log = (...a) => console.log('[probe]', ...a);

log('loading VIIRS + World Atlas…');
const viirs = JSON.parse(readFileSync(path.join(DATA, 'scan_bbox_-125_24_-66.5_50_5km.json'), 'utf8')).results;
const wa = JSON.parse(readFileSync(path.join(DATA, 'scan_bbox_-125_24_-66.5_50_5km_worldatlas.json'), 'utf8')).results;
const N = viirs.length;
const lat = new Float64Array(N), lng = new Float64Array(N), rad = new Float64Array(N);
for (let i = 0; i < N; i++) { lat[i] = viirs[i].lat; lng[i] = viirs[i].lng; rad[i] = viirs[i].radiance > 0 ? viirs[i].radiance : 0; }

// Source bin index (lit points).
const BIN = 0.25;
const bins = new Map();
for (let i = 0; i < N; i++) {
    if (rad[i] <= 0) continue;
    const k = `${Math.floor(lat[i] / BIN)},${Math.floor(lng[i] / BIN)}`;
    let b = bins.get(k); if (!b) bins.set(k, b = []); b.push(i);
}
const KM = 111.32;
const dist = (la1, lo1, la2, lo2) => {
    const dy = (la2 - la1) * KM, dx = (lo2 - lo1) * KM * Math.cos((la1 + la2) * 0.5 * Math.PI / 180);
    return Math.sqrt(dx * dx + dy * dy);
};
const RINGS = [10, 25, 50, 100, 200]; // km upper edges
function ringFeatures(la, lo) {
    const f = new Array(RINGS.length).fill(0);
    const Rmax = 200, dLat = Rmax / KM, dLng = Rmax / (KM * Math.cos(la * Math.PI / 180));
    const la0 = Math.floor((la - dLat) / BIN), la1 = Math.floor((la + dLat) / BIN);
    const lo0 = Math.floor((lo - dLng) / BIN), lo1 = Math.floor((lo + dLng) / BIN);
    for (let bi = la0; bi <= la1; bi++) for (let bj = lo0; bj <= lo1; bj++) {
        const b = bins.get(`${bi},${bj}`); if (!b) continue;
        for (const i of b) {
            const d = dist(la, lo, lat[i], lng[i]);
            for (let r = 0; r < RINGS.length; r++) if (d <= RINGS[r]) { f[r] += rad[i]; break; }
        }
    }
    return f.map(v => Math.log10(1 + v)); // log-compress (brightness spans orders of magnitude)
}

// Sample dark points (Falchi SQM ≥ 21).
log('building features at dark sample points…');
const X = [], y = [];
const stride = 37;
for (let i = 0; i < N; i += stride) {
    const s = wa[i].sqm;
    if (!(s >= 21)) continue;
    X.push([1, ...ringFeatures(lat[i], lng[i])]); // 1 = intercept
    y.push(s);
}
log(`  ${y.length} dark sample points, ${RINGS.length} ring features`);

// Per-feature correlation with Falchi SQM.
function corr(a, b) {
    const n = a.length, ma = a.reduce((p, q) => p + q, 0) / n, mb = b.reduce((p, q) => p + q, 0) / n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
    return sab / Math.sqrt(saa * sbb);
}
RINGS.forEach((r, k) => log(`  ring ≤${r}km  corr with Falchi SQM: ${corr(X.map(row => row[k + 1]), y).toFixed(3)}`));

// Multiple linear regression via normal equations  β = (XᵀX)⁻¹ Xᵀy.
const p = X[0].length;
const XtX = Array.from({ length: p }, () => new Float64Array(p));
const Xty = new Float64Array(p);
for (let n = 0; n < X.length; n++) {
    const row = X[n], yi = y[n];
    for (let a = 0; a < p; a++) { Xty[a] += row[a] * yi; for (let b = 0; b < p; b++) XtX[a][b] += row[a] * row[b]; }
}
// Gaussian elimination solve.
function solve(A, bvec) {
    const m = A.length, M = A.map((r, i) => [...r, bvec[i]]);
    for (let c = 0; c < m; c++) {
        let piv = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        [M[c], M[piv]] = [M[piv], M[c]];
        for (let r = 0; r < m; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[m] / r[i][i] === Infinity ? 0 : r[m] / M[i][i]);
}
const beta = solve(XtX.map(r => Array.from(r)), Array.from(Xty));
// Predictions + multiple R.
const pred = X.map(row => row.reduce((s, v, k) => s + v * beta[k], 0));
const R = corr(pred, y);
const ss = (() => { const my = y.reduce((a, b) => a + b, 0) / y.length; let sr = 0, st = 0; for (let i = 0; i < y.length; i++) { sr += (y[i] - pred[i]) ** 2; st += (y[i] - my) ** 2; } return { rmse: Math.sqrt(sr / y.length), r2: 1 - sr / st }; })();

log('── 5 km-VIIRS ceiling for predicting Falchi dark-end SQM ──');
log(`  multiple R = ${R.toFixed(3)}   R² = ${ss.r2.toFixed(3)}   RMSE = ${ss.rmse.toFixed(3)} mag`);
log(R < -0.7 || R > 0.7
    ? '  ► 5 km is ENOUGH — the prototype\'s weakness is the kernel/calibration, fixable without a download.'
    : '  ► resolution is the binding constraint — raw ~500 m VIIRS is needed to approach Falchi.');
