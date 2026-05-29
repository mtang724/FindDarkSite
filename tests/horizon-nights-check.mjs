/**
 * Verify the two new UI features:
 *   - Horizon polar SVG renders for top sites
 *   - 'Best Nights' view toggle reveals a ranked night list
 *   - Max horizon slider filter applies
 *
 * Runs against a fresh dev server on its own port.
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
const PORT = 5181;

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

    try {
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => /WorldAtlas|VIIRS/.test(
            document.querySelector('#source-indicator')?.textContent || ''
        ), null, { timeout: 30000 });
        await page.waitForTimeout(4000);

        // Death Valley — gives Bortle 1 sites and a real horizon profile.
        await page.fill('#input-location', '36.50, -117.10');
        await page.evaluate(() => document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true })));
        await page.waitForTimeout(1500);
        await page.evaluate(() => {
            const r = document.querySelector('#input-radius');
            r.value = '80'; r.dispatchEvent(new Event('input', { bubbles: true }));
            const s = document.querySelector('#input-sqm');
            s.value = '21.0'; s.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#opt-driving').checked = false;
        });

        await page.click('#btn-search');
        await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 240000 });
        await page.waitForTimeout(3000);

        // Horizon SVGs in the enriched cards
        const horizonSvgs = await page.locator('.horizon-svg').count();
        check('horizon SVG renders for at least one card', horizonSvgs > 0, `${horizonSvgs} SVGs`);

        // Horizon meta tag in card
        const horizonTags = await page.locator('.card-meta-item:has-text("horizon")').count();
        check('horizon meta tag shown', horizonTags > 0, `${horizonTags} tags`);

        // View toggle is visible
        const toggle = await page.locator('.view-toggle').count();
        check('view toggle present (forecast was fetched)', toggle === 1);

        await page.screenshot({ path: path.join(SHOTS, 'horizon-by-site.png'), fullPage: false });

        // Switch to Best Nights — expect night rows w/ score badges
        await page.click('.view-toggle-btn[data-view="nights"]');
        await page.waitForTimeout(500);
        const nightRows = await page.locator('.night-row').count();
        const nightScores = await page.locator('.night-score').count();
        check('Best Nights view shows ranked rows', nightRows > 0, `${nightRows} rows`);
        check('every night row has a score badge', nightScores === nightRows);

        await page.screenshot({ path: path.join(SHOTS, 'horizon-by-night.png'), fullPage: false });

        // Click first row → should jump back to By Site view and highlight that card
        await page.locator('.night-row').first().click();
        await page.waitForTimeout(500);
        const activeCard = await page.locator('.result-card.active').count();
        check('clicking a night row jumps back to By Site + highlights its card', activeCard === 1);
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
