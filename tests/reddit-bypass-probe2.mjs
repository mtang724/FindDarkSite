/**
 * Probe v2:
 *   D. /r/X/top.json?t=year  (no search; just top posts, filtered locally)
 *   E. Libreddit/Redlib mirror (community Reddit proxy)
 *   F. Use ".json" suffix on the search URL via the .json-after-URL trick
 *   G. /r/X.json?limit=100 front page
 */
import { chromium } from 'playwright';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15';
const SUBS = ['Austin', 'houston', 'Atlanta', 'Denver', 'sanantonio'];
const KEYWORDS = /stargaz|dark sky|milky way|astrophot|night sky|telescope/i;

async function fetchJsonViaBrowser(page, url) {
    try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const status = resp.status();
        if (status !== 200) return { ok: false, status, body: '' };
        const body = await page.evaluate(() => document.body.innerText);
        return { ok: true, status, body };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function approachD_topJson(page, sub) {
    const r = await fetchJsonViaBrowser(page, `https://www.reddit.com/r/${sub}/top.json?t=year&limit=100`);
    if (!r.ok) return { count: 0, error: `HTTP ${r.status || r.error}` };
    try {
        const json = JSON.parse(r.body);
        const all = json?.data?.children || [];
        const relevant = all.filter(c => KEYWORDS.test((c.data?.title || '') + ' ' + (c.data?.selftext || '')));
        return { totalPosts: all.length, relevant: relevant.length, sample: relevant.slice(0, 4).map(c => c.data?.title || '?') };
    } catch (e) {
        return { count: 0, error: 'JSON parse failed', sample: r.body.slice(0, 200) };
    }
}

async function approachE_libreddit(page, sub) {
    const mirrors = [
        'https://safereddit.com',
        'https://redlib.privacydev.net',
        'https://lr.4o1x5.dev',
        'https://l.opnxng.com',
    ];
    for (const base of mirrors) {
        try {
            const url = `${base}/r/${sub}/search?q=stargazing&restrict_sr=on&t=year`;
            const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
            if (resp.status() !== 200) continue;
            const titles = await page.evaluate(() => {
                const out = [];
                document.querySelectorAll('h2 a, h3 a, .post_title a, a.post-title').forEach(a => {
                    const t = (a.innerText || '').trim();
                    if (t && t.length > 10 && t.length < 200) out.push(t.slice(0, 90));
                });
                return out.slice(0, 10);
            });
            if (titles.length > 0) {
                return { mirror: base, count: titles.length, sample: titles.slice(0, 4) };
            }
        } catch {}
    }
    return { count: 0, error: 'all mirrors failed/empty' };
}

async function approachF_searchJsonViaSuffix(page, sub) {
    // Reddit's classic ".json" suffix works on any reddit URL — sometimes treated differently
    const r = await fetchJsonViaBrowser(page, `https://www.reddit.com/r/${sub}/search/.json?q=stargazing&restrict_sr=on&t=year&sort=top&limit=20`);
    if (!r.ok) return { count: 0, error: `HTTP ${r.status || r.error}` };
    try {
        const json = JSON.parse(r.body);
        const arr = json?.data?.children || [];
        return { count: arr.length, sample: arr.slice(0, 4).map(c => c.data?.title || '?') };
    } catch {
        return { count: 0, error: 'JSON parse failed', sample: r.body.slice(0, 200) };
    }
}

async function approachG_subJson(page, sub) {
    // Sub front page JSON
    const r = await fetchJsonViaBrowser(page, `https://www.reddit.com/r/${sub}.json?limit=100`);
    if (!r.ok) return { count: 0, error: `HTTP ${r.status || r.error}` };
    try {
        const json = JSON.parse(r.body);
        const arr = json?.data?.children || [];
        const relevant = arr.filter(c => KEYWORDS.test((c.data?.title || '') + ' ' + (c.data?.selftext || '')));
        return { totalPosts: arr.length, relevant: relevant.length, sample: relevant.slice(0, 4).map(c => c.data?.title || '?') };
    } catch {
        return { count: 0, error: 'JSON parse failed' };
    }
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();

    const APPROACHES = [
        { name: 'D. /r/X/top.json?t=year (filter locally)', fn: approachD_topJson },
        { name: 'E. Libreddit/Redlib mirror', fn: approachE_libreddit },
        { name: 'F. /r/X/search/.json suffix', fn: approachF_searchJsonViaSuffix },
        { name: 'G. /r/X.json (front page)', fn: approachG_subJson },
    ];

    for (const ap of APPROACHES) {
        console.log(`\n=== ${ap.name} ===`);
        for (const sub of SUBS) {
            const r = await ap.fn(page, sub);
            const c = r.relevant ?? r.count ?? 0;
            const total = r.totalPosts ? ` (of ${r.totalPosts})` : '';
            console.log(`  r/${sub}: ${c}${total}${r.error ? ' err=' + r.error : ''}${r.mirror ? ' via=' + r.mirror.replace('https://', '') : ''}`);
            (r.sample || []).slice(0, 3).forEach(s => console.log(`    · ${s}`));
            await page.waitForTimeout(2500);
        }
    }
    await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
