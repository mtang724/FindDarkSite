/**
 * Probe 3 approaches against 3 Reddit-blocked metros (Austin, Atlanta, Houston):
 *   A. old.reddit.com search.json via Playwright (cookies + real browser)
 *   B. www.reddit.com search.json via Playwright
 *   C. Slow paced HTML browsing — visit homepage, then subreddit, then search
 *
 * Pick winner by # posts returned.
 */
import { chromium } from 'playwright';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15';
const TARGETS = [
    { city: 'Austin',  sub: 'Austin' },
    { city: 'Atlanta', sub: 'Atlanta' },
    { city: 'Houston', sub: 'houston' },
];

async function approachA_oldJson(page, sub) {
    const url = `https://old.reddit.com/r/${sub}/search.json?q=stargazing&restrict_sr=1&t=year&sort=top&limit=20`;
    try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (resp.status() !== 200) return { count: 0, error: `HTTP ${resp.status()}` };
        const body = await page.evaluate(() => document.body.innerText);
        try {
            const json = JSON.parse(body);
            const children = json?.data?.children || [];
            return { count: children.length, sample: children.slice(0, 3).map(c => c.data?.title || '?') };
        } catch (e) {
            return { count: 0, error: 'body not JSON', sample: body.slice(0, 200) };
        }
    } catch (e) {
        return { count: 0, error: e.message };
    }
}

async function approachB_wwwJson(page, sub) {
    const url = `https://www.reddit.com/r/${sub}/search.json?q=stargazing&restrict_sr=1&t=year&sort=top&limit=20`;
    try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (resp.status() !== 200) return { count: 0, error: `HTTP ${resp.status()}` };
        const body = await page.evaluate(() => document.body.innerText);
        try {
            const json = JSON.parse(body);
            const children = json?.data?.children || [];
            return { count: children.length, sample: children.slice(0, 3).map(c => c.data?.title || '?') };
        } catch {
            return { count: 0, error: 'body not JSON', sample: body.slice(0, 200) };
        }
    } catch (e) {
        return { count: 0, error: e.message };
    }
}

async function approachC_slowHtml(page, sub) {
    try {
        // Visit homepage first — let cookies land
        await page.goto('https://old.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3500);
        // Visit the subreddit
        await page.goto(`https://old.reddit.com/r/${sub}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(4500);
        // Now the search
        const url = `https://old.reddit.com/r/${sub}/search?q=stargazing&restrict_sr=on&t=year&sort=top`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4500);
        const posts = await page.evaluate(sub => {
            const out = [];
            const seen = new Set();
            const sel = `a.search-title, a.search-link, div.search-result-link a.search-title, a[href*="/r/${sub}/comments/"]`;
            for (const a of document.querySelectorAll(sel)) {
                const href = a.getAttribute('href') || '';
                const m = /\/r\/[^/]+\/comments\/([a-z0-9]+)/i.exec(href);
                if (!m) continue;
                if (seen.has(m[1])) continue; seen.add(m[1]);
                const t = (a.innerText || a.textContent || '').trim();
                if (t.length < 8) continue;
                out.push({ id: m[1], title: t.slice(0, 80) });
            }
            return out;
        }, sub);
        return { count: posts.length, sample: posts.slice(0, 3).map(p => p.title) };
    } catch (e) {
        return { count: 0, error: e.message };
    }
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();

    console.log('=== Approach A: old.reddit.com/.../search.json ===');
    for (const t of TARGETS) {
        const r = await approachA_oldJson(page, t.sub);
        console.log(`  r/${t.sub}: count=${r.count}${r.error ? ' err=' + r.error : ''}`);
        if (r.sample) r.sample.forEach(s => console.log(`    · ${s}`));
        await page.waitForTimeout(3000);
    }

    // Fresh context for B (don't let A's failures contaminate)
    await ctx.close();
    const ctx2 = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 900 } });
    const page2 = await ctx2.newPage();
    console.log('\n=== Approach B: www.reddit.com/.../search.json ===');
    for (const t of TARGETS) {
        const r = await approachB_wwwJson(page2, t.sub);
        console.log(`  r/${t.sub}: count=${r.count}${r.error ? ' err=' + r.error : ''}`);
        if (r.sample) r.sample.forEach(s => console.log(`    · ${s}`));
        await page2.waitForTimeout(3000);
    }

    await ctx2.close();
    const ctx3 = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 900 } });
    const page3 = await ctx3.newPage();
    console.log('\n=== Approach C: slow paced old.reddit HTML (homepage → sub → search) ===');
    for (const t of TARGETS) {
        const r = await approachC_slowHtml(page3, t.sub);
        console.log(`  r/${t.sub}: count=${r.count}${r.error ? ' err=' + r.error : ''}`);
        if (r.sample) r.sample.forEach(s => console.log(`    · ${s}`));
        await page3.waitForTimeout(4500);
    }

    await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
