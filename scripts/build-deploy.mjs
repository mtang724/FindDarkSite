/**
 * Deploy build with a license guard.
 *
 * `vite build` copies ALL of public/ into dist/ — including the local World
 * Atlas scan (Falchi 2016, NO redistribution) and a local index.json that
 * references it. Publishing dist/ as-is would redistribute restricted data.
 *
 * This wrapper builds normally, then SCRUBS dist/ of anything World-Atlas:
 *   1. delete dist/data/*worldatlas*.json
 *   2. strip any worldatlas entry from dist/data/index.json
 *   3. fail loudly if any restricted DATA survives in dist/data/ (the app JS
 *      legitimately contains the string "worldatlas" as source-detection code —
 *      that's not data, so only dist/data/ is scrubbed/checked)
 *   4. pre-gzip the big scan JSON for nginx `gzip_static`
 *
 * The distributable Sky-glow layer stays in, so the public build still ships
 * Bortle 1/2/3. Source public/ is never touched.
 *
 * Run:  npm run build:deploy
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, rmSync, statSync, createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const DIST_DATA = path.join(DIST, 'data');
const log = (...a) => console.log('[build:deploy]', ...a);

// 1. Build.
log('vite build…');
const r = spawnSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);

// 2. Remove World-Atlas scans from dist/.
let removed = 0;
for (const f of readdirSync(DIST_DATA)) {
    if (/worldatlas/i.test(f)) { rmSync(path.join(DIST_DATA, f)); removed++; log(`removed ${f}`); }
}

// 3. Strip worldatlas entries from dist/data/index.json.
const idxPath = path.join(DIST_DATA, 'index.json');
const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
const before = idx.scans.length;
idx.scans = idx.scans.filter(s => !/worldatlas/i.test(s.filename || ''));
writeFileSync(idxPath, JSON.stringify(idx, null, 2));
if (idx.scans.length !== before) log(`stripped ${before - idx.scans.length} worldatlas entry from index.json`);

// 4. Verify: no restricted DATA in dist/data/ — by filename, or by content of
//    any data file (e.g. a leftover index.json reference). The compiled app JS
//    contains "worldatlas" as legitimate source-detection code, so we only
//    scrub/check the data directory, never the bundle.
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]); }
const leaks = walk(DIST_DATA).filter(f => /worldatlas/i.test(path.basename(f)) || /worldatlas/i.test((() => { try { return readFileSync(f, 'utf8'); } catch { return ''; } })()));
if (leaks.length) {
    log('✗ LICENSE GUARD FAILED — World Atlas data still present in dist/data/:');
    leaks.forEach(f => log('   ' + path.relative(DIST, f)));
    process.exit(1);
}

// 5. Pre-gzip big JSON so nginx can `gzip_static`.
const big = walk(DIST_DATA).filter(f => f.endsWith('.json') && statSync(f).size > 1024 * 1024);
for (const f of big) {
    await pipeline(createReadStream(f), createGzip({ level: 9 }), createWriteStream(f + '.gz'));
    log(`gzipped ${path.relative(DIST, f)} (${(statSync(f).size / 1e6).toFixed(1)}MB → ${(statSync(f + '.gz').size / 1e6).toFixed(1)}MB)`);
}

const hasSkyglow = idx.scans.some(s => /skyglow/i.test(s.filename || ''));
log(`✓ clean deploy build. removed ${removed} restricted file(s). Sky-glow Bortle 1/2/3 present: ${hasSkyglow}`);
log(`  dist/ ready — deploy it (see docs/SELF-HOSTING.md).`);
