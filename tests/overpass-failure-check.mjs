/**
 * Verify graceful handling when Overpass fails:
 *   1. Block Overpass at the network layer → expect the error banner + retry button
 *   2. Click retry while Overpass is still blocked → expect a still-failed toast
 *   3. Unblock Overpass + click retry again → expect facilities to appear
 *
 * Also verifies the happy path still labels each card with POIs when Overpass works.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PORT = process.env.PORT || 5179;

const checks = [];
function check(name, pass, detail = '') {
    checks.push({ name, pass, detail });
    console.log(pass ? '✅' : '❌', name, detail ? `— ${detail}` : '');
}

async function main() {
    await mkdir(SHOTS, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });

    page.on('dialog', d => d.dismiss().catch(() => {}));

    let blockOverpass = true;
    await page.route('**/overpass-api.de/**', (route) => {
        if (blockOverpass) {
            route.fulfill({ status: 503, contentType: 'text/plain', body: 'simulated outage' });
        } else {
            route.continue();
        }
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => /WorldAtlas|VIIRS/.test(
        document.querySelector('#source-indicator')?.textContent || ''
    ), null, { timeout: 30000 });
    await page.waitForTimeout(4000);

    // San Jose default
    await page.fill('#input-location', '37.37, -121.88');
    await page.evaluate(() => document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
        const r = document.querySelector('#input-radius');
        r.value = '150'; r.dispatchEvent(new Event('input', { bubbles: true }));
        const s = document.querySelector('#input-sqm');
        s.value = '20.5'; s.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#opt-weather').checked = false;
        document.querySelector('#opt-driving').checked = false;
    });

    await page.click('#btn-search');
    await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 240000 });
    await page.waitForTimeout(1500);

    const errorBanner = await page.locator('.overpass-error').count();
    const retryBtn = await page.locator('#btn-retry-overpass').count();
    check('error banner shown when Overpass fails', errorBanner === 1);
    check('retry button shown', retryBtn === 1);

    const errorDetail = await page.locator('.overpass-error-detail').textContent().catch(() => '');
    check('error banner shows HTTP code', /HTTP\s*5\d\d/.test(errorDetail), errorDetail.trim());

    await page.screenshot({ path: path.join(SHOTS, 'overpass-fail-banner.png'), fullPage: false });

    // Retry while still blocked → should still fail gracefully
    await page.click('#btn-retry-overpass');
    await page.waitForTimeout(2000);
    const stillBlocked = await page.locator('.overpass-error').count();
    check('retry while blocked keeps error banner', stillBlocked === 1);

    // Unblock + retry → expect facilities to populate
    blockOverpass = false;
    // Some delay so the toast from previous retry fades
    await page.waitForTimeout(1500);
    await page.click('#btn-retry-overpass');
    // After retry, the banner should disappear and facilities tags should appear
    await page.waitForFunction(() => document.querySelectorAll('.overpass-error').length === 0, null, { timeout: 60000 });
    await page.waitForTimeout(500);
    const banner2 = await page.locator('.overpass-error').count();
    const poiSections = await page.locator('.card-pois').count();
    check('retry after recovery clears banner', banner2 === 0);
    check('retry after recovery loads POI sections', poiSections > 0, `${poiSections} cards have POI sections`);

    await page.screenshot({ path: path.join(SHOTS, 'overpass-recovered.png'), fullPage: false });

    const failed = checks.filter(c => !c.pass);
    console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
    await browser.close();
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
