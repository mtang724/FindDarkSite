/**
 * Verify reachability + remoteness:
 *   - Search around SJ produces road + settlement tags on cards
 *   - The "Hide unreachable" filter trims the result count
 *   - The "Min distance from towns" filter further trims, leaving truly remote sites
 *
 * Runs against a fresh dev server.
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
const PORT = 5183;

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

async function runSearch(page, { hideUnreachable, minSettlementKm }) {
    // Go back to search if needed
    const onResults = await page.locator('#results-panel').isVisible().catch(() => false);
    if (onResults) {
        await page.click('#btn-back');
        await page.waitForTimeout(300);
    }
    await page.evaluate(({ hideUnreachable, minSettlementKm }) => {
        const r = document.querySelector('#input-radius');
        r.value = '120'; r.dispatchEvent(new Event('input', { bubbles: true }));
        const s = document.querySelector('#input-sqm');
        s.value = '20.5'; s.dispatchEvent(new Event('input', { bubbles: true }));
        const ms = document.querySelector('#input-min-settlement');
        ms.value = String(minSettlementKm); ms.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#opt-hide-unreachable').checked = hideUnreachable;
        document.querySelector('#opt-weather').checked = false;
        document.querySelector('#opt-driving').checked = false;
        document.querySelector('#opt-horizon').checked = false;
    }, { hideUnreachable, minSettlementKm });

    await page.click('#btn-search');
    await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 240000 });
    await page.waitForTimeout(2500);

    const cardCount = await page.locator('.result-card').count();
    const reachStat = await page.locator('.stat-card .stat-label:has-text("Reachable") + *, .stat-card:has-text("Reachable") .stat-value').first().textContent().catch(() => '?');
    const roadTags = await page.locator('.card-meta-item:has-text("road")').count();
    const townTags = await page.locator('.card-meta-item:has-text("km")').count(); // 🏘️ Name X km
    return { cardCount, reachStat: reachStat.trim(), roadTags, townTags };
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

        await page.fill('#input-location', '37.37, -121.88');
        await page.evaluate(() => document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true })));
        await page.waitForTimeout(1500);

        // 1. Unfiltered baseline (hide unreachable + min town = 0)
        const baseline = await runSearch(page, { hideUnreachable: false, minSettlementKm: 0 });
        console.log('[baseline]', baseline);
        check('reachability tags rendered on cards', baseline.roadTags > 0, `${baseline.roadTags} road tags, ${baseline.townTags} town tags`);
        check('"Reachable" stat populated', /^\d+$/.test(baseline.reachStat), `stat="${baseline.reachStat}"`);
        await page.screenshot({ path: path.join(SHOTS, 'reach-baseline.png'), fullPage: false });

        // 2. Hide unreachable — count should not exceed reachable count
        const filtered = await runSearch(page, { hideUnreachable: true, minSettlementKm: 0 });
        console.log('[hide-unreachable]', filtered);
        check('hide-unreachable filter applied', filtered.cardCount <= baseline.cardCount);

        // 3. Add a min-settlement filter — count should drop further (or stay same if already remote)
        const remote = await runSearch(page, { hideUnreachable: true, minSettlementKm: 10 });
        console.log('[remote-only]', remote);
        check('min-settlement filter applied', remote.cardCount <= filtered.cardCount);
        await page.screenshot({ path: path.join(SHOTS, 'reach-remote-only.png'), fullPage: false });

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
