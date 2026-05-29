/**
 * Indirect approach: scrape Bing & DuckDuckGo for site:reddit.com results.
 * Reddit blocks itself but search engines have it indexed with usable snippets.
 */
import { chromium } from 'playwright';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15';
const TARGETS = [
    { city: 'Austin',  sub: 'Austin' },
    { city: 'Atlanta', sub: 'Atlanta' },
    { city: 'Houston', sub: 'houston' },
    { city: 'Denver',  sub: 'Denver' },
];

async function probeBing(page, city) {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(`stargazing ${city} site:reddit.com`)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);
    return await page.evaluate(() => {
        const out = [];
        for (const li of document.querySelectorAll('li.b_algo, .b_algo')) {
            const a = li.querySelector('h2 a, a.tilk');
            const snippet = li.querySelector('.b_caption p, .b_paractl');
            const url = a?.href || '';
            const title = (a?.innerText || '').trim();
            const text = (snippet?.innerText || '').trim();
            if (url.includes('reddit.com') && title) {
                out.push({ url: url.slice(0, 120), title: title.slice(0, 100), snippet: text.slice(0, 250) });
            }
        }
        return out.slice(0, 8);
    });
}

async function probeDDG(page, city) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`stargazing ${city} site:reddit.com`)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);
    return await page.evaluate(() => {
        const out = [];
        for (const r of document.querySelectorAll('.result, .web-result, .result__body')) {
            const a = r.querySelector('a.result__a, a.result__url, h2 a');
            const snippet = r.querySelector('.result__snippet, .snippet');
            let url = a?.href || '';
            // DDG wraps URLs in /l/?uddg= encoding
            const m = /uddg=([^&]+)/.exec(url);
            if (m) url = decodeURIComponent(m[1]);
            const title = (a?.innerText || '').trim();
            const text = (snippet?.innerText || '').trim();
            if (url.includes('reddit.com') && title) {
                out.push({ url: url.slice(0, 120), title: title.slice(0, 100), snippet: text.slice(0, 250) });
            }
        }
        return out.slice(0, 8);
    });
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();

    console.log('=== Bing site:reddit.com ===');
    for (const t of TARGETS) {
        const r = await probeBing(page, t.city);
        console.log(`\n  ${t.city}: ${r.length} hits`);
        r.slice(0, 5).forEach(h => {
            console.log(`    · ${h.title}`);
            console.log(`      ${h.url}`);
            if (h.snippet) console.log(`      "${h.snippet.slice(0, 180)}..."`);
        });
        await page.waitForTimeout(3000);
    }

    console.log('\n=== DuckDuckGo site:reddit.com ===');
    await ctx.clearCookies();
    for (const t of TARGETS) {
        const r = await probeDDG(page, t.city);
        console.log(`\n  ${t.city}: ${r.length} hits`);
        r.slice(0, 5).forEach(h => {
            console.log(`    · ${h.title}`);
            console.log(`      ${h.url}`);
            if (h.snippet) console.log(`      "${h.snippet.slice(0, 180)}..."`);
        });
        await page.waitForTimeout(3000);
    }

    await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
