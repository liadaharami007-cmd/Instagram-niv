/**
 * Full-process end-to-end check: real server process (HTTP + worker + scheduler + SQLite)
 * driven through a real browser. Meta is replaced by the test-only fake Graph HTTP server.
 * Run: node test/e2e/ui.e2e.ts   (requires Playwright + Chromium)
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createFakeGraph } from '../fake-graph.ts';
import { followersJson, followingJson, makeZip } from '../helpers.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(import.meta.dirname, '../..');
const shots = process.env.E2E_SHOTS ?? join(root, 'data', 'e2e-shots');
const tmp = mkdtempSync(join(tmpdir(), 'nivbot-e2e-'));
const PORT = 3911;
const base = `http://127.0.0.1:${PORT}`;

const fake = createFakeGraph();
const fakeServer = await fake.listen();
const fakeUrl = `http://127.0.0.1:${(fakeServer.address() as any).port}`;

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
  cwd: root,
  env: {
    ...process.env, NODE_ENV: 'development', PORT: String(PORT), HOST: '127.0.0.1', DATABASE_PATH: join(tmp, 'e2e.db'),
    PUBLIC_BASE_URL: base, LOG_LEVEL: 'warn', WORKER_POLL_MS: '200',
    TEST_INSTAGRAM_GRAPH_BASE: fakeUrl, TEST_FACEBOOK_GRAPH_BASE: fakeUrl, TEST_INSTAGRAM_API_BASE: fakeUrl,
    INSTAGRAM_APP_ID: '', INSTAGRAM_APP_SECRET: 'e2e-secret', META_WEBHOOK_VERIFY_TOKEN: 'e2e-verify', FACEBOOK_APP_ID: '', FACEBOOK_APP_SECRET: '',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const step = (s: string) => console.log(`✔ ${s}`);
async function waitFor(fn: () => Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timeout');
}

let browser: any;
try {
  await waitFor(async () => (await fetch(`${base}/api/system/health`)).ok);
  step('server healthy (HTTP + worker + scheduler)');
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  // instagram.com is unreachable from the test sandbox: stub it so the opened tab URL can be verified.
  await page.context().route('https://www.instagram.com/**', (r: any) => r.fulfill({ status: 200, contentType: 'text/html', body: 'instagram stub' }));
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: any) => m.type() === 'error' && !m.text().includes('409') && errors.push(m.text()));

  await page.goto(`${base}/#/register`);
  await page.fill('#orgName', 'Niv Agency');
  await page.fill('#name', 'Niv');
  await page.fill('#email', 'niv@example.com');
  await page.fill('#password', 'very-strong-password');
  await page.click('button[type=submit]');
  await page.waitForSelector('text=ברוך הבא');
  step('registered organization and owner');

  await page.click('text=חיבור חשבון Instagram אמיתי');
  await page.waitForSelector('text=מה המערכת יכולה לעשות');
  assert.ok(await page.isVisible('text=לא הוגדר עדיין'), 'OAuth shows as not configured without app secrets');
  await page.fill('input[name=token]', 'test-token-xxxxxxxxxxxxxxxxxxxx');
  await page.click('text=אימות וחיבור');
  await page.waitForURL(/#\/a\/acc_.*\/growth/);
  step('connected Instagram account via token');

  const accId = page.url().match(/acc_[^/]+/)![0];
  await waitFor(async () => {
    const r = await page.evaluate(async (id: string) => (await fetch(`/api/accounts/${id}/automation`)).json(), accId);
    return r.jobs.length >= 4 && r.jobs.every((j: any) => j.status === 'succeeded');
  }, 30_000);
  await page.reload();
  await page.waitForFunction(() => document.body.innerText.includes('1,520'), null, { timeout: 15_000 });
  await page.waitForSelector('text=דוח שבועי');
  await page.waitForSelector('.media-item');
  await page.screenshot({ path: join(shots, '1-growth.png'), fullPage: true });
  step('growth dashboard shows synced followers, charts, weekly report, posts');

  const accUrl = page.url().replace(/\/growth.*/, '');
  await page.goto(`${accUrl}/capabilities`);
  await page.waitForSelector('text=מה עובד');
  await page.waitForSelector('tbody tr');
  await page.screenshot({ path: join(shots, '9-capabilities.png'), fullPage: true });
  await waitFor(async () => (await page.locator('tr:has(strong:text-is("Follow אוטומטי")) >> text=לא נתמך').count()) === 1);
  assert.equal(await page.locator('tr:has-text("מספר עוקבים") >> text=עובד — אומת').count(), 1, 'profile sync verified by a real run');
  await page.screenshot({ path: join(shots, '9-capabilities.png'), fullPage: true });
  await page.goto(`${accUrl}/likes`);
  await page.waitForSelector('text=Facebook Login');
  assert.ok(await page.isDisabled('text=▶ הפעלה'), 'likes engine cannot start on Instagram-Login accounts');
  step('capabilities: unsupported actions shown as not supported; likes engine blocked with reason');
  await page.goto(`${accUrl}/follow`);
  await page.fill('textarea[name=usernames]', 'lead.one\nlead.two\n@lead.three');
  await page.fill('input[name=segment]', 'לידים');
  await page.click('form >> text=הוספה');
  await page.waitForSelector('text=תכנון משימות עכשיו');
  await page.click('text=תכנון משימות עכשיו');
  await page.waitForSelector('.task-card .handle');
  const handle = await page.textContent('.task-card .handle');
  assert.ok(await page.isDisabled('text=✓ עקבתי'), 'done disabled until Instagram opened');
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('.task-card a.btn.primary')]);
  assert.match(popup.url(), /instagram\.com\/lead\./);
  await popup.close();
  await page.click('text=✓ עקבתי');
  await page.waitForSelector('text=המתנה בין פעולות');
  await page.screenshot({ path: join(shots, '2-follow.png'), fullPage: true });
  step(`follow workflow: opened ${handle} in Instagram, confirmed, pacing countdown active`);

  await page.goto(`${accUrl}/unfollow`);
  await page.waitForSelector('text=טרם יובא קובץ');
  const zipPath = join(tmp, 'instagram-export.zip');
  writeFileSync(zipPath, makeZip({
    'connections/followers_and_following/followers_1.json': followersJson([['lead.two', 1600000000]]),
    'connections/followers_and_following/following.json': followingJson([['lead.two', 1600000000], ['old.brand', 1600000000], ['stale.acct', 1600000000]]),
  }));
  await page.setInputFiles('input[type=file]', zipPath);
  await page.click('text=ייבוא');
  await page.waitForSelector('text=ייבוא אחרון');
  await page.click('text=תכנון משימות עכשיו');
  await page.waitForSelector('.task-card .handle');
  await page.screenshot({ path: join(shots, '3-unfollow.png'), fullPage: true });
  step('unfollow: imported official export ZIP, non-followers planned');

  await page.goto(`${accUrl}/automation`);
  await page.waitForSelector('text=תור משימות');
  await page.click('tr:has-text("סנכרון פרופיל") >> text=הרצה עכשיו');
  await waitFor(async () => (await page.locator('tr:has-text("סנכרון פרופיל ועוקבים") .badge.good').count()) >= 2);
  await page.screenshot({ path: join(shots, '4-automation.png'), fullPage: true });
  step('automation: run-now job executed by background worker');

  // Scheduled publishing: upload a real JPEG and publish now
  const jpg = join(tmp, 'post.jpg');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xdd2a7b:s=1080x1350', '-frames:v', '1', jpg]);
  await page.goto(`${accUrl}/publish`);
  await page.waitForSelector('text=פרסום חדש');
  await page.setInputFiles('input[type=file]', jpg);
  await page.waitForSelector('.upload-preview img');
  await page.fill('textarea', 'פוסט ראשון מהמערכת #ניסיון');
  await page.click('.chip:has-text("עכשיו")');
  await page.click('text=🚀 פרסום עכשיו');
  await waitFor(async () => {
    await page.reload();
    await page.waitForSelector('text=היסטוריית פרסומים');
    return (await page.locator('.list-item .badge.good:has-text("פורסם")').count()) === 1;
  }, 20_000);
  assert.equal(fake.state.published.length, 1);
  await page.screenshot({ path: join(shots, '7-publish.png'), fullPage: true });
  step('publishing: uploaded JPEG and published through the content publishing API');

  // Auto replies: one-click template, then a signed Meta webhook comment
  await page.goto(`${accUrl}/replies`);
  await page.waitForSelector('text=הפעלה בלחיצה');
  await page.click('.template:has-text("מחיר") >> text=➕ הפעלה');
  await page.waitForSelector('.list-item:has-text("מחיר")');
  const hook = JSON.stringify({ object: 'instagram', entry: [{ id: fake.state.igUserId, time: 1, changes: [{ field: 'comments', value: { id: '90001', text: 'מה המחיר? 😍', from: { id: '5551', username: 'happy.customer' }, media: { id: '17900000000000001' } } }] }] });
  const sig = 'sha256=' + createHmac('sha256', 'e2e-secret').update(hook).digest('hex');
  const hr = await fetch(`${base}/meta/webhook`, { method: 'POST', body: hook, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
  assert.equal(hr.status, 200);
  await waitFor(async () => fake.state.replies.length === 1 && fake.state.messages.length === 1, 10_000);
  await page.reload();
  await page.waitForSelector('td:has-text("happy.customer")');
  await page.screenshot({ path: join(shots, '8-replies.png'), fullPage: true });
  step('auto-reply: template enabled in one click, webhook comment answered publicly + privately');

  // Likes engine: reconnect the same IG account through Facebook Login (the only login with the Likes API)
  const fbConn = await page.evaluate(async () => (await fetch('/api/accounts/connect-token', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'niv-bot' }, body: JSON.stringify({ provider: 'facebook_login', token: 'fb-user-token-xxxxxxxxxxxxxxxxxx' }) })).json());
  assert.equal(fbConn.accounts[0].provider, 'facebook_login');
  await page.goto(`${accUrl}/settings`);
  await page.fill('input[name=active_hour_start]', '0');
  await page.fill('input[name=active_hour_end]', '24');
  await page.click('form >> text=שמירה');
  await page.waitForSelector('text=נשמר');
  await page.goto(`${accUrl}/likes`);
  await page.waitForSelector('text=המנוע כבוי');
  await page.fill('input[name=usernames]', 'target.biz, competitor.one');
  await page.click('text=הוספה למנוע');
  await page.waitForSelector('text=▶ הפעלה');
  await page.click('text=▶ הפעלה');
  await waitFor(async () => {
    await page.reload();
    await page.waitForSelector('text=יומן פעולות');
    return (await page.locator('.badge:has-text("ממתין")').count()) === 2;
  }, 20_000);
  await page.screenshot({ path: join(shots, '10-likes-engine.png'), fullPage: true });
  await page.click('text=⏹ עצירה');
  await waitFor(async () => (await page.locator('.badge:has-text("בוטל")').count()) === 2);
  assert.equal(fake.state.likes.length, 0, 'stopped before any scheduled like ran');
  step('likes engine: started from UI, found fresh posts via Business Discovery, queued spaced likes, stopped and cancelled');

  await page.goto(`${accUrl}/safety`);
  await page.waitForSelector('text=אירועי בטיחות');
  page.once('dialog', (d: any) => d.accept('Try Again Later'));
  await page.click('text=⛔ דיווח על חסימה');
  await page.waitForSelector('text=הקפאת בטיחות לפעולות ידניות');
  await page.screenshot({ path: join(shots, '5-safety.png'), fullPage: true });
  step('safety: action-block report freezes manual actions');

  await page.click('text=⏸ השהיית חשבון');
  await page.waitForSelector('text=▶ חידוש פעילות');
  await page.click('text=▶ חידוש פעילות');
  await page.waitForSelector('text=⏸ השהיית חשבון');
  step('pause / resume account');

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.context().addCookies(await page.context().cookies());
  await mobile.goto(`${accUrl}/growth`);
  await mobile.waitForSelector('text=דוח שבועי');
  // RTL overflow goes to the left, so measure element boxes on both sides (ignoring scrollable containers' children and the off-canvas menu).
  const overflow = await mobile.evaluate(() => {
    let worst = 0;
    for (const el of document.querySelectorAll('#main *, .topbar *')) {
      if (el.closest('.table-wrap, .tabs, .side')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      worst = Math.max(worst, -r.left, r.right - window.innerWidth);
    }
    return Math.round(worst);
  });
  assert.ok(overflow <= 1, `no horizontal page scroll on mobile (overflow ${overflow}px)`);
  await mobile.screenshot({ path: join(shots, '6-mobile.png'), fullPage: false });
  step('mobile layout renders without horizontal overflow');

  await page.goto(`${base}/#/`);
  await page.waitForSelector('text=השוואת ביצועים');
  await page.screenshot({ path: join(shots, '0-overview.png'), fullPage: true });
  assert.deepEqual(errors, [], `browser errors: ${errors.join('\n')}`);
  step('overview page, no browser console errors');
  console.log(`\nE2E PASSED — screenshots in ${shots}`);
} catch (err) {
  console.error('E2E FAILED:', err);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  fakeServer.close();
  rmSync(tmp, { recursive: true, force: true });
}
