/**
 * Records a narrated walkthrough video of the demo workspace (Hebrew captions).
 * Starts its own server with an empty temporary database; never touches Meta.
 * Run: node scripts/record-demo.ts  →  data/demo-video/niv-bot-demo.mp4
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'data', 'demo-video');
const tmp = mkdtempSync(join(tmpdir(), 'nivbot-video-'));
const PORT = 3922;
const base = `http://127.0.0.1:${PORT}`;
mkdirSync(outDir, { recursive: true });

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', PORT: String(PORT), HOST: '127.0.0.1', DATABASE_PATH: join(tmp, 'demo.db'), LOG_LEVEL: 'warn', INSTAGRAM_APP_ID: '', FACEBOOK_APP_ID: '' },
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
await context.route('https://www.instagram.com/**', (r: any) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body style="font:40px sans-serif;display:grid;place-items:center;height:100vh">Instagram</body></html>' }));
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
  await caption('Instagram Niv Bot — אוטומציה לאינסטגרם, רק דרך ה-API הרשמי של Meta', 3200);
  await page.locator('#orgName').pressSequentially('Niv Agency', { delay: 45 });
  await page.locator('#name').pressSequentially('ניב', { delay: 45 });
  await page.locator('#email').pressSequentially('demo@nivbot.app', { delay: 30 });
  await page.fill('#password', 'demo-password-123');
  await click(page.locator('button[type=submit]'));
  await page.waitForSelector('text=בחר איך להתחיל');
  await caption('חיבור חשבון אמיתי — או הדגמה בלחיצה אחת', 2400);
  await click(page.locator('text=🎬 פתיחת חשבון הדגמה').first());
  await page.waitForSelector('text=בשורה התחתונה');
  await sleep(800);
  await caption('🎬 חשבון הדגמה: 90 ימים של נתונים לדוגמה', 2600);
  await show(page.locator('.card:has-text("בשורה התחתונה")'), 400);
  await caption('"בשורה התחתונה" — סיכום השבוע במילים פשוטות', 3400);
  await scroll(330);
  await caption('עוקבים, שינוי יומי, שבועי וחודשי — מנתונים אמיתיים בלבד', 3000);
  await scroll(520);
  await caption('גרפים: צמיחה, עוקבים חדשים, חשיפה, צפיות ומעורבות', 3200);
  await scroll(1150, 20);
  await caption('דוח שבועי: השבוע מול השבוע הקודם', 3000);
  await scroll(800, 16);
  await caption('ביצועי פוסטים ורילס, והשוואה למתחרים', 3200);
  await page.mouse.wheel(0, -6000);
  await sleep(500);

  await click(page.locator('.tabs >> text=✅ מה עובד'));
  await page.waitForSelector('text=מצב בחשבון הזה');
  await caption('שקיפות מלאה: מה אוטומטי דרך ה-API הרשמי של Meta — ומה לא נתמך', 3600);
  await show(page.locator('tr:has(strong:text-is("Follow אוטומטי"))'), 600);
  await caption('Follow, Unfollow ולייקים לסטוריז — אין להם ממשק רשמי ב-Meta, ולכן הם לא אוטומטיים', 4200);
  await scroll(320);
  await caption('נתוני צמיחה, בטיחות חשבון ולייקים לפוסטים — אוטומטיים, ומאומתים בהרצה אמיתית', 3800);
  await page.mouse.wheel(0, -3000);

  await click(page.locator('.tabs >> text=❤️ לייקים אוטומטיים'));
  await page.waitForSelector('text=יומן פעולות');
  await caption('❤️ מנוע לייקים אמיתי (Likes API הרשמי): פוסטים ורילס של קהל היעד', 3800);
  await caption('קצב מבוקר, מגבלה יומית ושעתית, הפעלה ועצירה בכל רגע — וכל פעולה מנוטרת', 3800);
  await scroll(500);
  await sleep(1200);
  await page.mouse.wheel(0, -3000);

  await click(page.locator('.tabs a.tab').filter({ hasText: /^Follow / }));
  await page.waitForSelector('.task-card');
  await caption('Follow / Unfollow: כלי עזר לתיעוד ביצוע ידני בלבד — לא בוט', 3800);

  await click(page.locator('.tabs >> text=📅 פרסום'));
  await page.waitForSelector('text=פרסום חדש');
  await caption('📅 פרסום מתוזמן — אוטומטי לגמרי, דרך ה-API הרשמי', 3200);
  await show(page.locator('.dropzone'), 900);
  await caption('מעלים תמונה או סרטון, כותבים כיתוב, בוחרים שעה — והמערכת מפרסמת לבד', 3400);
  await show(page.locator('.card:has-text("מתוזמנים")').first(), 1200);
  await caption('פוסטים, רילס וסטוריז — רשימת המתוזמנים וההיסטוריה', 2800);

  await click(page.locator('.tabs >> text=💬 מענה אוטומטי'));
  await page.waitForSelector('text=הפעלה בלחיצה');
  await caption('💬 מענה אוטומטי לתגובות ולהודעות — אוטומטי לגמרי', 3200);
  await click(page.locator('.template:has-text("קופון") >> text=➕ הפעלה'));
  await page.waitForSelector('.list-item:has-text("קופון")');
  await caption('תבנית בלחיצה: מי שכותב "קופון" מקבל קוד הנחה בפרטי', 3400);
  await scroll(700);
  await caption('כל תגובה שנשלחה מתועדת — עם הגבלה נגד ספאם', 3200);
  await page.mouse.wheel(0, -4000);

  await click(page.locator('.tabs >> text=Unfollow'));
  await page.waitForSelector('text=כללי הסרת מעקב');
  await caption('Unfollow לפי כללים: רק מי שלא עוקב בחזרה, עם רשימה לבנה', 3200);
  await scroll(420);
  await caption('נתוני עוקבים אמיתיים מקובץ ההורדה הרשמי של אינסטגרם — כולל מי הפסיק לעקוב', 3600);
  await page.mouse.wheel(0, -3000);

  await click(page.locator('.tabs >> text=אוטומציות'));
  await page.waitForSelector('text=מנוע אוטומציות');
  await caption('אוטומציות ברקע — כל אחת ניתנת לעצירה והפעלה בכל רגע', 3400);

  await click(page.locator('.tabs >> text=בטיחות חשבון'));
  await page.waitForSelector('text=אירועי בטיחות');
  await caption('בטיחות: זיהוי מגבלות של Meta, השהיה אוטומטית והקפאה אחרי חסימה', 3400);
  await scroll(500);
  await sleep(1200);

  await click(page.locator('.side >> text=סקירה כללית'));
  await page.waitForSelector('text=השוואת ביצועים');
  await caption('כל החשבונות במקום אחד — מוכן לעבודה עם כמה חשבונות ולקוחות', 3400);
  await caption('Instagram Niv Bot ✓', 2200);
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  server.kill('SIGTERM');
  const webm = await video.path();
  const mp4 = join(outDir, 'niv-bot-demo.mp4');
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-preset', 'medium', '-movflags', '+faststart', mp4]);
    console.log(`video: ${mp4}`);
  } catch {
    renameSync(webm, join(outDir, 'niv-bot-demo.webm'));
    console.log(`video (webm): ${join(outDir, 'niv-bot-demo.webm')}`);
  }
  for (const f of readdirSync(tmp)) if (f.endsWith('.webm')) rmSync(join(tmp, f));
  rmSync(tmp, { recursive: true, force: true });
}
