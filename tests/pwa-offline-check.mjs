/**
 * Verify the PWA: registers a service worker, precaches the app shell,
 * and reloads cleanly after the browser context goes offline.
 * Runs against `npm run preview` (production bundle with SW emitted).
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
const PORT = 5180;

const checks = [];
function check(name, pass, detail = '') {
    checks.push({ name, pass, detail });
    console.log(pass ? '✅' : '❌', name, detail ? `— ${detail}` : '');
}

async function startPreview() {
    const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    proc.stdout.on('data', c => { if (/Local:|http:\/\/localhost/.test(c.toString())) ready = true; });
    proc.stderr.on('data', c => process.stderr.write('[preview] ' + c));
    const start = Date.now();
    while (!ready && Date.now() - start < 15000) await sleep(200);
    if (!ready) throw new Error('preview server did not become ready');
    return proc;
}

async function main() {
    await mkdir(SHOTS, { recursive: true });
    const preview = await startPreview();

    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    page.on('dialog', d => d.dismiss().catch(() => {}));

    try {
        // 1. Load page, wait for SW registration
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
        const swActive = await page.evaluate(async () => {
            const reg = await navigator.serviceWorker?.ready;
            return !!reg?.active;
        });
        check('service worker registered and active', swActive);

        // 2. Manifest available
        const manifestResp = await page.goto(`http://localhost:${PORT}/manifest.webmanifest`);
        check('manifest.webmanifest served', manifestResp.status() === 200, `status ${manifestResp.status()}`);
        const manifest = await manifestResp.json();
        check('manifest has all required fields',
            !!(manifest.name && manifest.short_name && manifest.icons?.length >= 2 && manifest.theme_color),
            `name="${manifest.short_name}" icons=${manifest.icons?.length}`);

        // 3. Icons resolve
        const iconResp = await page.goto(`http://localhost:${PORT}/icons/icon-192.png`);
        check('icon-192.png served', iconResp.status() === 200);

        // 4. Reload the app, then go offline + reload again — app shell should still load
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
        // Make sure the SW has actually claimed this page before we cut the network
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.waitForTimeout(800);

        await ctx.setOffline(true);
        await page.reload({ waitUntil: 'load' });
        const shellOk = await page.locator('#app').isVisible({ timeout: 5000 }).catch(() => false);
        check('app shell loads while offline', shellOk);

        const offlineChip = await page.locator('#offline-chip').isVisible().catch(() => false);
        check('offline chip is shown when offline', offlineChip);

        await page.screenshot({ path: path.join(SHOTS, 'pwa-offline.png'), fullPage: false });

        await ctx.setOffline(false);
    } finally {
        await browser.close().catch(() => {});
        preview.kill('SIGTERM');
        await sleep(500);
    }

    const failed = checks.filter(c => !c.pass);
    console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
