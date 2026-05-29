/**
 * Verify the visual-hierarchy redesign:
 *   - Collapsed cards by default (only top 1–2 expanded)
 *   - Each card has exactly one .card-headline with a tone class
 *   - Reddit panel is NOT injected above the cards anymore
 *   - The third "Locals" tab appears in the view toggle when Reddit data exists
 *   - Clicking ▾ More on a collapsed card expands it
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const PORT = process.env.PORT || 5190;

const checks = [];
function check(name, pass, detail = '') {
    checks.push({ name, pass, detail });
    console.log(pass ? '✅' : '❌', name, detail ? `— ${detail}` : '');
}

async function main() {
    await mkdir(SHOTS, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1480, height: 1100 }, deviceScaleFactor: 2 });
    page.on('dialog', d => d.dismiss().catch(() => {}));

    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => /WorldAtlas|VIIRS/.test(
        document.querySelector('#source-indicator')?.textContent || ''
    ), null, { timeout: 30000 });
    await page.waitForTimeout(2500);

    // San Francisco — has Reddit data + many cards
    await page.fill('#input-location', 'San Francisco, CA');
    await page.evaluate(() => document.querySelector('#input-location').dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForTimeout(1500);
    await page.click('#btn-search');
    await page.locator('#results-panel').waitFor({ state: 'visible', timeout: 240000 });
    await page.waitForTimeout(3500);

    // 1. Reddit section is NOT pinned above the cards
    const aboveReddit = await page.locator('#results-list > .reddit-section').count();
    check('no Reddit section pinned above the cards', aboveReddit === 0);

    // 2. The view toggle now has 3 tabs (sites/nights/reddit) — Locals appears
    const tabLabels = await page.locator('.view-toggle-btn').allTextContents();
    check('view toggle has 3 tabs', tabLabels.length === 3, tabLabels.join(' | '));
    const hasLocals = tabLabels.some(t => /Locals/i.test(t));
    check('Locals tab present', hasLocals);

    // 3. Each visible card has one card-headline with a tone class
    const cards = await page.locator('.result-card').count();
    const headlines = await page.locator('.result-card .card-headline').count();
    check('card count == headline count', cards === headlines, `${cards} cards, ${headlines} headlines`);
    const sampleTones = await page.locator('.result-card .card-headline').evaluateAll(els =>
        els.slice(0, 5).map(el => Array.from(el.classList).find(c => c.startsWith('tone-')))
    );
    check('every sampled headline has a tone class', sampleTones.every(t => !!t), sampleTones.join(','));

    // 4. Most cards are collapsed; only the top 1–2 expanded
    const expanded = await page.locator('.result-card.expanded').count();
    const collapsed = await page.locator('.result-card.collapsed').count();
    check('most cards collapsed by default', collapsed >= expanded, `${expanded} expanded, ${collapsed} collapsed`);
    check('between 1 and 2 cards auto-expanded', expanded >= 1 && expanded <= 2, `${expanded} expanded`);

    await page.screenshot({ path: path.join(SHOTS, 'hierarchy-01-cold-results.png'), fullPage: false });

    // 5. Click a More button on a collapsed card → it expands
    const firstCollapsed = page.locator('.result-card.collapsed').first();
    if (await firstCollapsed.count()) {
        const idx = await firstCollapsed.getAttribute('data-index');
        await firstCollapsed.locator('.btn-expand').click();
        await page.waitForTimeout(300);
        const stillCollapsed = await page.locator(`.result-card[data-index="${idx}"].collapsed`).count();
        const nowExpanded   = await page.locator(`.result-card[data-index="${idx}"].expanded`).count();
        check('clicking ▾ More expands the card', stillCollapsed === 0 && nowExpanded === 1);
    }

    // 6. Switch to Locals tab → the panel renders inside the body, no card list
    const localsBtn = page.locator('.view-toggle-btn').filter({ hasText: /Locals/ }).first();
    if (await localsBtn.count()) {
        await localsBtn.click();
        await page.waitForTimeout(500);
        const inBody = await page.locator('#results-list .reddit-section').count();
        const cardCount = await page.locator('.result-card').count();
        check('Locals tab body shows the Reddit panel', inBody === 1);
        check('Locals tab hides the result cards', cardCount === 0);
        await page.screenshot({ path: path.join(SHOTS, 'hierarchy-02-locals-tab.png'), fullPage: false });
    }

    // 7. Switch back to By Site
    await page.locator('.view-toggle-btn').filter({ hasText: /By Site/ }).first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'hierarchy-03-back-to-sites.png'), fullPage: false });

    console.log('\nPage errors:', errs.length);
    errs.slice(0, 5).forEach(e => console.log(' ·', e));
    const failed = checks.filter(c => !c.pass);
    console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
    await browser.close();
    process.exit(failed.length || errs.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
