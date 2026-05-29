/**
 * Snapshot the new visual language in a few key states:
 *   1. Cold-load search panel
 *   2. Results By Site (SF, all the bells-and-whistles enabled)
 *   3. Best Nights view
 *   4. Reddit section detail
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PORT = process.env.PORT || 5189;

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
    await page.waitForTimeout(3000);

    await page.screenshot({ path: path.join(SHOTS, 'redesign-01-cold.png'), fullPage: false });

    // Expand Advanced
    await page.locator('.advanced-panel summary').click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, 'redesign-02-advanced.png'), fullPage: false });
    // Collapse it back so cold panel feels clean for the rest
    await page.locator('.advanced-panel summary').click();
    await page.waitForTimeout(300);

    // SF search
    await page.fill('#input-location', 'San Francisco, CA');
    await page.evaluate(() => document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForTimeout(1500);
    await page.click('#btn-search');
    await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 240000 });
    await page.waitForTimeout(3500);

    await page.screenshot({ path: path.join(SHOTS, 'redesign-03-results-bysite.png'), fullPage: false });

    // Switch to Best Nights
    const toggle = await page.locator('.view-toggle-btn[data-view="nights"]').count();
    if (toggle) {
        await page.click('.view-toggle-btn[data-view="nights"]');
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(SHOTS, 'redesign-04-best-nights.png'), fullPage: false });
        // and back
        await page.click('.view-toggle-btn[data-view="sites"]');
        await page.waitForTimeout(600);
    }

    // Hover an active card to show the corner ticks
    const firstCard = page.locator('.result-card').first();
    if (await firstCard.count()) {
        await firstCard.hover();
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SHOTS, 'redesign-05-card-hover.png'), fullPage: false });
    }

    console.log('Page errors:', errs.length);
    errs.slice(0, 5).forEach(e => console.log(' ·', e));
    await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
