/**
 * FindDarkSite — Playwright smoke test
 *
 * Boots the Vite dev server, drives the app in real Chromium, and reports
 * what passed / what surfaced. Screenshots land in tests/screenshots/.
 *
 * Run:  node tests/smoke.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(__dirname);
const SHOTS = path.join(__dirname, 'screenshots');
const PORT = 5174; // distinct port so we don't clash with a dev server the user has open

const log = (...a) => console.log('[smoke]', ...a);

async function startDevServer() {
    log('starting Vite on', PORT);
    const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    proc.stdout.on('data', (chunk) => {
        const s = chunk.toString();
        if (s.includes('ready in') || s.includes('Local:')) ready = true;
    });
    proc.stderr.on('data', (chunk) => process.stderr.write('[vite] ' + chunk));

    // Wait up to 15s for "ready"
    const start = Date.now();
    while (!ready && Date.now() - start < 15000) await sleep(200);
    if (!ready) throw new Error('Vite did not become ready');

    log('Vite ready');
    return proc;
}

async function shot(page, name) {
    await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

const checks = [];
function check(name, pass, detail = '') {
    checks.push({ name, pass, detail });
    log(pass ? '✅' : '❌', name, detail ? `— ${detail}` : '');
}

async function main() {
    await mkdir(SHOTS, { recursive: true });
    const vite = await startDevServer();

    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    const badResponses = [];
    const ridbHits = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('response', async (resp) => {
        if (resp.url().includes('/api/ridb')) {
            let count = 0;
            try {
                const j = await resp.json();
                count = (j.RECDATA || []).length;
            } catch {}
            ridbHits.push({ status: resp.status(), count, url: resp.url() });
        }
        if (resp.status() >= 400) {
            let bodySample = '';
            try { bodySample = (await resp.text()).slice(0, 1500); } catch {}
            badResponses.push(`${resp.status()} ${resp.url()}\n---\n${bodySample}\n---`);
        }
    });

    try {
        // ── 1. Initial load ───────────────────────────────────────────────
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
        await shot(page, '01-initial');

        const title = await page.title();
        check('page title', /FindDarkSite/.test(title), `got "${title}"`);
        check('no page errors at load', pageErrors.length === 0, pageErrors.join('; '));

        // ── 2. Map present ────────────────────────────────────────────────
        const mapVisible = await page.locator('#map .leaflet-tile-loaded').first().isVisible({ timeout: 5000 }).catch(() => false);
        check('Leaflet map rendered', mapVisible);

        // ── 3. Dropdown populated from /data/index.json ───────────────────
        await page.waitForFunction(
            () => document.querySelectorAll('#input-scan-pick option').length > 1,
            null, { timeout: 5000 }
        ).catch(() => {});

        const optionTexts = await page.locator('#input-scan-pick option').allTextContents();
        check('scan picker populated', optionTexts.length >= 2,
            `${optionTexts.length} options: ${optionTexts.slice(1).join(' | ')}`);

        // Prefer a Furnace-Creek-area scan if present (RIDB has campgrounds there);
        // fall back to any scan containing -117 (NW Death Valley).
        const fcIdx = optionTexts.findIndex(t => t.includes('-116.86') || t.includes('-116.87'));
        const dvIdx = optionTexts.findIndex(t => t.includes('-117'));
        const pickIdx = fcIdx >= 0 ? fcIdx : dvIdx;
        check('Death Valley region scan listed', pickIdx >= 0);

        // ── 4. Pick a scan + enter coords + search ────────────────────────
        if (pickIdx >= 0) {
            const filename = await page.locator('#input-scan-pick option').nth(pickIdx).getAttribute('value');
            await page.selectOption('#input-scan-pick', filename);
            log('selected scan:', filename);

            // Use the same center the scan was taken at
            const centerCoords = fcIdx >= 0 ? '36.4630, -116.8678' : '36.5054, -117.0794';
            await page.fill('#input-location', centerCoords);
            // Range sliders need a programmatic value + input event
            await page.evaluate(() => {
                const r = document.querySelector('#input-radius');
                r.value = '30'; // min — scan only covers 8km, but we want any seeds inside
                r.dispatchEvent(new Event('input', { bubbles: true }));
                const s = document.querySelector('#input-sqm');
                s.value = '20.0'; // accept Bortle 4+
                s.dispatchEvent(new Event('input', { bubbles: true }));
            });

            await shot(page, '02-pre-search');

            await page.click('#btn-search');
            log('search clicked, waiting for results panel...');

            // Wait for either results panel or a cancel/done state.
            // The button briefly says "Cancel Scan" while running.
            const resultsAppeared = await page.locator('#results-panel')
                .waitFor({ state: 'visible', timeout: 60000 })
                .then(() => true).catch(() => false);

            check('results panel appeared', resultsAppeared);

            if (resultsAppeared) {
                await shot(page, '03-results');
                const statsText = await page.locator('#results-stats').textContent();
                const cards = await page.locator('.result-card').count();
                check('result cards rendered', cards > 0, `${cards} cards, stats="${statsText.replace(/\s+/g, ' ').trim()}"`);

                // Verify at least one POI section exists (Overpass actually returned something)
                const poiBlocks = await page.locator('.card-pois').count();
                check('Overpass POIs in at least one card', poiBlocks > 0, `${poiBlocks} cards have POI listings`);

                // Verify map markers appeared
                const mapMarkers = await page.locator('#map .leaflet-interactive').count();
                check('map markers rendered', mapMarkers > 0, `${mapMarkers} markers/shapes`);

                // RIDB checks — only if we picked the Furnace Creek scan
                if (fcIdx >= 0) {
                    const ridbCalled = ridbHits.length > 0;
                    check('RIDB endpoint was called', ridbCalled, `${ridbHits.length} hits`);

                    const ridbAnyData = ridbHits.some(h => h.status === 200 && h.count > 0);
                    check('RIDB returned campground data', ridbAnyData,
                        ridbHits.map(h => `[${h.status} count=${h.count}]`).join(' '));

                    // Look for a Recreation.gov POI name in the rendered cards
                    const cardHtml = await page.locator('#results-list').innerHTML();
                    const hasFurnaceCreek = /Furnace Creek/i.test(cardHtml);
                    check('Furnace Creek Campground shown in cards', hasFurnaceCreek);
                }
            }
        }

        // ── 5. Final console-error tally ──────────────────────────────────
        check('no console errors during run', consoleErrors.length === 0,
            consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '');

        await shot(page, '99-final');
    } catch (err) {
        log('FATAL', err.message);
        await shot(page, 'fatal').catch(() => {});
        check('test harness ran cleanly', false, err.message);
    } finally {
        await browser.close().catch(() => {});
        vite.kill('SIGTERM');
        await sleep(500);
    }

    // ── Report ────────────────────────────────────────────────────────────
    const failed = checks.filter(c => !c.pass);
    console.log('\n=== SUMMARY ===');
    console.log(`${checks.length - failed.length}/${checks.length} passed`);
    if (failed.length) {
        console.log('\nFailures:');
        for (const f of failed) console.log(' ✗', f.name, f.detail ? `— ${f.detail}` : '');
    }
    if (consoleErrors.length) {
        console.log('\nConsole errors:');
        for (const e of consoleErrors.slice(0, 10)) console.log(' ·', e);
    }
    if (pageErrors.length) {
        console.log('\nPage errors:');
        for (const e of pageErrors.slice(0, 10)) console.log(' ·', e);
    }
    if (badResponses.length) {
        console.log('\nHTTP errors:');
        for (const e of badResponses.slice(0, 10)) console.log(' ·', e);
    }

    process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});
