import { api } from './api.js';
import { h, mount, fmt, delta, dt, ago, toast, statusBadge, loading, action } from './ui.js';
import { accountPage } from './account.js';

const app = document.getElementById('app');
export const state = { me: null, org: null, accounts: [], meta: null };
let pageCleanup = null;

/** Pages can register a cleanup (e.g. stop auto-refresh) that runs on navigation. */
export function onLeave(fn) {
  const prev = pageCleanup;
  pageCleanup = () => {
    prev?.();
    fn();
  };
}

export async function refreshAccounts() {
  state.accounts = await api.get('/api/accounts');
  renderNav();
  return state.accounts;
}

function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(query) };
}

async function boot() {
  const me = await api.get('/api/auth/me').catch(() => ({ user: null }));
  state.me = me.user;
  state.org = me.org;
  state.registrationOpen = me.registrationOpen;
  if (!state.me) return route();
  state.meta = await api.get('/api/meta/status');
  await refreshAccounts();
  route();
}

let shell;
function renderShell() {
  if (shell?.isConnected) return shell;
  const side = h('aside', { class: 'side', id: 'side' });
  const main = h('main', { class: 'main', id: 'main' });
  const topbar = h('div', { class: 'topbar' },
    h('button', { class: 'btn small', 'aria-label': 'תפריט', onclick: () => side.classList.toggle('open') }, '☰'),
    h('strong', {}, 'Instagram Niv Bot'));
  shell = h('div', { class: 'shell' }, side, h('div', {}, topbar, main));
  mount(app, shell);
  app.classList.remove('boot');
  renderNav();
  return shell;
}

function navLink(href, label, active) {
  return h('a', { href, class: ['nav-link', active && 'active'], onclick: () => document.getElementById('side')?.classList.remove('open') }, label);
}

function renderNav() {
  const side = document.getElementById('side');
  if (!side) return;
  const cur = location.hash || '#/';
  mount(side,
    h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'Instagram Niv Bot'),
    navLink('#/', 'סקירה כללית', cur === '#/' || cur === '#'),
    h('div', { class: 'nav-section' }, 'חשבונות'),
    state.accounts.map((a) => navLink(`#/a/${a.id}/autopilot`, h('span', { class: 'row' }, `@${a.username}`, a.is_demo ? h('span', { class: 'badge primary' }, 'הדגמה') : null, a.status !== 'active' ? statusBadge(a.status) : null), cur.startsWith(`#/a/${a.id}`))),
    navLink('#/accounts', '+ חיבור חשבון', cur.startsWith('#/accounts')),
    h('div', { class: 'nav-section' }, 'ארגון'),
    navLink('#/activity', 'יומן פעילות', cur.startsWith('#/activity')),
    navLink('#/team', 'צוות והגדרות', cur.startsWith('#/team')),
    h('div', { class: 'nav-foot' },
      h('div', { class: 'small' }, state.me?.name),
      h('div', { class: 'small muted' }, state.org?.name),
      h('button', { class: 'btn small', onclick: action(async () => { await api.post('/api/auth/logout'); location.hash = '#/login'; location.reload(); }) }, 'התנתקות')),
  );
}

async function route() {
  pageCleanup?.();
  pageCleanup = null;
  const { parts, query } = parseRoute();
  if (!state.me) return authPage(parts[0] === 'register' && state.registrationOpen ? 'register' : 'login');
  if (parts[0] === 'login' || parts[0] === 'register') {
    location.hash = '#/';
    return;
  }
  renderShell();
  renderNav();
  const main = document.getElementById('main');
  mount(main, loading());
  window.scrollTo(0, 0);
  try {
    if (!parts.length) await overviewPage(main);
    else if (parts[0] === 'accounts') await connectPage(main, query);
    else if (parts[0] === 'a' && parts[1]) await accountPage(main, parts[1], parts[2] || 'growth', query);
    else if (parts[0] === 'activity') await activityPage(main);
    else if (parts[0] === 'team') await teamPage(main);
    else mount(main, h('div', { class: 'empty' }, 'הדף לא נמצא'));
  } catch (err) {
    if (err.status !== 401) mount(main, h('div', { class: 'alert bad' }, err.message || 'שגיאה בטעינת הדף'));
  }
}

// ───────────── Auth ─────────────
function authPage(mode) {
  const isReg = mode === 'register';
  const err = h('div', { class: 'alert bad hidden' });
  const form = h('form', { class: 'card auth-card stack' },
    h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'Instagram Niv Bot'),
    h('h1', {}, isReg ? 'יצירת חשבון ארגון' : 'התחברות'),
    isReg ? h('div', { class: 'field' }, h('label', { for: 'orgName' }, 'שם העסק / הסוכנות'), h('input', { id: 'orgName', name: 'orgName', required: true, maxlength: 80 })) : null,
    isReg ? h('div', { class: 'field' }, h('label', { for: 'name' }, 'שם מלא'), h('input', { id: 'name', name: 'name', required: true, maxlength: 80 })) : null,
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'אימייל'), h('input', { id: 'email', name: 'email', type: 'email', required: true, autocomplete: 'email', class: 'ltr' })),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'סיסמה'), h('input', { id: 'password', name: 'password', type: 'password', required: true, minlength: isReg ? 10 : 1, autocomplete: isReg ? 'new-password' : 'current-password' }),
      isReg ? h('div', { class: 'small muted' }, 'לפחות 10 תווים') : null),
    err,
    h('button', { class: 'btn primary big', type: 'submit' }, isReg ? 'יצירת חשבון' : 'כניסה'),
    h('div', { class: 'small muted' }, isReg ? h('a', { href: '#/login' }, 'כבר יש לך חשבון? התחברות') : state.registrationOpen ? h('a', { href: '#/register' }, 'ארגון חדש? הרשמה') : null),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    const data = Object.fromEntries(new FormData(form));
    try {
      await api.post(isReg ? '/api/auth/register' : '/api/auth/login', data);
      location.hash = '#/';
      location.reload();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  });
  app.classList.remove('boot');
  mount(app, h('div', { class: 'auth-wrap' }, form));
}

// ───────────── Overview ─────────────
async function overviewPage(main) {
  const [rows, sys] = await Promise.all([api.get('/api/analytics/compare'), api.get('/api/system/status'), refreshAccounts()]);
  const accounts = state.accounts;
  if (!accounts.length) {
    mount(main, h('div', { class: 'card empty' },
      h('h2', {}, 'ברוך הבא ל-Instagram Niv Bot'),
      h('p', {}, 'בחר איך להתחיל:'),
      h('div', { class: 'row center' },
        h('a', { class: 'btn primary big', href: '#/accounts' }, '🔗 חיבור חשבון Instagram אמיתי'),
        demoButton('big'))));
    return;
  }
  const totalFollowers = rows.reduce((a, r) => a + (r.followers || 0), 0);
  const totalPending = accounts.reduce((a, acc) => a + ['follow', 'unfollow', 'story_like'].reduce((s, t) => s + (acc.tasks[t].byStatus.pending || 0), 0), 0);
  const anyActive = accounts.some((a) => a.status === 'active');
  mount(main,
    h('div', { class: 'row between' }, h('h1', {}, 'סקירה כללית'),
      h('div', { class: 'row' },
        anyActive
          ? h('button', { class: 'btn danger', onclick: action(async () => { if (!confirm('לעצור את כל האוטומציות בכל החשבונות?')) return; await api.post('/api/accounts/pause-all'); route(); }, 'כל החשבונות הושהו') }, '⏸ עצירת הכל')
          : h('button', { class: 'btn', onclick: action(async () => { await api.post('/api/accounts/resume-all'); route(); }, 'החשבונות חודשו') }, '▶ חידוש הכל'))),
    h('div', { class: 'grid k4' },
      kpi('חשבונות מחוברים', fmt(accounts.length)),
      kpi('סה״כ עוקבים', fmt(totalFollowers)),
      kpi('משימות ידניות להיום', fmt(totalPending)),
      kpi('קריאות API (24ש׳)', fmt(sys.api24h.total), sys.api24h.errors ? h('span', { class: 'badge warn' }, `${sys.api24h.errors} שגיאות`) : h('span', { class: 'badge good' }, 'תקין'))),
    h('div', { class: 'card' },
      h('h2', {}, 'השוואת ביצועים'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['חשבון', 'סטטוס', 'עוקבים', '7 ימים', '30 ימים', 'חשיפה 7 ימים', 'מעורבות'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map((r) => h('tr', {},
          h('td', {}, h('a', { href: `#/a/${r.id}/growth` }, `@${r.username}`), r.isDemo ? h('span', { class: 'badge primary' }, ' הדגמה') : null),
          h('td', {}, statusBadge(r.status)),
          h('td', { class: 'num' }, fmt(r.followers)),
          h('td', {}, delta(r.change7d)),
          h('td', {}, delta(r.change30d)),
          h('td', { class: 'num' }, fmt(r.reach7d)),
          h('td', { class: 'num' }, r.engagementRate === null ? '—' : `${r.engagementRate}%`))))))),
    h('div', { class: 'grid k2' }, accounts.map((a) => accountCard(a))),
    h('div', { class: 'card small muted' },
      `תור משימות: ${fmt(sys.queue.queued || 0)} ממתינות · ${fmt(sys.queue.running || 0)} רצות · ${fmt(sys.queue.failed || 0)} נכשלו (24ש׳) · `,
      sys.worker ? `מנוע רקע פעיל (${ago(sys.worker.lastTickAt)})` : 'מנוע רקע חיצוני'),
  );
}

function demoButton(size = '') {
  return h('button', { class: ['btn', size], onclick: action(async () => {
    const r = await api.post('/api/demo');
    await refreshAccounts();
    location.hash = `#/a/${r.id}/autopilot`;
  }) }, '🎬 פתיחת חשבון הדגמה');
}

function kpi(label, value, extra) {
  return h('div', { class: 'card kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value num' }, value), extra || null);
}

function accountCard(a) {
  const t = a.tasks;
  const line = (label, x) => {
    const done = x.byStatus.done || 0;
    const total = Object.entries(x.byStatus).filter(([k]) => !['cancelled', 'expired'].includes(k)).reduce((s, [, n]) => s + n, 0);
    const bar = h('span');
    bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    return h('div', { class: 'field' }, h('div', { class: 'row between small' }, h('span', {}, label), h('span', { class: 'num muted' }, `${done}/${total}`)), h('div', { class: 'progress' }, bar));
  };
  return h('div', { class: 'card' },
    h('div', { class: 'row' },
      a.profile_picture_url ? h('img', { class: 'avatar', src: a.profile_picture_url, alt: '' }) : h('div', { class: 'avatar' }),
      h('div', {}, h('a', { href: `#/a/${a.id}/growth` }, h('strong', {}, `@${a.username}`)), h('div', { class: 'small muted' }, a.provider === 'facebook_login' ? 'Facebook Login' : 'Instagram Login')),
      h('span', { class: 'spacer' }), a.is_demo ? h('span', { class: 'badge primary' }, 'הדגמה') : null, statusBadge(a.status)),
    h('div', { class: 'row', }, h('span', { class: 'kpi' }, h('span', { class: 'value num' }, fmt(a.summary.followers))), h('span', { class: 'muted small' }, 'עוקבים'), delta(a.summary.change1d), h('span', { class: 'small muted' }, 'היום')),
    a.last_error && a.status !== 'active' ? h('div', { class: 'alert bad small' }, a.last_error) : null,
    h('h3', {}, 'משימות ידניות היום (לא אוטומטי)'),
    line('Follow', t.follow), line('Unfollow', t.unfollow), line('לייקים לסטוריז', t.story_like),
    h('div', { class: 'row between' }, h('span', { class: 'small muted' }, `סנכרון אחרון: ${ago(a.last_synced_at)}`),
      h('a', { class: 'btn primary', href: `#/a/${a.id}/autopilot` }, '🚀 אוטומטי')));
}

// ───────────── Connect ─────────────
async function connectPage(main, query) {
  const meta = state.meta;
  const flash = query.get('connected') ? h('div', { class: 'alert good' }, `החשבון חובר בהצלחה: @${query.get('connected')}. הסנכרון הראשוני רץ ברקע.`)
    : query.get('error') ? h('div', { class: 'alert bad' }, `החיבור נכשל: ${query.get('error')}`) : null;
  if (query.get('connected')) await refreshAccounts();
  const canAdmin = ['owner', 'admin'].includes(state.me.role);
  const provider = (p, title, desc) => {
    const cfg = meta.providers[p];
    return h('div', { class: 'card' },
      h('h3', {}, title), h('p', { class: 'small muted' }, desc),
      h('div', { class: 'small' }, 'הרשאות: ', cfg.scopes.map((s) => h('code', {}, s)).reduce((a, c) => (a.length ? [...a, ' ', c] : [c]), [])),
      cfg.configured
        ? h('a', { class: ['btn primary', !canAdmin && 'hidden'], href: `/api/oauth/${p}/start` }, 'חיבור עם Meta')
        : h('div', { class: 'alert warn small' }, 'לא הוגדר עדיין — יש להגדיר מזהה וסוד אפליקציה של Meta בשרת (ראה README). בינתיים ניתן לחבר עם טוקן.'),
      h('div', { class: 'small muted' }, 'Redirect URI: ', h('code', {}, cfg.redirectUri)));
  };
  const tokenForm = h('form', { class: 'card stack' },
    h('h3', {}, 'חיבור עם טוקן גישה'),
    h('p', { class: 'small muted' }, 'טוקן שהופק ב-Meta App Dashboard (Instagram API → Generate token) או ב-Graph API Explorer. הטוקן נשמר מוצפן (AES-256-GCM) ואינו מוצג שוב.'),
    h('div', { class: 'field' }, h('label', {}, 'סוג חיבור'), h('select', { name: 'provider' }, h('option', { value: 'instagram_login' }, 'Instagram Login (graph.instagram.com)'), h('option', { value: 'facebook_login' }, 'Facebook Login (graph.facebook.com)'))),
    h('div', { class: 'field' }, h('label', {}, 'Access Token'), h('input', { name: 'token', required: true, autocomplete: 'off', class: 'ltr', type: 'password' })),
    h('button', { class: 'btn primary', type: 'submit', disabled: !canAdmin }, 'אימות וחיבור'));
  tokenForm.addEventListener('submit', action(async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(tokenForm));
    const r = await api.post('/api/accounts/connect-token', data);
    toast(`חובר: ${r.accounts.map((a) => '@' + a.username).join(', ')}`, 'good');
    await refreshAccounts();
    location.hash = `#/a/${r.accounts[0].id}/autopilot`;
  }));

  mount(main,
    h('h1', {}, 'חיבור חשבונות Instagram'),
    flash,
    h('div', { class: 'alert info small' }, 'נדרש חשבון Instagram מקצועי (Business או Creator). המערכת עובדת רק דרך ה-API הרשמי של Meta ואינה מבקשת סיסמת אינסטגרם.'),
    h('div', { class: 'grid k2' },
      provider('instagram_login', 'Instagram Login (מומלץ)', 'חיבור ישיר לחשבון אינסטגרם מקצועי, ללא צורך בדף פייסבוק. כולל נתוני פרופיל, Insights, פוסטים וסטוריז.'),
      provider('facebook_login', 'Facebook Login', 'לחשבונות המקושרים לדף פייסבוק. מוסיף Business Discovery: מחקר קהל יעד ומעקב מתחרים.')),
    tokenForm,
    h('div', { class: 'card row between' },
      h('div', {}, h('h3', {}, 'רק רוצה לראות איך זה נראה?'), h('div', { class: 'small muted' }, 'חשבון הדגמה עם 90 ימי נתונים לדוגמה — מסומן "הדגמה", לא מחובר לאינסטגרם, ונמחק בלחיצה.')),
      demoButton()),
    h('div', { class: 'card' },
      h('h2', {}, 'מה המערכת יכולה לעשות — לפי הרשאות Meta הרשמיות'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'יכולת'), h('th', {}, 'אופן ביצוע'), h('th', { class: 'hide-sm' }, 'פירוט'))),
        h('tbody', {}, meta.capabilities.map((c) => h('tr', {},
          h('td', {}, h('strong', {}, c.title)),
          h('td', {}, c.support === 'not_supported' ? h('span', { class: 'badge bad' }, '❌ לא נתמך ע״י Meta') : c.providers.length === 1 ? h('span', { class: 'badge primary' }, '✅ אוטומטי — Facebook Login בלבד') : h('span', { class: 'badge good' }, '✅ אוטומטי (API רשמי)')),
          h('td', { class: 'small muted hide-sm' }, c.note))))))),
  );
}

// ───────────── Activity / Team ─────────────
export function activityList(rows) {
  if (!rows.length) return h('div', { class: 'empty' }, 'אין פעילות עדיין');
  return h('div', {}, rows.map((r) => h('div', { class: 'list-item' },
    h('span', { class: 'dot info' }),
    h('div', { class: 'spacer' },
      h('div', {}, actionLabel(r.action), r.details?.username ? h('span', { class: 'ltr' }, ` @${r.details.username}`) : null, r.account_username ? h('span', { class: 'muted small' }, ` · @${r.account_username}`) : null),
      h('div', { class: 'small muted' }, `${dt(r.created_at)} · ${r.user_name || 'מערכת'}`, r.details?.forced ? ' · אושר מעבר למגבלה' : '')))));
}

const ACTIONS = {
  'account.connected': 'חשבון חובר', 'account.reconnected': 'חשבון חובר מחדש', 'account.deleted': 'חשבון נמחק', 'account.paused': 'חשבון הושהה',
  'account.resumed': 'חשבון חודש', 'account.settings_updated': 'הגדרות עודכנו', 'targets.added': 'יעדים נוספו', 'targets.updated': 'יעדים עודכנו',
  'targets.deleted': 'יעדים נמחקו', 'manual.planned': 'תוכנית יומית נוצרה', 'relationships.imported': 'קובץ עוקבים יובא', 'automation.updated': 'אוטומציה עודכנה',
  'automation.run_now': 'הרצה ידנית של משימה', 'safety.action_block_reported': 'דווחה חסימת פעולות', 'safety.cooldown_cleared': 'הקפאה בוטלה',
  'org.created': 'הארגון נוצר', 'org.member_added': 'משתמש נוסף',
};
const MANUAL = { follow: 'Follow', unfollow: 'Unfollow', story_like: 'לייק לסטורי' };
const OUT = { done: 'בוצע', skipped: 'דולג', failed: 'נכשל', no_story: 'אין סטורי', not_found: 'לא נמצא' };
function actionLabel(a) {
  const m = a.match(/^manual\.(follow|unfollow|story_like)\.(\w+)$/);
  if (m) return `${MANUAL[m[1]]} — ${OUT[m[2]] || m[2]}`;
  return ACTIONS[a] || a;
}

async function activityPage(main) {
  const rows = await api.get('/api/activity?limit=200');
  mount(main, h('h1', {}, 'יומן פעילות'), h('div', { class: 'card' }, activityList(rows)));
}

async function teamPage(main) {
  const members = await api.get('/api/org/members');
  const canAdmin = ['owner', 'admin'].includes(state.me.role);
  const form = h('form', { class: 'card stack' },
    h('h2', {}, 'הוספת משתמש'),
    h('div', { class: 'grid k2' },
      h('div', { class: 'field' }, h('label', {}, 'שם'), h('input', { name: 'name', required: true })),
      h('div', { class: 'field' }, h('label', {}, 'אימייל'), h('input', { name: 'email', type: 'email', required: true, class: 'ltr' })),
      h('div', { class: 'field' }, h('label', {}, 'סיסמה ראשונית'), h('input', { name: 'password', type: 'password', minlength: 10, required: true })),
      h('div', { class: 'field' }, h('label', {}, 'תפקיד'), h('select', { name: 'role' }, h('option', { value: 'member' }, 'מפעיל (ביצוע משימות וצפייה)'), h('option', { value: 'admin' }, 'מנהל')))),
    h('button', { class: 'btn primary', type: 'submit' }, 'הוספה'));
  form.addEventListener('submit', action(async (e) => {
    e.preventDefault();
    await api.post('/api/org/members', Object.fromEntries(new FormData(form)));
    toast('המשתמש נוסף', 'good');
    route();
  }));
  const pw = h('form', { class: 'card stack' },
    h('h2', {}, 'שינוי סיסמה'),
    h('div', { class: 'grid k2' },
      h('div', { class: 'field' }, h('label', {}, 'סיסמה נוכחית'), h('input', { name: 'current', type: 'password', required: true })),
      h('div', { class: 'field' }, h('label', {}, 'סיסמה חדשה'), h('input', { name: 'next', type: 'password', minlength: 10, required: true }))),
    h('button', { class: 'btn', type: 'submit' }, 'עדכון'));
  pw.addEventListener('submit', action(async (e) => {
    e.preventDefault();
    await api.post('/api/auth/password', Object.fromEntries(new FormData(pw)));
    pw.reset();
  }, 'הסיסמה עודכנה'));
  const ROLE = { owner: 'בעלים', admin: 'מנהל', member: 'מפעיל' };
  mount(main,
    h('h1', {}, 'צוות והגדרות'),
    h('div', { class: 'card' }, h('h2', {}, state.org?.name),
      h('table', {}, h('thead', {}, h('tr', {}, ['שם', 'אימייל', 'תפקיד', 'כניסה אחרונה'].map((t) => h('th', {}, t)))),
        h('tbody', {}, members.map((m) => h('tr', {}, h('td', {}, m.name), h('td', { class: 'ltr' }, m.email), h('td', {}, ROLE[m.role]), h('td', { class: 'small muted' }, ago(m.last_login_at))))))),
    canAdmin ? form : null, pw);
}

window.addEventListener('hashchange', route);
boot();
