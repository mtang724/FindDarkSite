/**
 * Verify the new Auto-source workflow:
 *  - Dropdown defaults to Auto
 *  - Entering a CONUS location auto-picks WorldAtlas national
 *  - Source indicator reflects the active choice
 *  - Picking an explicit scan switches the indicator
 *  - Search runs end-to-end against the auto pick
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PORT = process.env.PORT || 5178;

const checks = [];
function check(name, pass, detail = '') {
    checks.push({ name, pass, detail });
    console.log(pass ? '✅' : '❌', name, detail ? `— ${detail}` : '');
}

async function main() {
    await mkdir(SHOTS, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('dialog', d => { console.log('dialog:', d.message()); d.dismiss().catch(() => {}); });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(
        () => document.querySelectorAll('#input-scan-pick option').length > 1,
        null, { timeout: 5000 }
    );

    // 1. Default dropdown is "Auto"
    const defaultValue = await page.locator('#input-scan-pick').inputValue();
    check('dropdown defaults to __auto__', defaultValue === '__auto__', `got "${defaultValue}"`);

    // 2. At startup the auto-pick falls back to National (WorldAtlas if available)
    const coldIndicator = await page.locator('#source-indicator').textContent();
    check('startup indicator shows an auto-picked source',
        /Auto/i.test(coldIndicator) && /(WorldAtlas|VIIRS|National)/i.test(coldIndicator),
        coldIndicator.trim());

    // 3. Advanced details is collapsed by default
    const advancedOpen = await page.locator('.advanced-panel').evaluate(el => el.hasAttribute('open'));
    check('Advanced panel collapsed by default', !advancedOpen);

    await page.screenshot({ path: path.join(SHOTS, 'auto-01-initial.png'), fullPage: false });

    // 4. Enter Great Basin → indicator switches to WorldAtlas auto
    const fetchPromise = page.waitForResponse(r => /scan_.*\.json/.test(r.url()) && r.status() === 200, { timeout: 30000 });
    await page.fill('#input-location', '38.93, -114.30');
    await page.evaluate(() => document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true })));
    const resp = await fetchPromise;
    console.log('autoSelectScan picked:', resp.url().split('/').pop());
    await page.waitForTimeout(3000); // wait for JSON parse

    const autoIndicator = await page.locator('#source-indicator').textContent();
    check('auto picks WorldAtlas for Great Basin', /worldatlas/i.test(autoIndicator), autoIndicator.trim());

    // 5. Search runs and produces Bortle 1 results
    await page.evaluate(() => {
        const r = document.querySelector('#input-radius');
        r.value = '60';
        r.dispatchEvent(new Event('input', { bubbles: true }));
        const s = document.querySelector('#input-sqm');
        s.value = '21.5';
        s.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#opt-weather').checked = false;
        document.querySelector('#opt-driving').checked = false;
    });

    await page.click('#btn-search');
    const resultsVisible = await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 240000 })
        .then(() => true).catch(() => false);
    check('search produces results panel', resultsVisible);

    if (resultsVisible) {
        await page.waitForTimeout(1500);
        const badges = await page.locator('.bortle-badge').allTextContents();
        const hasB1 = badges.slice(1, 10).some(b => /Bortle 1\b/.test(b));
        check('Bortle 1 results around Great Basin', hasB1, `first cards: ${badges.slice(1, 5).join(', ')}`);
        await page.screenshot({ path: path.join(SHOTS, 'auto-02-results.png'), fullPage: false });
    }

    // 6. Manual pick changes the indicator
    await page.locator('#btn-back').click();
    await page.waitForTimeout(300);

    // Pick the focused San Jose 200km scan
    const sjOption = await page.locator('#input-scan-pick option').filter({ hasText: /37.37/ }).first();
    const sjFile = await sjOption.getAttribute('value');
    const sjFetch = page.waitForResponse(r => r.url().endsWith(sjFile), { timeout: 30000 });
    await page.selectOption('#input-scan-pick', sjFile);
    await sjFetch;
    await page.waitForTimeout(1500);

    const manualIndicator = await page.locator('#source-indicator').textContent();
    check('manual pick switches indicator', /manual/i.test(manualIndicator), manualIndicator.trim());

    // 7. Back to Auto re-picks WorldAtlas
    const autoBackFetch = page.waitForResponse(r => /worldatlas/.test(r.url()), { timeout: 30000 });
    await page.selectOption('#input-scan-pick', '__auto__');
    await autoBackFetch;
    await page.waitForTimeout(1500);

    const reAutoIndicator = await page.locator('#source-indicator').textContent();
    check('switching back to Auto restores WorldAtlas', /worldatlas/i.test(reAutoIndicator), reAutoIndicator.trim());

    // 8. Live toggle changes indicator (no actual scan fired)
    await page.locator('.advanced-panel summary').click();
    await page.evaluate(() => {
        const c = document.querySelector('#opt-live-scan');
        c.checked = true;
        c.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    const liveIndicator = await page.locator('#source-indicator').textContent();
    check('Live toggle switches indicator', /Live/i.test(liveIndicator), liveIndicator.trim());
    await page.screenshot({ path: path.join(SHOTS, 'auto-03-advanced.png'), fullPage: false });

    console.log('\nPAGE ERRORS:', errs.length);
    errs.forEach(e => console.log(' ·', e));

    const failed = checks.filter(c => !c.pass);
    console.log(`\n${checks.length - failed.length}/${checks.length} passed`);

    await browser.close();
    process.exit(failed.length || errs.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
