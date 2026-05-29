/**
 * Verify the three new "ready to set up?" signals end-to-end:
 *   - 7Timer astro chips (seeing/transparency) appear when forecast data is in
 *   - Open-Meteo dew/wind chips appear and are color-coded
 *   - Protected-area polygons render on the map as a separate Leaflet layer
 *   - Sites inside a national park get a "🌲 ..." badge
 *
 * Death Valley (36.50, -117.10) is the perfect probe: hits VIIRS Bortle 1,
 * hits a national park, and has weather worth reporting.
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
const PORT = 5184;

const checks = [];
function check(name, pass, detail = '') {
    checks.push({ name, pass, detail });
    console.log(pass ? '✅' : '❌', name, detail ? `— ${detail}` : '');
}

async function startDev() {
    const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    proc.stdout.on('data', c => { if (/ready in|Local:/.test(c.toString())) ready = true; });
    proc.stderr.on('data', c => process.stderr.write('[vite] ' + c));
    const start = Date.now();
    while (!ready && Date.now() - start < 15000) await sleep(200);
    if (!ready) throw new Error('vite did not become ready');
    return proc;
}

async function main() {
    await mkdir(SHOTS, { recursive: true });
    const vite = await startDev();

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
    page.on('dialog', d => d.dismiss().catch(() => {}));

    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    let astroCount = 0, openMeteoCount = 0, astroOk = 0;
    page.on('response', async (resp) => {
        if (resp.url().includes('7timer') || resp.url().includes('/api/7timer')) {
            astroCount++;
            if (resp.status() === 200) astroOk++;
        }
        if (resp.url().includes('open-meteo.com/v1/forecast')) openMeteoCount++;
    });

    try {
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => /WorldAtlas|VIIRS/.test(
            document.querySelector('#source-indicator')?.textContent || ''
        ), null, { timeout: 30000 });
        await page.waitForTimeout(4000);

        // Death Valley area
        await page.fill('#input-location', '36.50, -117.10');
        await page.evaluate(() => document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true })));
        await page.waitForTimeout(1500);
        await page.evaluate(() => {
            const r = document.querySelector('#input-radius');
            r.value = '80'; r.dispatchEvent(new Event('input', { bubbles: true }));
            const s = document.querySelector('#input-sqm');
            s.value = '21.0'; s.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#opt-driving').checked = false;
            document.querySelector('#opt-horizon').checked = false;
            document.querySelector('#opt-hide-unreachable').checked = false;
        });

        await page.click('#btn-search');
        await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 240000 });
        await page.waitForTimeout(3500);

        // 1. Network: 7Timer + Open-Meteo both called
        check('Open-Meteo forecast called', openMeteoCount >= 1, `${openMeteoCount} calls`);
        check('7Timer ASTRO called and returned 200', astroOk >= 1, `${astroCount} calls, ${astroOk} ok`);

        // 2. Astro chips rendered (seeing / transparency / dew / wind)
        const seeingChips = await page.locator('.astro-chip:has-text("seeing")').count();
        const transpChips = await page.locator('.astro-chip:has-text("hazy"), .astro-chip:has-text("clear"), .astro-chip:has-text("pristine"), .astro-chip:has-text("milky"), .astro-chip:has-text("opaque")').count();
        const dewChips    = await page.locator('.astro-chip:has-text("dew margin")').count();
        const windChips   = await page.locator('.astro-chip:has-text("wind")').count();
        check('seeing chip present',      seeingChips > 0, `${seeingChips} chips`);
        check('transparency chip present', transpChips > 0, `${transpChips} chips`);
        check('dew margin chip present',   dewChips    > 0, `${dewChips} chips`);
        check('wind chip present',         windChips   > 0, `${windChips} chips`);

        // 3. Protected-area polygons on the map
        const polyCount = await page.locator('#map path.leaflet-interactive').count();
        check('protected-area polygons rendered on map', polyCount > 0, `${polyCount} interactive paths`);

        // 4. At least one card has the public-land badge (Death Valley NP is one of the largest)
        const landBadges = await page.locator('.card-meta-item:has-text("🌲")').count();
        check('public-land badge on at least one card', landBadges > 0, `${landBadges} badges`);

        await page.screenshot({ path: path.join(SHOTS, 'astro-landstatus.png'), fullPage: false });
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
