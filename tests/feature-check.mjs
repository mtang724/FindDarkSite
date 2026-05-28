/**
 * Quick visual + interaction check of the new features.
 * Assumes a dev server is already running on the port below.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PORT = process.env.PORT || 5175;

const log = (...a) => console.log('[feat]', ...a);

async function shot(page, name) {
    await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

async function main() {
    await mkdir(SHOTS, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
    const page = await ctx.newPage();

    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    log('loading page');
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('#input-scan-pick option').length > 1, null, { timeout: 5000 }).catch(() => {});

    // Check moon chip rendered with text
    const moonText = await page.locator('#moon-text').textContent();
    log('moon chip text:', moonText);

    // Check elevation slider exists
    const elevSlider = await page.locator('#input-min-elev').count();
    log('elevation slider present:', elevSlider === 1);

    // Check enrichment toggles exist
    const weatherToggle = await page.locator('#opt-weather').count();
    const drivingToggle = await page.locator('#opt-driving').count();
    log('enrichment toggles present:', weatherToggle === 1 && drivingToggle === 1);

    await shot(page, 'feat-01-initial');

    // Pick the San Jose scan and run a search at its center
    await page.selectOption('#input-scan-pick', 'scan_37.3704_-121.8784_200km.json');
    await page.fill('#input-location', '37.3704, -121.8784');

    // Trigger location-input change event (auto-select fires on change)
    await page.evaluate(() => {
        document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Set elevation filter for fun
    await page.evaluate(() => {
        const e = document.querySelector('#input-min-elev');
        e.value = '300';
        e.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await shot(page, 'feat-02-configured');

    await page.click('#btn-search');
    log('search clicked, waiting...');

    const resultsAppeared = await page.locator('#results-panel')
        .waitFor({ state: 'visible', timeout: 120000 })
        .then(() => true).catch(() => false);
    log('results appeared:', resultsAppeared);

    // Wait an extra moment for enrichment to fill in
    await page.waitForTimeout(2000);
    await shot(page, 'feat-03-results');

    // Check for forecast strips and meta rows
    const forecastCount = await page.locator('.card-forecast').count();
    const metaCount = await page.locator('.card-meta').count();
    const shareCount = await page.locator('.btn-share').count();
    log(`forecast strips: ${forecastCount}, meta rows: ${metaCount}, share buttons: ${shareCount}`);

    // Try a share button → toast
    if (shareCount > 0) {
        await page.locator('#results-list .btn-share').first().click();
        await page.waitForTimeout(500);
        const toast = await page.locator('.toast').textContent().catch(() => '');
        log('toast after share click:', toast);
        await shot(page, 'feat-04-share-toast');
    }

    // Open favorites + save a site
    if (await page.locator('.btn-save').count() > 0) {
        await page.locator('#results-list .btn-save').first().click();
        await page.waitForTimeout(300);
    }
    await page.click('#btn-favorites');
    await page.waitForTimeout(300);
    await shot(page, 'feat-05-favorites');

    // Try export — confirm download starts
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 3000 }).catch(() => null),
        page.click('#btn-export-fav'),
    ]);
    log('export download started:', !!download, download ? download.suggestedFilename() : '');

    log('\nPAGE ERRORS:', errs.length);
    errs.slice(0, 10).forEach(e => log(' ·', e));

    await browser.close();
    process.exit(errs.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
