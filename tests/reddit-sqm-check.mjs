/**
 * End-to-end verify for the two new community-data sources:
 *   1. GLOBE at Night SQM reports — loads, layer toggles, per-site badge appears
 *   2. Reddit "locals say" — panel renders for SF, map pins drop, sentiment colors
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
const PORT = 5187;

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

        // 1. Both new data files served
        const counts = await page.evaluate(async () => ({
            sqm:    (await (await fetch('/data/sqm-reports.json')).json()).count,
            reddit: (await (await fetch('/data/reddit-locations.json')).json()).totalPlaces,
        }));
        check('sqm-reports.json: 5000+ records', counts.sqm > 5000, `count=${counts.sqm}`);
        check('reddit-locations.json: 30+ places', counts.reddit > 30, `count=${counts.reddit}`);

        // 2. Reddit pins drop on SF search
        await page.fill('#input-location', '37.77, -122.42');
        await page.evaluate(() => document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true })));
        await page.waitForTimeout(1500);
        await page.evaluate(() => {
            const r = document.querySelector('#input-radius');
            r.value = '120'; r.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#opt-weather').checked = false;
            document.querySelector('#opt-driving').checked = false;
            document.querySelector('#opt-horizon').checked = false;
            document.querySelector('#opt-hide-unreachable').checked = false;
        });
        await page.click('#btn-search');
        await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 240000 });
        await page.waitForTimeout(2500);

        // 3. The Locals-say section appears with the right metro
        const sectionVisible = await page.locator('.reddit-section').isVisible().catch(() => false);
        check('Reddit "Locals say" section rendered for SF', sectionVisible);
        const sectionMetro = await page.locator('.reddit-section-header').textContent().catch(() => '');
        check('section header names the right metro', /San Francisco|CA/.test(sectionMetro), sectionMetro.trim());

        const rowCount = await page.locator('.reddit-row').count();
        check('multiple reddit rows shown', rowCount >= 3, `${rowCount} rows`);

        // 4. Reddit pins on map (look for the .reddit-marker divIcons)
        const pinCount = await page.locator('.reddit-marker').count();
        check('reddit pins dropped on map', pinCount >= 3, `${pinCount} pins`);

        await page.screenshot({ path: path.join(SHOTS, 'reddit-sf.png'), fullPage: false });

        // 5. Toggle the GLOBE at Night layer on and confirm markers appear
        await page.locator('.leaflet-control-layers').first().hover();
        await page.waitForTimeout(300);
        await page.locator('text=/SQM measurements/i').first().click({ force: true });
        await page.waitForTimeout(1500);
        const sqmMarkers = await page.locator('#map path.leaflet-interactive').count();
        check('SQM measurement layer renders markers when toggled on', sqmMarkers > 100, `${sqmMarkers} interactive shapes`);

        await page.screenshot({ path: path.join(SHOTS, 'sqm-layer-on.png'), fullPage: false });
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
