/**
 * Snapshot the Locals tab for SF and Austin to show the wider coverage.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PORT = process.env.PORT || 5191;

async function search(page, location) {
    if (await page.locator('#results-panel').isVisible().catch(() => false)) {
        await page.click('#btn-back');
        await page.waitForTimeout(500);
    }
    await page.fill('#input-location', location);
    await page.evaluate(() => document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
        document.querySelector('#opt-weather').checked = false;
        document.querySelector('#opt-driving').checked = false;
        document.querySelector('#opt-horizon').checked = false;
        document.querySelector('#opt-hide-unreachable').checked = false;
    });
    await page.click('#btn-search');
    await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 240000 });
    await page.waitForTimeout(2500);
}

async function main() {
    await mkdir(SHOTS, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1480, height: 1100 }, deviceScaleFactor: 2 });
    page.on('dialog', d => d.dismiss().catch(() => {}));

    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => /WorldAtlas|VIIRS/.test(
        document.querySelector('#source-indicator')?.textContent || ''
    ), null, { timeout: 30000 });
    await page.waitForTimeout(2500);

    // SF: should show 18 places
    await search(page, 'San Francisco, CA');
    const localsBtn = page.locator('.view-toggle-btn').filter({ hasText: /Locals/ }).first();
    if (await localsBtn.count()) {
        await localsBtn.click();
        await page.waitForTimeout(500);
        const rows = await page.locator('.reddit-row').count();
        console.log(`SF Locals rows: ${rows}`);
        await page.screenshot({ path: path.join(SHOTS, 'locals-expanded-sf.png'), fullPage: false });
    }

    // Austin: nearest metro will be San Antonio (~125 km)
    await search(page, 'Austin, TX');
    const localsBtn2 = page.locator('.view-toggle-btn').filter({ hasText: /Locals/ }).first();
    if (await localsBtn2.count()) {
        await localsBtn2.click();
        await page.waitForTimeout(500);
        const rows = await page.locator('.reddit-row').count();
        const header = await page.locator('.reddit-section-header').textContent().catch(() => '');
        console.log(`Austin Locals: rows=${rows}, header="${header.trim()}"`);
        await page.screenshot({ path: path.join(SHOTS, 'locals-expanded-austin.png'), fullPage: false });
    } else {
        console.log('Austin: no Locals tab (no covered metro within 250 km).');
    }

    console.log('\nPage errors:', errs.length);
    errs.slice(0, 5).forEach(e => console.log(' ·', e));
    await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
