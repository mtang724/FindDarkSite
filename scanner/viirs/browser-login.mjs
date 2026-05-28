/**
 * Log into EOG via the browser auth-code flow (Playwright), then:
 *   - list the 2023 annual dir to find the average_masked filename
 *   - save the authenticated session cookies to cache/eog-cookies.json
 * Reads EOG_USERNAME / EOG_PASSWORD from the environment.
 *
 * Usage: node scanner/viirs/browser-login.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');
const DIR_URL = 'https://eogdata.mines.edu/nighttime_light/annual/v22/2023/';

async function main() {
  const username = process.env.EOG_USERNAME;
  const password = process.env.EOG_PASSWORD;
  if (!username || !password) throw new Error('Set EOG_USERNAME / EOG_PASSWORD (source ./eog.local).');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Navigating (will redirect to login)...');
  await page.goto(DIR_URL, { waitUntil: 'domcontentloaded' });

  // Keycloak login form
  await page.waitForSelector('#username', { timeout: 30000 });
  console.log('Login page loaded, submitting credentials...');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await Promise.all([
    page.waitForURL('**eogdata.mines.edu/**', { timeout: 45000 }),
    page.click('#kc-login, input[type=submit], button[type=submit]'),
  ]);

  console.log('Back on:', page.url());
  const html = await page.content();
  const files = [...html.matchAll(/href="([^"]*average_masked[^"]*\.tif\.gz)"/g)].map(m => m[1]);
  console.log('average_masked files found:');
  for (const f of files) console.log('  ', f);

  const cookies = await context.cookies();
  writeFileSync(path.join(CACHE_DIR, 'eog-cookies.json'), JSON.stringify(cookies, null, 2));
  console.log(`Saved ${cookies.length} cookies to cache/eog-cookies.json`);

  await browser.close();
  if (files.length === 0) {
    console.error('No average_masked file found — dump first 500 chars of page for debugging:');
    console.error(html.slice(0, 500));
    process.exit(2);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
