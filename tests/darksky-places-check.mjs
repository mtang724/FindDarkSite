/**
 * Verify the IDA Dark Sky Places overlay end-to-end:
 *   - public/data/dark-sky-places.json loads
 *   - ~135 markers render in the dedicated Leaflet layer
 *   - A Death Valley search shows the "🏞️ Death Valley National Park inside" badge
 *     on at least one card
 *   - Layer is in the layer-control toggle
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PROJECT_ROOT = path.dirname(__dirname);
const PORT = 5186;

const checks = [];
function check(name, pass, detail = '') {
    checks.push({ name, pass, detail });
    console.log(pass ? '✅' : '❌', name, detail ? `— ${detail}` : '');
}

async function startDev() {
    const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
        cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    proc.stdout.on('data', c => { if (/ready in|Local:/.test(c.toString())) ready = true; });
    proc.stderr.on('data', c => process.stderr.write('[vite] ' + c));
    const start = Date.now();
    while (!ready && Date.now() - start < 15000) await sleep(200);
    return proc;
}

async function main() {
    await mkdir(SHOTS, { recursive: true });
    const vite = await startDev();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('dialog', d => d.dismiss().catch(() => {}));

    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    try {
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => /WorldAtlas|VIIRS/.test(
            document.querySelector('#source-indicator')?.textContent || ''
        ), null, { timeout: 30000 });

        // 1. JSON loads
        const placesResp = await page.evaluate(async () => {
            const r = await fetch('/data/dark-sky-places.json');
            const j = await r.json();
            return { ok: r.ok, count: j.places?.length || 0, designations: [...new Set(j.places.map(p => p.designation))].sort() };
        });
        check('dark-sky-places.json served', placesResp.ok && placesResp.count >= 100, `count=${placesResp.count}, designations=${placesResp.designations.join(',')}`);

        // Give the map layer time to populate
        await page.waitForFunction(() => document.querySelectorAll('.darksky-marker').length > 50, null, { timeout: 10000 });
        const markerCount = await page.locator('.darksky-marker').count();
        check('IDA markers rendered on map', markerCount >= 100, `${markerCount} markers`);

        // 2. Layer control has the toggle
        await page.locator('.leaflet-control-layers').first().hover();
        await page.waitForTimeout(300);
        const hasToggle = await page.locator('.leaflet-control-layers label:has-text("IDA Dark Sky Places")').count();
        check('layer-control toggle present', hasToggle > 0);

        await page.screenshot({ path: path.join(SHOTS, 'darksky-initial-map.png'), fullPage: false });

        // 3. Death Valley search → expect IDA badge on at least one card
        await page.fill('#input-location', '36.50, -117.10');
        await page.evaluate(() => document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true })));
        await page.waitForTimeout(1500);
        await page.evaluate(() => {
            const r = document.querySelector('#input-radius');
            r.value = '60'; r.dispatchEvent(new Event('input', { bubbles: true }));
            const s = document.querySelector('#input-sqm');
            s.value = '21.0'; s.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#opt-weather').checked = false;
            document.querySelector('#opt-driving').checked = false;
            document.querySelector('#opt-horizon').checked = false;
            document.querySelector('#opt-hide-unreachable').checked = false;
        });
        await page.click('#btn-search');
        await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 240000 });
        await page.waitForTimeout(2000);

        const idaBadges = await page.locator('.card-meta-item:has-text("Death Valley National Park")').count();
        check('Death Valley NP badge on at least one card', idaBadges > 0, `${idaBadges} badges`);

        await page.screenshot({ path: path.join(SHOTS, 'darksky-deathvalley-badge.png'), fullPage: false });
    } finally {
        await browser.close().catch(() => {});
        vite.kill('SIGTERM');
        await sleep(500);
    }

    console.log('\nPAGE ERRORS:', errs.length);
    errs.slice(0, 5).forEach(e => console.log(' ·', e));
    const failed = checks.filter(c => !c.pass);
    console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
    process.exit(failed.length || errs.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
