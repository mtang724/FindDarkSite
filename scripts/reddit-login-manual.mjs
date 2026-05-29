/**
 * Manual / human-driven Reddit login using REAL Chrome (channel: 'chrome') and
 * a persistent user-data-dir, both to defeat Reddit's JS-challenge anti-bot
 * (which trips on stock Playwright Chromium).
 *
 *   node scripts/reddit-login-manual.mjs
 *
 * On first run a Chrome window opens with reddit.com/login — sign in by hand;
 * handle any CAPTCHA / 2FA. The script saves both the persistent profile
 * (scripts/.cache/chrome-profile/) and a storageState snapshot
 * (scripts/.cache/reddit-session.json) for downstream scrapers.
 *
 * Up to 15 minutes are allowed for the user to complete login.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '.cache');
const USER_DATA_DIR = path.join(CACHE_DIR, 'chrome-profile');
const OUT = path.join(CACHE_DIR, 'reddit-session.json');

const LOGIN_URL = 'https://www.reddit.com/login/';
const LOGIN_WAIT_MS = 15 * 60 * 1000;

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(USER_DATA_DIR, { recursive: true });

  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null, // let real Chrome use its window size
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    args: ['--start-maximized'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  console.log('Opening login page in REAL Chrome; please sign in manually …');
  console.log('(if the window opened behind other apps, click into it; handle any CAPTCHA / 2FA)');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Heartbeat
  let lastUrl = page.url();
  console.log(`[t=0s] at ${lastUrl}`);
  const start = Date.now();
  const hb = setInterval(() => {
    const u = page.url();
    const sec = Math.floor((Date.now() - start) / 1000);
    if (u !== lastUrl) { console.log(`[t=${sec}s] navigated → ${u}`); lastUrl = u; }
    else if (sec % 30 === 0) { console.log(`[t=${sec}s] still at ${u}`); }
  }, 5000);

  // Wait until URL leaves /login.
  try {
    await page.waitForFunction(() => {
      const u = new URL(location.href);
      return /reddit\.com$/.test(u.hostname) && !u.pathname.startsWith('/login');
    }, { timeout: LOGIN_WAIT_MS, polling: 1500 });
  } catch {
    clearInterval(hb);
    console.error(`Timed out (${LOGIN_WAIT_MS / 60000} min). Last URL: ${page.url()}`);
    await ctx.close();
    process.exit(1);
  }
  clearInterval(hb);

  await page.waitForTimeout(2500);
  const cookies = await ctx.cookies();
  const authy = cookies.find(c => /^(reddit_session|session_tracker|token_v2_access_token|loid)$/i.test(c.name));
  if (!authy) {
    console.error('Logged-in cookies not found. Aborting.');
    await ctx.close();
    process.exit(1);
  }
  console.log(`✓ Detected logged-in session (cookie "${authy.name}").`);

  await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3500);

  await ctx.storageState({ path: OUT });
  console.log(`Saved session → ${OUT}`);
  console.log(`Persistent Chrome profile → ${USER_DATA_DIR}`);
  await ctx.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
