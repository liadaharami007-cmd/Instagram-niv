/**
 * Short "connect your own account" walkthrough (≈45s, Hebrew captions).
 * Meta is replaced by the test-only fake Graph server — the video says so on screen.
 * Run: node scripts/record-connect-demo.ts → data/demo-video/niv-bot-connect.mp4
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFakeGraph } from '../test/fake-graph.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'data', 'demo-video');
const tmp = mkdtempSync(join(tmpdir(), 'nivbot-connect-'));
const PORT = 3933;
const base = `http://127.0.0.1:${PORT}`;
mkdirSync(outDir, { recursive: true });

const fake = createFakeGraph();
const fakeServer = await fake.listen();
const fakeUrl = `http://127.0.0.1:${(fakeServer.address() as any).port}`;
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', PORT: String(PORT), HOST: '127.0.0.1', DATABASE_PATH: join(tmp, 'c.db'), LOG_LEVEL: 'warn', WORKER_POLL_MS: '200',
    TEST_INSTAGRAM_GRAPH_BASE: fakeUrl, TEST_FACEBOOK_GRAPH_BASE: fakeUrl, TEST_INSTAGRAM_API_BASE: fakeUrl, INSTAGRAM_APP_ID: '', INSTAGRAM_APP_SECRET: 'demo-secret' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 75; i++) {
  if (await fetch(`${base}/api/system/health`).then((r) => r.ok).catch(() => false)) break;
  await sleep(200);
}
const W = 1280;
const H = 720;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: tmp, size: { width: W, height: H } }, locale: 'he-IL' });
const page = await context.newPage();

async function caption(text: string, ms = 2600) {
  await page.evaluate((t: string) => {
    let el = document.getElementById('demo-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      Object.assign(el.style, {
        position: 'fixed', bottom: '28px', left: '50%', transform: 'translateX(-50%)', zIndex: '9999', maxWidth: '86%',
        background: 'rgba(17,19,33,.88)', color: '#fff', padding: '14px 26px', borderRadius: '16px', direction: 'rtl',
        font: '600 24px Rubik, "Segoe UI", sans-serif', textAlign: 'center', boxShadow: '0 10px 30px rgba(0,0,0,.25)', transition: 'opacity .3s',
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.style.opacity = '1';
  }, text);
  await sleep(ms);
}
async function show(locator: any, pause = 700) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((el: HTMLElement) => {
    el.style.outline = '4px solid #f58529';
    el.style.outlineOffset = '3px';
  });
  await sleep(pause);
  await locator.evaluate((el: HTMLElement) => (el.style.outline = ''));
}
async function click(locator: any) {
  await show(locator);
  await locator.click();
}
async function openTab(match: string | RegExp) {
  const tab = page.locator('.tabs a.tab').filter({ hasText: match }).first();
  if (!(await tab.isVisible())) await page.locator('.tabs a.tab').filter({ hasText: 'עוד' }).click();
  await click(tab);
}
async function scroll(px: number, steps = 12) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, px / steps);
    await sleep(60);
  }
  await sleep(500);
}

try {
  await page.goto(`${base}/#/register`);
  await page.waitForSelector('#orgName');
  await caption('הדגמה: כך נראה חיבור חשבון אינסטגרם למערכת (מול שרת Meta מדומה)', 3400);
  await page.locator('#orgName').pressSequentially('העסק שלי', { delay: 35 });
  await page.locator('#name').pressSequentially('ניב', { delay: 35 });
  await page.locator('#email').pressSequentially('me@mybusiness.co.il', { delay: 20 });
  await page.fill('#password', 'demo-password-123');
  await click(page.locator('button[type=submit]'));
  await page.waitForSelector('text=בחר איך להתחיל');
  await click(page.locator('text=חיבור חשבון Instagram אמיתי'));
  await page.waitForSelector('input[name=token]');
  await show(page.locator('form:has(input[name=token])'), 300);
  await caption('שלב 1: מדביקים את הטוקן מ-Meta (או לוחצים "חיבור עם Meta")', 3200);
  await page.locator('input[name=token]').pressSequentially('IGAAxxxxxxxxxxxxxxxxxxxxxxxxxx', { delay: 15 });
  await caption('לוחצים "אימות וחיבור"…', 1200);
  await click(page.locator('button:has-text("אימות וחיבור")'));
  await page.waitForSelector('text=הכול פועל אוטומטית');
  await caption('שלב 2: זהו. הכול כבר פועל אוטומטית — בלי להפעיל שום דבר', 3600);
  await page.reload();
  await page.waitForSelector('text=הכול פועל אוטומטית');
  await show(page.locator('.feature:has-text("מחיר")'), 500);
  await caption('מישהו כותב "כמה עולה?" בתגובה…', 2400);

  const hook = JSON.stringify({ object: 'instagram', entry: [{ id: fake.state.igUserId, time: 1, changes: [{ field: 'comments', value: { id: '61001', text: 'כמה עולה? 😍', from: { id: '5101', username: 'new.customer' }, media: { id: '17900000000000001' } } }] }] });
  await fetch(`${base}/meta/webhook`, { method: 'POST', body: hook, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'demo-secret').update(hook).digest('hex') } });
  for (let i = 0; i < 50 && fake.state.messages.length === 0; i++) await sleep(200);
  await page.reload();
  await page.waitForSelector('.feature:has-text("מחיר") >> text=1 פעמים');
  await show(page.locator('.feature:has-text("מחיר")'), 600);
  await caption('…והוא מקבל מיד תשובה בתגובה + הודעה פרטית עם הפרטים ✅', 3800);
  await page.locator('.tabs a.tab').filter({ hasText: 'עוד' }).click();
  await click(page.locator('.tabs a.tab').filter({ hasText: 'מענה אוטומטי' }));
  await page.waitForSelector('td:has-text("new.customer")');
  await page.mouse.wheel(0, 1300);
  await sleep(600);
  await caption('כל תשובה שנשלחה מתועדת', 2600);

  await click(page.locator('.tabs a.tab').filter({ hasText: 'נתונים' }).first());
  await page.waitForSelector('text=דוח שבועי');
  await caption('נתוני צמיחה אמיתיים מהחשבון — הגרפים מתמלאים מיום ליום', 3400);
  await click(page.locator('.tabs a.tab').filter({ hasText: 'אוטומטי' }).first());
  await page.waitForSelector('.feature.unsupported');
  await show(page.locator('.feature.unsupported'), 500);
  await caption('Follow / Unfollow / לייק לסטורי — Meta לא מאפשרת אוטומציה, ומוצג בשקיפות', 3600);
  await caption('Instagram Niv Bot ✓ — מחברים פעם אחת, והמערכת עובדת לבד', 2800);
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  server.kill('SIGTERM');
  fakeServer.close();
  const webm = await video.path();
  const mp4 = join(outDir, 'niv-bot-connect.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-movflags', '+faststart', mp4]);
  console.log(`video: ${mp4}`);
  rmSync(tmp, { recursive: true, force: true });
}
