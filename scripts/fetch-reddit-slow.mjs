/**
 * Slow + human-paced + headful Reddit scraper for the metros where the v2
 * batch scraper got blocked. Designed to actually get past Reddit's anti-bot.
 *
 * Per metro:
 *   - Fresh browser context (no cookies leaking)
 *   - Visit reddit.com homepage → dwell + scroll
 *   - Visit r/<sub> homepage     → dwell + scroll
 *   - Run search                → dwell + extract
 *   - Drill 4–6 most-promising posts for body + comments
 *
 * Slow but reliable: ~90–120 sec per metro. Runs ONE metro at a time, no
 * parallelism. The probe results (Austin 12 / Houston 7 / Denver 7 in
 * headless) confirm this pattern works.
 *
 * Output: scripts/.cache/reddit-raw-slow.json (kept separate so the main
 * raw file isn't clobbered if this run misbehaves; merged downstream).
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { US_METROS, CITY_SEARCH_QUERIES } from './us-metros.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '.cache');
const IN_RAW   = path.join(CACHE_DIR, 'reddit-raw.json');
const OUT      = path.join(CACHE_DIR, 'reddit-raw-slow.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const POSTS_PER_QUERY = 8;
const HEADFUL = true;
const BODY_DRILL_LIMIT = 5;  // drill at most this many post pages per metro

const jitter = (ms, frac = 0.25) => ms * (1 - frac + Math.random() * 2 * frac);
const sleep  = ms => new Promise(r => setTimeout(r, jitter(ms)));

async function newCtx(browser) {
    return await browser.newContext({
        userAgent: UA,
        viewport: { width: 1280 + Math.floor(Math.random() * 200), height: 800 + Math.floor(Math.random() * 100) },
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
        extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
        },
    });
}

async function dwellAndScroll(page, ms, scrollY = 500) {
    await sleep(ms * 0.45);
    await page.mouse.wheel(0, scrollY).catch(() => {});
    await sleep(ms * 0.55);
}

async function extractPosts(page, sub, limit) {
    return await page.evaluate(({ sub, limit }) => {
        const out = [];
        const seen = new Set();
        const selector = `a[href*="/r/${sub}/comments/"]`;
        for (const a of document.querySelectorAll(selector)) {
            const href = a.getAttribute('href') || '';
            const m = /\/r\/([^/]+)\/comments\/([a-z0-9]+)/i.exec(href);
            if (!m) continue;
            if (seen.has(m[2])) continue;
            const text = (a.innerText || a.textContent || '').trim();
            if (text.length < 10) continue;
            seen.add(m[2]);
            out.push({
                id: m[2],
                subreddit: m[1],
                title: text.split('\n')[0].slice(0, 200),
                permalink: `https://www.reddit.com/r/${m[1]}/comments/${m[2]}/`,
            });
            if (out.length >= limit) break;
        }
        return out;
    }, { sub, limit });
}

async function searchSub(page, sub, query, limit) {
    const url = `https://www.reddit.com/r/${sub}/search/?q=${encodeURIComponent(query)}&restrict_sr=1&t=year&sort=top`;
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch { return []; }
    await sleep(7500);
    return extractPosts(page, sub, limit);
}

async function drillBody(page, post) {
    try {
        await page.goto(post.permalink, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch { return { ...post, body: '', topComments: [] }; }
    await sleep(5500);
    const detail = await page.evaluate(() => {
        const firstText = (...selectors) => {
            for (const s of selectors) {
                for (const el of document.querySelectorAll(s)) {
                    const t = (el.innerText || el.textContent || '').trim();
                    if (t && t.length > 30) return t;
                }
            }
            return '';
        };
        const body = firstText(
            'shreddit-post [slot="text-body"]',
            'div[data-test-id="post-content"] div[data-click-id="text"]',
            'div[data-testid="post-rtjson-content"]',
        );
        const comments = [];
        const els = document.querySelectorAll(
            'shreddit-comment [slot="comment"], div[data-testid="comment"], div[data-testid="post-comment-list"] p'
        );
        for (const el of els) {
            const t = (el.innerText || el.textContent || '').trim();
            if (t && t.length > 30 && !comments.includes(t)) comments.push(t);
            if (comments.length >= 5) break;
        }
        return { body, comments };
    });
    return { ...post, body: detail.body.slice(0, 4000), topComments: detail.comments };
}

async function processMetro(browser, metro) {
    const ctx = await newCtx(browser);
    const page = await ctx.newPage();

    // 1. reddit.com homepage warmup
    try {
        await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (e) {
        console.log(`  ✗ homepage: ${e.message}`);
        await ctx.close();
        return { metro: metro.city, state: metro.state, lat: metro.lat, lng: metro.lng, posts: [] };
    }
    await dwellAndScroll(page, 6000, 600);

    // 2. Iterate every sub in metro × first 2 query variants. Visit subreddit
    //    home once per sub to warm up before searching.
    const dedup = new Map();
    for (const sub of metro.subreddits) {
        try {
            await page.goto(`https://www.reddit.com/r/${sub}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch {}
        await dwellAndScroll(page, 7500, 500);

        for (const q of CITY_SEARCH_QUERIES.slice(0, 2)) {  // stargazing + dark sky
            const posts = await searchSub(page, sub, q, POSTS_PER_QUERY);
            console.log(`  · r/${sub} "${q}": ${posts.length}`);
            for (const p of posts) if (!dedup.has(p.id)) dedup.set(p.id, p);
            await sleep(4500);
        }
    }

    // 3. Drill the most promising posts (titles containing relevant keywords)
    const all = [...dedup.values()];
    const kw = /stargaz|dark sky|milky way|astrophot|night sky|telescop|park|reserve/i;
    const prioritized = [
        ...all.filter(p => kw.test(p.title)),
        ...all.filter(p => !kw.test(p.title)),
    ].slice(0, BODY_DRILL_LIMIT);
    const drilled = new Map();
    for (const p of prioritized) {
        const d = await drillBody(page, p);
        drilled.set(p.id, d);
        await sleep(4000);
    }
    // Stitch drilled bodies back into the post list
    const finalPosts = all.map(p => drilled.get(p.id) || p);

    await ctx.close();
    return {
        metro: metro.city,
        state: metro.state,
        lat: metro.lat,
        lng: metro.lng,
        region: metro.region || null,
        posts: finalPosts,
    };
}

async function main() {
    await mkdir(CACHE_DIR, { recursive: true });

    // Read prior wide-scrape raw to find which metros have 0 posts → those are the targets.
    let prior;
    try { prior = JSON.parse(await readFile(IN_RAW, 'utf8')); }
    catch { console.error(`Need ${IN_RAW} to exist first (run fetch-reddit-stargazing.mjs).`); process.exit(1); }

    const priorByCity = new Map(prior.metros.map(m => [m.metro, m]));
    const targets = US_METROS.filter(m => (priorByCity.get(m.city)?.posts?.length || 0) === 0);
    console.log(`Will slow-scrape ${targets.length} previously-empty metros:`);
    console.log('  ' + targets.map(m => m.city).join(', '));

    // Resume support
    let results = [];
    try {
        const prev = JSON.parse(await readFile(OUT, 'utf8'));
        if (Array.isArray(prev?.metros)) results = prev.metros;
        console.log(`Resuming from ${results.length} already-slow-scraped metros.`);
    } catch {}
    const doneCities = new Set(results.map(r => r.metro));
    const todo = targets.filter(m => !doneCities.has(m.city));
    console.log(`To go: ${todo.length}\n`);

    const browser = await chromium.launch({ headless: !HEADFUL });

    for (let i = 0; i < todo.length; i++) {
        const m = todo[i];
        console.log(`\n[${i + 1}/${todo.length}] ${m.city}, ${m.state}`);
        const start = Date.now();
        try {
            const r = await processMetro(browser, m);
            results.push(r);
            console.log(`  ✓ ${r.posts.length} posts (${((Date.now() - start) / 1000).toFixed(0)}s)`);
        } catch (e) {
            console.log(`  ✗ ${e.message}`);
        }
        // Persist progress every metro so a crash never loses ground
        await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), metros: results }, null, 2));
        // Long inter-metro pause — most important anti-bot ingredient
        if (i < todo.length - 1) await sleep(22000);
    }

    await browser.close();
    const total = results.reduce((s, m) => s + m.posts.length, 0);
    console.log(`\nDone. ${results.length} metros, ${total} posts → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
