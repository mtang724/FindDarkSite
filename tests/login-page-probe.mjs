import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15' });
const p = await ctx.newPage();

console.log('=== old.reddit.com/login ===');
const r = await p.goto('https://old.reddit.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
console.log('status:', r.status());
console.log('final url:', p.url());
await p.waitForTimeout(2500);
const oldFields = await p.evaluate(() => ({
    user: !!document.querySelector('input#user_login, input[name="user"]'),
    pass: !!document.querySelector('input#passwd_login, input[name="passwd"]'),
    captcha: !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha"], [data-testid*="captcha"]'),
    pageTitle: document.title,
    htmlSnippet: document.body.innerHTML.slice(0, 2000),
}));
console.log('user field present:', oldFields.user);
console.log('pass field present:', oldFields.pass);
console.log('captcha present:', oldFields.captcha);
console.log('title:', oldFields.pageTitle);
console.log('snippet:', oldFields.htmlSnippet.replace(/\s+/g, ' ').slice(0, 800));

console.log('\n=== www.reddit.com/login ===');
const r2 = await p.goto('https://www.reddit.com/login/', { waitUntil: 'domcontentloaded', timeout: 30000 });
console.log('status:', r2.status());
console.log('final url:', p.url());
await p.waitForTimeout(3500);
const newFields = await p.evaluate(() => ({
    user: document.querySelector('input[name="username"], input#loginUsername, faceplate-text-input[name="username"]')?.tagName || null,
    pass: document.querySelector('input[name="password"], input#loginPassword, faceplate-text-input[name="password"]')?.tagName || null,
    captcha: !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]'),
    title: document.title,
    forms: Array.from(document.querySelectorAll('form')).map(f => ({ id: f.id, action: f.action })),
}));
console.log('user field tag:', newFields.user);
console.log('pass field tag:', newFields.pass);
console.log('captcha:', newFields.captcha);
console.log('title:', newFields.title);
console.log('forms:', JSON.stringify(newFields.forms));

await b.close();
