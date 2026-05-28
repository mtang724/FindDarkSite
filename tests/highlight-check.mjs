/**
 * Verify card click highlights the matching map marker.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PORT = process.env.PORT || 5176;

async function main() {
    await mkdir(SHOTS, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('#input-scan-pick option').length > 1, null, { timeout: 5000 });
    await page.selectOption('#input-scan-pick', 'scan_37.3704_-121.8784_200km.json');
    await page.fill('#input-location', '37.3704, -121.8784');
    await page.click('#btn-search');
    await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 120000 });
    await page.waitForTimeout(2000);

    // Click the 3rd result card (something not at center)
    const card = page.locator('.result-card').nth(2);
    await card.click();
    await page.waitForTimeout(800);

    // Look for the active card class and an open popup
    const activeCount = await page.locator('.result-card.active').count();
    const popupOpen = await page.locator('.leaflet-popup').count();
    const enlargedMarkerCount = await page.evaluate(() => {
        // Big stroked marker = our highlight style
        return Array.from(document.querySelectorAll('.leaflet-interactive'))
            .filter(el => parseFloat(el.getAttribute('stroke-width')) >= 4).length;
    });

    console.log('[hl] active cards:', activeCount);
    console.log('[hl] popups open:', popupOpen);
    console.log('[hl] markers with stroke-width >= 4:', enlargedMarkerCount);

    await page.screenshot({ path: path.join(SHOTS, 'highlight-after-click.png'), fullPage: false });

    console.log('PAGE ERRORS:', errs.length);
    errs.forEach(e => console.log(' ·', e));
    await browser.close();
    process.exit(errs.length || activeCount !== 1 || popupOpen === 0 || enlargedMarkerCount === 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
