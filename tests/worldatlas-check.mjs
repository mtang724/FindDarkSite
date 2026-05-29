/**
 * Verify the World Atlas national scan loads in the app and produces
 * truly-dark (Bortle 1/2) results around Great Basin.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PORT = process.env.PORT || 5177;

async function main() {
    await mkdir(SHOTS, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(
        () => document.querySelectorAll('#input-scan-pick option').length > 1,
        null, { timeout: 5000 }
    );

    const opts = await page.locator('#input-scan-pick option').allTextContents();
    console.log('[wa] dropdown options:', opts.length);
    opts.forEach(o => console.log('   ·', o));

    const waOpt = await page.locator('#input-scan-pick option').filter({ hasText: /worldatlas/i }).first();
    const waCount = await waOpt.count();
    console.log('[wa] worldatlas option present:', waCount > 0);

    if (waCount > 0) {
        const filename = await waOpt.getAttribute('value');
        console.log('[wa] selecting:', filename);

        // 71 MB scan fetch — wait for the response, not just the select event
        const respPromise = page.waitForResponse(r => r.url().endsWith(filename), { timeout: 60000 });
        await page.selectOption('#input-scan-pick', filename);
        const resp = await respPromise;
        console.log('[wa] scan loaded, status', resp.status());
        // Give the page a moment to JSON.parse the 71 MB payload
        await page.waitForTimeout(3000);

        // Catch the "please pick a scan" alert so it doesn't hang the test
        page.on('dialog', d => { console.log('[wa] dialog:', d.message()); d.dismiss().catch(() => {}); });

        // Great Basin NV — should turn up Bortle 1/2 results
        await page.fill('#input-location', '38.93, -114.30');
        await page.evaluate(() => {
            const r = document.querySelector('#input-radius');
            r.value = '60';
            r.dispatchEvent(new Event('input', { bubbles: true }));
            const s = document.querySelector('#input-sqm');
            s.value = '21.5'; // demand near-perfect skies
            s.dispatchEvent(new Event('input', { bubbles: true }));
            // Skip the slow network enrichment for this smoke check
            document.querySelector('#opt-weather').checked = false;
            document.querySelector('#opt-driving').checked = false;
        });

        await page.click('#btn-search');
        await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 240000 });
        await page.waitForTimeout(2000);

        // Inspect the first few cards' Bortle badges
        const badges = await page.locator('.bortle-badge').allTextContents();
        console.log('[wa] first 10 Bortle badges:', badges.slice(0, 10));

        // Check at least one Bortle 1 or 2 site (real World Atlas dark)
        const hasReallyDark = badges.some(b => /Bortle [12]\b/.test(b));
        console.log('[wa] has Bortle 1 or 2 result:', hasReallyDark);

        await page.screenshot({ path: path.join(SHOTS, 'worldatlas-great-basin.png'), fullPage: false });
    }

    console.log('PAGE ERRORS:', errs.length);
    errs.forEach(e => console.log(' ·', e));
    await browser.close();
    process.exit(errs.length || waCount === 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
