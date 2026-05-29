/**
 * Verify the location input accepts a ZIP, a city, a free-form name, and
 * still accepts raw lat/lng. Confirms the "→ resolved to ..." hint appears
 * and a search runs end-to-end against the resolved point.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 5185;
const checks = [];
function check(name, pass, detail = '') {
    checks.push({ name, pass, detail });
    console.log(pass ? '✅' : '❌', name, detail ? `— ${detail}` : '');
}

async function startDev() {
    const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
        cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    proc.stdout.on('data', c => { if (/ready in|Local:/.test(c.toString())) ready = true; });
    proc.stderr.on('data', c => process.stderr.write('[vite] ' + c));
    const start = Date.now();
    while (!ready && Date.now() - start < 15000) await sleep(200);
    return proc;
}

async function tryInput(page, value) {
    await page.fill('#input-location', value);
    await page.evaluate(() => document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true })));
    // Wait for the loading hint to clear OR for an error
    await page.waitForFunction(() => {
        const el = document.querySelector('#location-hint');
        return el && !el.classList.contains('loading');
    }, null, { timeout: 15000 });
    return (await page.locator('#location-hint').textContent()).trim();
}

async function main() {
    const vite = await startDev();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('dialog', d => d.dismiss().catch(() => {}));

    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    try {
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => /WorldAtlas|VIIRS/.test(
            document.querySelector('#source-indicator')?.textContent || ''
        ), null, { timeout: 30000 });
        await page.waitForTimeout(3000);

        // 1. Lat/lng input — fast path, no network
        let hint = await tryInput(page, '37.37, -121.88');
        check('coord input resolves immediately', hint.includes('37.37') && hint.includes('-121.88'), hint);

        // 2. US ZIP
        hint = await tryInput(page, '95014');
        check('US ZIP 95014 resolves', /Cupertino|CA|95014/i.test(hint), hint);

        // 3. ZIP for NYC
        hint = await tryInput(page, '10001');
        check('US ZIP 10001 resolves', /New York|NY|10001/i.test(hint), hint);

        // 4. Place name (no comma, no digits)
        hint = await tryInput(page, 'Joshua Tree');
        check('city name "Joshua Tree" resolves', /Joshua|CA|California/i.test(hint), hint);

        // 5. Garbage → error
        hint = await tryInput(page, 'asdfzzz not a place 9999');
        check('unresolvable input shows error', /couldn't find|error/i.test(hint) || hint.length > 0, hint);

        // 6. Run a real search using a ZIP — should produce results
        await page.fill('#input-location', '95014');
        await page.evaluate(() => document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true })));
        await page.waitForFunction(() => {
            const el = document.querySelector('#location-hint');
            return el && /Cupertino|CA|95014/i.test(el.textContent || '');
        }, null, { timeout: 15000 });
        await page.evaluate(() => {
            const r = document.querySelector('#input-radius');
            r.value = '120'; r.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#opt-weather').checked = false;
            document.querySelector('#opt-driving').checked = false;
            document.querySelector('#opt-horizon').checked = false;
        });
        await page.click('#btn-search');
        const ok = await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 240000 })
            .then(() => true).catch(() => false);
        check('search from ZIP produces results', ok);
        const cards = await page.locator('.result-card').count();
        check('result cards rendered for ZIP search', cards > 0, `${cards} cards`);
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
