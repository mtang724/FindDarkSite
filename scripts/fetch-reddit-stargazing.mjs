/**
 * For each top-50 US metro, scrape r/<city> (and any secondary subreddits)
 * for the past year's top "stargazing" posts via Playwright. Saves raw post
 * text + permalinks to scripts/.cache/reddit-raw.json so the LLM extraction
 * pass can run separately.
 *
 * Why Playwright: Reddit's anti-bot blocks plain HTTP clients (and the
 * Anthropic crawler too — see earlier probe). A real Chromium fingerprint
 * works fine for read-only public threads.
 *
 * Run: node scripts/fetch-reddit-stargazing.mjs
 *      Output: scripts/.cache/reddit-raw.json
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { US_METROS } from './us-metros.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '.cache');
const OUT = path.join(CACHE_DIR, 'reddit-raw.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15';
const POSTS_PER_SUB = 6;   // top N posts per subreddit
const PARALLELISM = 4;     // metros in flight at once
const FETCH_BODY = true;   // open each post to get its full body + ~5 top comments

/**
 * Scrape one subreddit's "stargazing" search results page and return up to
 * `limit` post records: { title, permalink, score, snippet }.
 */
async function scrapeSubredditSearch(page, subreddit, limit) {
    const url = `https://www.reddit.com/r/${subreddit}/search/?q=stargazing&restrict_sr=1&t=year&sort=top`;
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (err) {
        console.log(`    ✗ ${subreddit}: goto failed (${err.message})`);
        return [];
    }
    await page.waitForTimeout(3000);

    // Reddit's current "new" layout uses <a href="/r/SUB/comments/...">...</a>
    // links; extracting visible text + permalink is enough for the LLM pass.
    const posts = await page.evaluate(({ sub, limit }) => {
        const out = [];
        const seen = new Set();
        const anchors = document.querySelectorAll(`a[href*="/r/${sub}/comments/"]`);
        for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            const m = /^\/r\/[^/]+\/comments\/([a-z0-9]+)/i.exec(href);
            if (!m) continue;
            const id = m[1];
            if (seen.has(id)) continue;
            // Skip tiny utility anchors (avatars, etc.) by requiring visible text length
            const text = (a.innerText || a.textContent || '').trim();
            if (text.length < 10) continue;
            seen.add(id);
            out.push({
                id,
                title: text.split('\n')[0].slice(0, 200),
                permalink: `https://www.reddit.com${href}`,
            });
            if (out.length >= limit) break;
        }
        return out;
    }, { sub: subreddit, limit });

    return posts;
}

/**
 * Open a single post page and pull (a) the OP body and (b) the top 5 visible
 * comment texts. We don't try to be exhaustive — the LLM only needs enough
 * signal to extract specific place names.
 */
async function scrapePostBody(page, post) {
    try {
        await page.goto(post.permalink, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch {
        return { ...post, body: '', topComments: [] };
    }
    await page.waitForTimeout(2200);

    const detail = await page.evaluate(() => {
        // Old + new Reddit layouts. Try multiple selectors and pick the first.
        function firstText(...selectors) {
            for (const s of selectors) {
                const els = document.querySelectorAll(s);
                for (const el of els) {
                    const t = (el.innerText || el.textContent || '').trim();
                    if (t && t.length > 30) return t;
                }
            }
            return '';
        }
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
 * Drive one metro: scrape its subreddit(s) for top posts, then drill into each.
 * One Page (one tab) per metro keeps memory bounded.
 */
async function processMetro(ctx, metro) {
    const page = await ctx.newPage();
    const allPosts = [];
    for (const sub of metro.subreddits) {
        const posts = await scrapeSubredditSearch(page, sub, POSTS_PER_SUB);
        for (const p of posts) allPosts.push({ ...p, subreddit: sub });
        console.log(`  · r/${sub}: ${posts.length} posts`);
    }
    // De-dup by id (e.g. cross-posted)
    const dedup = new Map();
    for (const p of allPosts) dedup.set(p.id, p);
    const detailed = [];
    if (FETCH_BODY) {
        for (const p of dedup.values()) {
            const d = await scrapePostBody(page, p);
            detailed.push(d);
        }
    } else {
        detailed.push(...dedup.values());
    }
    await page.close();
    return { metro: metro.city, state: metro.state, lat: metro.lat, lng: metro.lng, posts: detailed };
}

async function main() {
    await mkdir(CACHE_DIR, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 900 } });

    const results = [];
    // Sequential outer loop, parallel inner — each batch of N metros runs in
    // parallel tabs. Keeps Reddit happy + avoids tab explosion.
    for (let i = 0; i < US_METROS.length; i += PARALLELISM) {
        const batch = US_METROS.slice(i, i + PARALLELISM);
        console.log(`\n[${i + 1}/${US_METROS.length}] Batch: ${batch.map(m => m.city).join(', ')}`);
        const settled = await Promise.allSettled(batch.map(m => processMetro(ctx, m)));
        for (const s of settled) {
            if (s.status === 'fulfilled') results.push(s.value);
            else console.warn('  ! batch failure:', s.reason?.message);
        }
        // Write partial progress so a mid-run crash doesn't lose work.
        await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), metros: results }, null, 2));
    }

    await browser.close();
    const totalPosts = results.reduce((s, m) => s + m.posts.length, 0);
    console.log(`\nDone. ${results.length} metros, ${totalPosts} posts total → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
