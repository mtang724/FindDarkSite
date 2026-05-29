/**
 * DEEP Reddit sweep — fully comprehensive, authenticated, headful, real-Chrome.
 *
 * Compared to fetch-reddit-stargazing.mjs (wide) and fetch-reddit-slow.mjs
 * (gap-filler):
 *   - Uses REAL Chrome via `channel: 'chrome'` + a persistent profile created
 *     by reddit-login-manual.mjs (defeats Reddit's JS-challenge anti-bot AND
 *     scrapes as the logged-in user, which Reddit treats much more leniently).
 *   - Covers 85 metros (50 original + 35 mid-size dark-sky-adjacent).
 *   - 6 query variants per city sub (stargazing/dark sky/milky way/observatory/
 *     telescope/night sky), 10 national subs (orig 6 + 4 astronomy), and
 *     **t=all** for the national searches so historic "best dark-sky spots near X"
 *     threads come back.
 *   - Drills the top 10 posts per metro for body + ~8 top comments.
 *   - One metro at a time. Resume-safe (partial save after every metro).
 *
 * Output: scripts/.cache/reddit-raw-deep.json
 *
 * Expected runtime: ~10-12 hours over 85 metros. Designed to run overnight.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    US_METROS, EXTRA_METROS,
    NATIONAL_SUBS, EXTRA_NATIONAL_SUBS,
    CITY_SEARCH_QUERIES, EXTRA_QUERIES,
} from './us-metros.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '.cache');
const USER_DATA_DIR = path.join(CACHE_DIR, 'chrome-profile');
const OUT = path.join(CACHE_DIR, 'reddit-raw-deep.json');

const ALL_METROS = [...US_METROS, ...EXTRA_METROS];
const ALL_NATIONAL_SUBS = [...NATIONAL_SUBS, ...EXTRA_NATIONAL_SUBS];
const ALL_QUERIES = [...CITY_SEARCH_QUERIES, ...EXTRA_QUERIES];

const POSTS_PER_QUERY = 8;
const BODY_DRILL_LIMIT = 10;
const INTER_METRO_PAUSE_MS = 18000;

const jitter = (ms, frac = 0.25) => ms * (1 - frac + Math.random() * 2 * frac);
const sleep = ms => new Promise(r => setTimeout(r, jitter(ms)));

async function dwell(page, ms, scrollY = 500) {
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
                title: text.split('\n')[0].slice(0, 240),
                permalink: `https://www.reddit.com/r/${m[1]}/comments/${m[2]}/`,
            });
            if (out.length >= limit) break;
        }
        return out;
    }, { sub, limit });
}

async function searchSub(page, sub, query, timeRange, limit) {
    const url = `https://www.reddit.com/r/${sub}/search/?q=${encodeURIComponent(query)}&restrict_sr=1&t=${timeRange}&sort=top`;
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch { return []; }
    await sleep(6000);
    return extractPosts(page, sub, limit);
}

async function drillBody(page, post) {
    try {
        await page.goto(post.permalink, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch { return { ...post, body: '', topComments: [] }; }
    await sleep(5000);
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
            if (comments.length >= 8) break;
        }
        return { body, comments };
    });
    return { ...post, body: detail.body.slice(0, 5000), topComments: detail.comments };
}

async function processMetro(ctx, metro) {
    const page = await ctx.newPage();
    const dedup = new Map();
    const add = (posts) => { for (const p of posts) if (!dedup.has(p.id)) dedup.set(p.id, p); };

    try {
        // Warm-up: city sub homepage. Helps Reddit treat us as a real reader.
        const firstSub = metro.subreddits[0];
        try {
            await page.goto(`https://www.reddit.com/r/${firstSub}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await dwell(page, 5500, 600);
        } catch {}

        // 1. City subs × 6 queries × t=year
        for (const sub of metro.subreddits) {
            for (const q of ALL_QUERIES) {
                const posts = await searchSub(page, sub, q, 'year', POSTS_PER_QUERY);
                console.log(`    r/${sub} "${q}" (year): ${posts.length}`);
                add(posts);
                await sleep(3500);
            }
        }

        // 2. Region sub × "stargazing" × t=year
        if (metro.region) {
            const posts = await searchSub(page, metro.region, 'stargazing', 'year', POSTS_PER_QUERY);
            console.log(`    r/${metro.region} "stargazing" (year): ${posts.length}`);
            add(posts);
            await sleep(3500);
        }

        // 3. National subs × "<city> stargazing" × t=all
        for (const sub of ALL_NATIONAL_SUBS) {
            const q = `${metro.city} stargazing`;
            const posts = await searchSub(page, sub, q, 'all', POSTS_PER_QUERY);
            console.log(`    r/${sub} "${q}" (all): ${posts.length}`);
            add(posts);
            await sleep(3500);
        }

        // 4. Drill top BODY_DRILL_LIMIT posts (prioritize those with relevant title keywords)
        const all = [...dedup.values()];
        const kw = /stargaz|dark sky|milky way|astrophot|night sky|telescop|observatory|park|reserve|sanctuary|bortle/i;
        const prioritized = [
            ...all.filter(p => kw.test(p.title)),
            ...all.filter(p => !kw.test(p.title)),
        ].slice(0, BODY_DRILL_LIMIT);
        const drilled = new Map();
        for (const p of prioritized) {
            const d = await drillBody(page, p);
            drilled.set(p.id, d);
            await sleep(3500);
        }
        const finalPosts = all.map(p => drilled.get(p.id) || p);

        return {
            metro: metro.city, state: metro.state,
            lat: metro.lat, lng: metro.lng,
            region: metro.region || null,
            posts: finalPosts,
        };
    } finally {
        await page.close();
    }
}

async function main() {
    await mkdir(CACHE_DIR, { recursive: true });
    try { await access(USER_DATA_DIR); }
    catch {
        console.error(`No Chrome profile at ${USER_DATA_DIR}. Run scripts/reddit-login-manual.mjs first.`);
        process.exit(1);
    }

    // Resume
    let results = [];
    try {
        const prev = JSON.parse(await readFile(OUT, 'utf8'));
        if (Array.isArray(prev?.metros)) results = prev.metros;
        console.log(`Resuming from ${results.length} previously-scraped metros.`);
    } catch { /* fresh */ }
    const done = new Set(results.map(r => r.metro));
    let todo = ALL_METROS.filter(m => !done.has(m.city));
    const limitArg = process.argv.find(a => a.startsWith('--limit='));
    if (limitArg) todo = todo.slice(0, parseInt(limitArg.split('=')[1], 10));
    console.log(`Plan: ${ALL_METROS.length} metros total, ${todo.length} to go${limitArg ? ' (LIMITED)' : ''}.`);

    const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
        channel: 'chrome',
        headless: false,
        viewport: null,
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
        args: ['--start-maximized'],
    });

    for (let i = 0; i < todo.length; i++) {
        const m = todo[i];
        const overall = results.length + 1;
        console.log(`\n[${overall}/${ALL_METROS.length}] ${m.city}, ${m.state}`);
        const start = Date.now();
        try {
            const r = await processMetro(ctx, m);
            results.push(r);
            const sec = Math.round((Date.now() - start) / 1000);
            console.log(`  → ${r.posts.length} posts in ${sec}s`);
        } catch (e) {
            console.log(`  ✗ ${e.message}`);
            // record empty so resume skips it next pass
            results.push({ metro: m.city, state: m.state, lat: m.lat, lng: m.lng, region: m.region || null, posts: [], error: e.message });
        }
        await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), metros: results }, null, 2));
        if (i < todo.length - 1) await sleep(INTER_METRO_PAUSE_MS);
    }

    await ctx.close();
    const total = results.reduce((s, m) => s + m.posts.length, 0);
    console.log(`\nDone. ${results.length} metros, ${total} posts → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
