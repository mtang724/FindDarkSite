/**
 * Super-slow, human-like Playwright run on a single previously-blocked metro.
 * If this works, the strategy scales.
 *
 * Steps for each metro:
 *   1. Fresh browser context (no cookies from prior metros)
 *   2. Visit www.reddit.com homepage  → wait 6 sec → scroll a bit
 *   3. Visit r/Austin homepage         → wait 8 sec → scroll
 *   4. Visit r/Austin/search?q=stargazing → wait 8 sec
 *   5. Extract result titles
 */
import { chromium } from 'playwright';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const TARGETS = ['Austin', 'houston', 'Atlanta', 'Denver'];

async function humanWait(ms) {
    // Add 0-30% jitter so timing isn't perfectly periodic.
    const j = ms * (0.85 + Math.random() * 0.30);
    await new Promise(r => setTimeout(r, j));
}

async function probeMetro(browser, sub) {
    const ctx = await browser.newContext({
        userAgent: UA,
        viewport: { width: 1280 + Math.floor(Math.random() * 200), height: 800 + Math.floor(Math.random() * 100) },
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
        // Spoof a few props that anti-bot checks
        extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Ch-Ua': '"Chromium";v="120", "Not(A:Brand";v="24", "Google Chrome";v="120"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"macOS"',
        },
    });
    const page = await ctx.newPage();

    // 1. Hit reddit.com homepage and dwell
    try {
        const r = await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        console.log(`  [${sub}] homepage status=${r?.status()}`);
    } catch (e) {
        console.log(`  [${sub}] homepage failed: ${e.message}`);
        await ctx.close();
        return { count: 0 };
    }
    await humanWait(5500);
    await page.mouse.wheel(0, 600).catch(() => {});
    await humanWait(2500);

    // 2. Hit the subreddit homepage
    try {
        const r = await page.goto(`https://www.reddit.com/r/${sub}/`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        console.log(`  [${sub}] /r/${sub} status=${r?.status()}`);
    } catch (e) {
        console.log(`  [${sub}] sub homepage failed: ${e.message}`);
        await ctx.close();
        return { count: 0 };
    }
    await humanWait(7000);
    await page.mouse.wheel(0, 400).catch(() => {});
    await humanWait(2500);

    // 3. Search
    try {
        const url = `https://www.reddit.com/r/${sub}/search/?q=stargazing&restrict_sr=1&t=year&sort=top`;
        const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(`  [${sub}] search status=${r?.status()}`);
    } catch (e) {
        console.log(`  [${sub}] search failed: ${e.message}`);
        await ctx.close();
        return { count: 0 };
    }
    await humanWait(7500);

    const posts = await page.evaluate(sub => {
        const out = [];
        const seen = new Set();
        for (const a of document.querySelectorAll(`a[href*="/r/${sub}/comments/"]`)) {
            const m = /\/r\/[^/]+\/comments\/([a-z0-9]+)/i.exec(a.getAttribute('href') || '');
            if (!m) continue;
            if (seen.has(m[1])) continue; seen.add(m[1]);
            const t = (a.innerText || '').trim();
            if (t.length < 10) continue;
            out.push({ id: m[1], title: t.slice(0, 100) });
        }
        return out;
    }, sub);

    await ctx.close();
    return { count: posts.length, sample: posts.slice(0, 5).map(p => p.title) };
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    for (const sub of TARGETS) {
        console.log(`\n── r/${sub} ──`);
        const r = await probeMetro(browser, sub);
        console.log(`  RESULT: ${r.count} posts`);
        (r.sample || []).forEach(t => console.log(`    · ${t}`));
        // Long pause between metros — different sessions, different IPs (sort of)
        await humanWait(20000);
    }
    await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
