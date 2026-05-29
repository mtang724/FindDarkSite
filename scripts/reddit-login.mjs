/**
 * One-time Reddit login. Opens a headful Chromium, signs in with credentials
 * from REDDIT_USERNAME / REDDIT_PASSWORD env vars (source reddit.local first),
 * and persists the full storage state (cookies + localStorage) to
 *   scripts/.cache/reddit-session.json
 *
 * Subsequent scraper runs load that storage state and get an authenticated
 * session, which Reddit's anti-bot treats much more leniently.
 *
 * Usage:
 *   set -a; . ./reddit.local; set +a
 *   node scripts/reddit-login.mjs
 *
 * Re-run only when the session cookie expires (~30 days) or after a 2FA prompt.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '.cache');
const OUT      = path.join(CACHE_DIR, 'reddit-session.json');

const USER = process.env.REDDIT_USERNAME;
const PASS = process.env.REDDIT_PASSWORD;

if (!USER || !PASS) {
    console.error('Need REDDIT_USERNAME + REDDIT_PASSWORD env vars (source reddit.local).');
    process.exit(1);
}

async function main() {
    await mkdir(CACHE_DIR, { recursive: true });
    const browser = await chromium.launch({ headless: false, slowMo: 80 });
    const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
    });
    const page = await ctx.newPage();

    // Old reddit login is simpler + less JS-driven; bypasses many of the new
    // login flow's anti-bot hooks. The session cookie is shared with the
    // new layout — once logged in here, www.reddit.com sees us as signed-in.
    console.log('Navigating to https://old.reddit.com/login …');
    await page.goto('https://old.reddit.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);

    // Old layout uses #user_login + #passwd_login + #login-button on a form
    // with id="login-form". (There are sometimes two login forms on the page.)
    const userField = await page.$('#login-form #user_login, form.login-form #user_login, input#user_login');
    const passField = await page.$('#login-form #passwd_login, form.login-form #passwd_login, input#passwd_login');
    if (!userField || !passField) {
        console.error('Could not find login fields on old.reddit.com/login.');
        console.error('Reddit may have changed the layout, or the page failed to render.');
        await browser.close();
        process.exit(1);
    }

    await userField.click({ delay: 50 });
    await userField.type(USER, { delay: 60 });
    await page.waitForTimeout(500);
    await passField.click({ delay: 50 });
    await passField.type(PASS, { delay: 60 });
    await page.waitForTimeout(800);

    console.log('Submitting login …');
    await page.click('#login-form .btn, form.login-form .btn, button[type="submit"]').catch(() => {});
    // The successful login redirects to old.reddit.com homepage with the
    // logged-in chrome (a topbar showing the username). Wait for either that
    // or an error banner.
    try {
        await Promise.race([
            page.waitForSelector(`a.user[href*="/user/${USER}"], a.user[href*="${USER}"]`, { timeout: 30000 }),
            page.waitForSelector('.error', { timeout: 30000 }),
        ]);
    } catch {}

    await page.waitForTimeout(2500);

    // Verify
    const loggedIn = await page.evaluate(() => {
        const u = document.querySelector('span.user a.user, a.user');
        return u ? u.textContent.trim() : null;
    });
    if (!loggedIn) {
        const err = await page.evaluate(() => document.querySelector('.error')?.textContent || 'unknown');
        console.error(`Login failed: ${err.slice(0, 200)}`);
        await browser.close();
        process.exit(1);
    }
    console.log(`✓ Logged in as ${loggedIn}`);

    // Take a couple of warm-up actions so the session looks real, then save.
    await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    await ctx.storageState({ path: OUT });
    console.log(`Saved session → ${OUT}`);

    await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
