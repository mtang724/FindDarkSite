/**
 * Wider Reddit sweep for the "Locals say" data — fans out per metro across:
 *   1. The city's own subreddit(s)     × 3 search queries  (stargazing / dark sky / milky way)
 *   2. The regional / state subreddit  × 1 search query    (stargazing)
 *   3. A handful of NATIONAL subs      × 1 query per metro (q="<city> stargazing")
 *
 * Why Playwright: Reddit's anti-bot blocks plain HTTP clients (and Anthropic's
 * WebFetch too). A real Chromium fingerprint works fine for read-only public
 * threads.
 *
 * Output:  scripts/.cache/reddit-raw.json
 *
 * Tunables below — drop POSTS_PER_SEARCH if you want to be gentler.
 *
 * Designed to be re-run periodically; partial progress is written after every
 * batch so a crash never loses everything.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { US_METROS, NATIONAL_SUBS, CITY_SEARCH_QUERIES } from './us-metros.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '.cache');
const OUT = path.join(CACHE_DIR, 'reddit-raw.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15';
const POSTS_PER_SEARCH = 6;     // top N posts per (sub × query)
const PARALLELISM     = 3;      // metros in flight at once — gentler than v1 since each metro now makes more requests
const FETCH_BODY      = true;   // drill each post for full body + ~5 top comments
const BETWEEN_BATCH_DELAY_MS = 1500;

/**
 * Pull post links + visible titles out of a Reddit search results page.
 * Works on both old-tree and new-tree layouts.
 */
async function scrapeSearch(page, url, subForLink, limit) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (err) {
        return [];
    }
    await page.waitForTimeout(2500);

    return await page.evaluate(({ subForLink, limit }) => {
        const out = [];
        const seen = new Set();
        // Match either `/r/<sub>/comments/<id>/` or any `/comments/<id>/` (for site-wide search)
        const selector = subForLink
            ? `a[href*="/r/${subForLink}/comments/"]`
            : 'a[href*="/comments/"]';
        for (const a of document.querySelectorAll(selector)) {
            const href = a.getAttribute('href') || '';
            const m = /\/r\/([^/]+)\/comments\/([a-z0-9]+)/i.exec(href);
            if (!m) continue;
            const sub = m[1];
            const id  = m[2];
            if (seen.has(id)) continue;
            const text = (a.innerText || a.textContent || '').trim();
            if (text.length < 10) continue;
            seen.add(id);
            out.push({
                id,
                subreddit: sub,
                title: text.split('\n')[0].slice(0, 200),
                permalink: `https://www.reddit.com/r/${sub}/comments/${id}/`,
            });
            if (out.length >= limit) break;
        }
        return out;
    }, { subForLink, limit });
}

/**
 * Open one post page and pull the OP body + ~5 visible comments.
 */
async function scrapeBody(page, post) {
    try {
        await page.goto(post.permalink, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch {
        return { ...post, body: '', topComments: [] };
    }
    await page.waitForTimeout(2200);
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
            'div[data-adclicklocation="title"]',
        );
        const comments = [];
        const commentEls = document.querySelectorAll(
            'shreddit-comment [slot="comment"], div[data-testid="comment"], div[data-testid="post-comment-list"] p'
        );
        for (const el of commentEls) {
            const t = (el.innerText || el.textContent || '').trim();
            if (t && t.length > 30 && !comments.includes(t)) comments.push(t);
            if (comments.length >= 5) break;
        }
        return { body, comments };
    });
    return { ...post, body: detail.body.slice(0, 4000), topComments: detail.comments };
}

/**
 * Drive one metro's full sweep.
 */
async function processMetro(ctx, metro) {
    const page = await ctx.newPage();
    const dedup = new Map();   // post id → post

    const addAll = (posts) => {
        for (const p of posts) {
            if (!dedup.has(p.id)) dedup.set(p.id, p);
        }
    };

    // ── 1. City + adjacent subs × query variants ──────────────────────────
    for (const sub of metro.subreddits) {
        for (const q of CITY_SEARCH_QUERIES) {
            const url = `https://www.reddit.com/r/${sub}/search/?q=${encodeURIComponent(q)}&restrict_sr=1&t=year&sort=top`;
            const posts = await scrapeSearch(page, url, sub, POSTS_PER_SEARCH);
            console.log(`  · r/${sub} "${q}": ${posts.length}`);
            addAll(posts);
        }
    }

    // ── 2. Region sub — one stargazing search ─────────────────────────────
    if (metro.region) {
        const url = `https://www.reddit.com/r/${metro.region}/search/?q=stargazing&restrict_sr=1&t=year&sort=top`;
        const posts = await scrapeSearch(page, url, metro.region, POSTS_PER_SEARCH);
        console.log(`  · r/${metro.region} "stargazing" (region): ${posts.length}`);
        addAll(posts);
    }

    // ── 3. National subs — search "<city> stargazing" across each ─────────
    for (const sub of NATIONAL_SUBS) {
        const q = `${metro.city} stargazing`;
        const url = `https://www.reddit.com/r/${sub}/search/?q=${encodeURIComponent(q)}&restrict_sr=1&t=year&sort=top`;
        const posts = await scrapeSearch(page, url, sub, Math.min(POSTS_PER_SEARCH, 5));
        console.log(`  · r/${sub} "${q}": ${posts.length}`);
        addAll(posts);
    }

    // ── 4. Drill bodies ───────────────────────────────────────────────────
    const detailed = [];
    if (FETCH_BODY) {
        for (const p of dedup.values()) {
            detailed.push(await scrapeBody(page, p));
        }
    } else {
        detailed.push(...dedup.values());
    }

    await page.close();
    return {
        metro: metro.city,
        state: metro.state,
        lat: metro.lat,
        lng: metro.lng,
        region: metro.region || null,
        posts: detailed,
    };
}

async function main() {
    await mkdir(CACHE_DIR, { recursive: true });

    // Resume support: if a previous run wrote a partial file, skip metros
    // already covered. (Easy to spot: same city name.)
    let results = [];
    try {
        const prior = JSON.parse(await readFile(OUT, 'utf8'));
        if (Array.isArray(prior?.metros)) {
            results = prior.metros;
            console.log(`Resuming from ${results.length} previously-scraped metros.`);
        }
    } catch { /* fresh start */ }
    const doneCities = new Set(results.map(r => r.metro));
    const todo = US_METROS.filter(m => !doneCities.has(m.city));
    console.log(`To scrape: ${todo.length} metros (skipping ${US_METROS.length - todo.length} already done).`);

    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 900 } });

    for (let i = 0; i < todo.length; i += PARALLELISM) {
        const batch = todo.slice(i, i + PARALLELISM);
        const batchStart = results.length;
        console.log(`\n[${batchStart + 1}-${batchStart + batch.length}/${US_METROS.length}] Batch: ${batch.map(m => m.city).join(', ')}`);
        const settled = await Promise.allSettled(batch.map(m => processMetro(ctx, m)));
        for (const s of settled) {
            if (s.status === 'fulfilled') results.push(s.value);
            else console.warn('  ! batch failure:', s.reason?.message);
        }
        await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), metros: results }, null, 2));
        await new Promise(r => setTimeout(r, BETWEEN_BATCH_DELAY_MS));
    }

    await browser.close();
    const totalPosts = results.reduce((s, m) => s + m.posts.length, 0);
    console.log(`\nDone. ${results.length} metros, ${totalPosts} posts total → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
