/**
 * Verify the simplified UI + new scoring:
 *   - Only Location / Radius / Max Results are visible in the main panel
 *   - SQM slider, elevation, horizon filter, settlement filter, enrich
 *     toggles, data source picker all live inside Advanced
 *   - A bare-default search (no Advanced touched) still produces results
 *   - New scoring reasons (IDA, Reddit, horizon, GLOBE) appear when applicable
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
const PORT = 5188;

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
        await page.waitForTimeout(2500);

        // 1. Advanced section is collapsed by default
        const advancedOpen = await page.locator('.advanced-panel').evaluate(el => el.hasAttribute('open'));
        check('Advanced panel collapsed by default', !advancedOpen);

        // 2. SQM/elev/horizon/settlement/scan-pick are NOT visible when collapsed
        const inAdvanced = ['#input-sqm', '#input-min-elev', '#input-max-horizon', '#input-min-settlement', '#input-scan-pick'];
        for (const sel of inAdvanced) {
            const visible = await page.locator(sel).isVisible().catch(() => false);
            check(`${sel} hidden until Advanced expanded`, !visible);
        }

        // 3. Only the basic controls are visible
        for (const sel of ['#input-location', '#input-radius', '#input-max-results', '#btn-search']) {
            const visible = await page.locator(sel).isVisible().catch(() => false);
            check(`${sel} visible by default`, visible);
        }

        await page.screenshot({ path: path.join(SHOTS, 'simple-default-panel.png'), fullPage: false });

        // 4. Bare-default search still runs (location + click search, nothing else)
        await page.fill('#input-location', 'San Francisco, CA');
        await page.evaluate(() => document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true })));
        await page.waitForFunction(() => /WorldAtlas|VIIRS/.test(document.querySelector('#source-indicator')?.textContent || ''), null, { timeout: 30000 });
        await page.waitForTimeout(2500);
        await page.click('#btn-search');
        await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 240000 });
        await page.waitForTimeout(2500);
        const cards = await page.locator('.result-card').count();
        check('bare-default search produces cards', cards > 0, `${cards} cards`);

        // 5. Switch to Best Nights and check that the new scoring reasons show
        const toggleExists = await page.locator('.view-toggle-btn[data-view="nights"]').count();
        if (toggleExists) {
            await page.click('.view-toggle-btn[data-view="nights"]');
            await page.waitForTimeout(800);
            const reasonText = await page.locator('.night-reason').allTextContents();
            const allText = reasonText.join(' | ');
            check('Best Nights view produces ranked rows', reasonText.length > 5, `${reasonText.length} reasons`);
            const hasNewKind =
                /IDA|🌌|inside|km from/i.test(allText) ||
                /horizon/i.test(allText) ||
                /r\//i.test(allText) ||
                /GLOBE|measured/i.test(allText);
            check('at least one new scoring reason (IDA / horizon / Reddit / GLOBE) surfaces',
                hasNewKind, allText.slice(0, 200) + (allText.length > 200 ? '…' : ''));
            await page.screenshot({ path: path.join(SHOTS, 'simple-best-nights.png'), fullPage: false });
        } else {
            console.log('   (no Best Nights toggle — no forecast data this run)');
        }

        // 6. Back to search → expand Advanced → moved controls show
        await page.click('#btn-back');
        await page.waitForTimeout(500);
        await page.locator('.advanced-panel summary').click();
        await page.waitForTimeout(400);
        const sqmVisibleNow = await page.locator('#input-sqm').isVisible();
        check('SQM slider visible after expanding Advanced', sqmVisibleNow);
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
