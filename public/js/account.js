import { api } from './api.js';
import { h, mount, fmt, delta, signed, dt, ago, countdown, toast, statusBadge, loading, action, lineChart, barChart } from './ui.js';
import { state, refreshAccounts, onLeave, activityList } from './app.js';

const TABS = [
  ['growth', 'צמיחה ונתונים'],
  ['follow', 'Follow'],
  ['unfollow', 'Unfollow'],
  ['stories', 'סטוריז'],
  ['automation', 'אוטומציות'],
  ['safety', 'בטיחות חשבון'],
  ['activity', 'היסטוריה'],
  ['settings', 'הגדרות'],
];

export async function accountPage(main, id, tab, query) {
  const { account, settings, summary } = await api.get(`/api/accounts/${id}`);
  const isAdmin = ['owner', 'admin'].includes(state.me.role);
  const body = h('div', {}, loading());
  const paused = account.status === 'paused' || account.status === 'restricted';
  mount(main,
    h('div', { class: 'acct-head' },
      account.profile_picture_url ? h('img', { class: 'avatar lg', src: account.profile_picture_url, alt: '' }) : h('div', { class: 'avatar lg' }),
      h('div', {},
        h('h1', { class: 'ltr' }, `@${account.username}`),
        h('div', { class: 'row small muted' }, statusBadge(account.status), h('span', {}, [account.name, `${fmt(summary.followers)} עוקבים`, `סונכרן ${ago(account.last_synced_at)}`].filter(Boolean).join(' · ')))),
      h('span', { class: 'spacer' }),
      account.status === 'needs_reauth'
        ? h('a', { class: 'btn primary', href: '#/accounts' }, 'חיבור מחדש')
        : paused
          ? h('button', { class: 'btn good', onclick: action(async () => { await api.post(`/api/accounts/${id}/resume`); await refreshAccounts(); rerender(); }, 'החשבון חודש') }, '▶ חידוש פעילות')
          : h('button', { class: 'btn danger', onclick: action(async () => { await api.post(`/api/accounts/${id}/pause`, {}); await refreshAccounts(); rerender(); }, 'כל הפעולות הושהו') }, '⏸ השהיית חשבון')),
    account.status === 'needs_reauth' ? h('div', { class: 'alert bad' }, 'ההרשאה לחשבון פגה או בוטלה ב-Meta. כל המשימות האוטומטיות נעצרו. יש לחבר מחדש את החשבון.') : null,
    paused ? h('div', { class: 'alert warn' }, `החשבון מושהה: ${account.pause_reason || ''}${account.paused_until ? ` · חידוש אוטומטי ב-${dt(account.paused_until)}` : ''}`) : null,
    account.manual_cooldown_until && account.manual_cooldown_until > Date.now() ? h('div', { class: 'alert bad' }, `הקפאת בטיחות לפעולות ידניות עד ${dt(account.manual_cooldown_until)} (דווחה חסימה מאינסטגרם).`) : null,
    h('nav', { class: 'tabs' }, TABS.map(([k, label]) => h('a', { class: ['tab', k === tab && 'active'], href: `#/a/${id}/${k}` }, label))),
    body,
  );
  const ctx = { id, account, settings, isAdmin, query };
  const pages = { growth: growthTab, follow: (b, c) => manualTab(b, c, 'follow'), unfollow: unfollowTab, stories: storiesTab, automation: automationTab, safety: safetyTab, activity: activityTab, settings: settingsTab };
  await (pages[tab] || growthTab)(body, ctx);
}

const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

// ───────────── Growth analytics ─────────────
async function growthTab(body, { id, account }) {
  const days = Number(sessionStorage.getItem('nb_days') || 30);
  const [an, media, comps] = await Promise.all([
    api.get(`/api/accounts/${id}/analytics?days=${days}`),
    api.get(`/api/accounts/${id}/media?type=feed&limit=12`),
    account.provider === 'facebook_login' ? api.get(`/api/accounts/${id}/competitors`) : Promise.resolve(null),
  ]);
  const s = an.summary;
  const pts = (k) => an.series.map((d) => ({ x: d.day, y: d[k] ?? null }));
  const hasAny = (k) => an.series.some((d) => typeof d[k] === 'number');
  const rangeBtn = (n) => h('button', { class: ['chip', n === days && 'active'], onclick: () => { sessionStorage.setItem('nb_days', n); rerender(); } }, `${n} יום`);
  const chartCard = (title, el, note) => h('div', { class: 'card' }, h('h3', {}, title), el, note ? h('div', { class: 'small muted' }, note) : null);

  mount(body,
    h('div', { class: 'grid k4' },
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'עוקבים'), h('div', { class: 'value num' }, fmt(s.followers)), h('div', { class: 'small muted' }, `נעקבים: ${fmt(s.follows)} · פוסטים: ${fmt(s.media)}`)),
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'שינוי יומי'), h('div', { class: 'value' }, delta(s.change1d))),
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'שינוי שבועי'), h('div', { class: 'value' }, delta(s.change7d))),
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'שינוי חודשי'), h('div', { class: 'value' }, delta(s.change30d)))),
    s.trackingSince ? h('div', { class: 'small muted' }, `מעקב עוקבים פעיל מאז ${dt(s.trackingSince)}. שינוי מוצג רק כשקיים צילום מצב אמיתי מהתקופה המבוקשת.`)
      : h('div', { class: 'alert info small' }, 'הסנכרון הראשון עדיין לא הושלם. הנתונים יופיעו תוך דקות.'),
    h('div', { class: 'row' }, h('div', { class: 'chips' }, [7, 30, 90, 180].map(rangeBtn)), h('span', { class: 'spacer' }),
      h('a', { class: 'btn small', href: `/api/accounts/${id}/reports/daily.csv?days=${days}` }, '⬇ דוח CSV')),
    h('div', { class: 'grid k2' },
      chartCard('מספר עוקבים', lineChart(pts('followers_count'))),
      chartCard('שינוי נטו יומי בעוקבים', barChart(pts('net_change'), { signedColors: true })),
      hasAny('new_followers') ? chartCard('עוקבים חדשים ליום (Meta Insights)', barChart(pts('new_followers'))) : null,
      hasAny('follows') || hasAny('unfollows') ? chartCard('התחילו / הפסיקו לעקוב (Meta)', h('div', {}, barChart(an.series.map((d) => ({ x: d.day, y: d.follows === undefined && d.unfollows === undefined ? null : (d.follows || 0) - (d.unfollows || 0) })), { signedColors: true })), 'עקבו פחות הפסיקו לעקוב, לפי follows_and_unfollows') : null,
      chartCard('חשיפה (Reach)', lineChart(pts('reach'))),
      chartCard('צפיות', lineChart(pts('views'))),
      chartCard('אינטראקציות', barChart(pts('total_interactions'))),
      chartCard('חשבונות מעורבים', lineChart(pts('accounts_engaged')))),
    an.unsupported.length ? h('div', { class: 'alert warn small' }, `מדדים שאינם זמינים לחשבון זה לפי Meta: ${an.unsupported.join(', ')}`) : null,
    h('div', { class: 'card' },
      h('h2', {}, 'דוח שבועי — 7 ימים אחרונים מול 7 הקודמים'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['מדד', 'השבוע', 'שבוע קודם', 'שינוי'].map((t) => h('th', {}, t)))),
        h('tbody', {}, an.weekly.filter((r) => r.current !== null || r.previous !== null).map((r) => h('tr', {},
          h('td', {}, r.label), h('td', { class: 'num' }, r.metric === 'net_change' ? signed(r.current) : fmt(r.current)), h('td', { class: 'num muted' }, r.metric === 'net_change' ? signed(r.previous) : fmt(r.previous)),
          h('td', {}, r.deltaPct === null ? '—' : delta(r.deltaPct, '%')))))))),
    h('div', { class: 'card' },
      h('h2', {}, 'פוסטים אחרונים וביצועים'),
      media.length ? h('div', { class: 'media-grid' }, media.map(mediaItem)) : h('div', { class: 'empty' }, 'אין פוסטים מסונכרנים עדיין')),
    comps ? competitorsCard(id, comps) : null,
  );
}

function mediaItem(m) {
  const i = m.insights || {};
  return h('a', { class: 'media-item', href: m.permalink || '#', target: '_blank', rel: 'noopener' },
    m.thumbnail_url ? h('img', { src: m.thumbnail_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('img', { alt: '' }),
    h('div', { class: 'meta' },
      h('div', { class: 'muted' }, dt(m.posted_at)),
      h('div', {}, `❤ ${fmt(m.like_count ?? i.likes)} · 💬 ${fmt(m.comments_count ?? i.comments)}`),
      i.reach !== undefined ? h('div', {}, `חשיפה ${fmt(i.reach)}`) : null,
      i.views !== undefined ? h('div', {}, `צפיות ${fmt(i.views)}`) : null,
      i.saved !== undefined ? h('div', {}, `שמירות ${fmt(i.saved)} · שיתופים ${fmt(i.shares)}`) : null,
      i.replies !== undefined ? h('div', {}, `תגובות לסטורי ${fmt(i.replies)}`) : null));
}

function competitorsCard(id, comps) {
  const input = h('input', { placeholder: 'שם משתמש של מתחרה (עסקי/יוצר)', class: 'ltr' });
  return h('div', { class: 'card' },
    h('h2', {}, 'השוואה למתחרים (Business Discovery)'),
    h('div', { class: 'row' }, input, h('button', { class: 'btn', onclick: action(async () => { await api.post(`/api/accounts/${id}/competitors`, { username: input.value }); rerender(); }, 'נוסף — הנתונים ייאספו ברקע') }, 'הוספה')),
    comps.length ? h('table', {}, h('thead', {}, h('tr', {}, ['חשבון', 'עוקבים', '7 ימים', '30 ימים', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, comps.map((c) => h('tr', {},
        h('td', { class: 'ltr' }, `@${c.username}`, c.last_error ? h('div', { class: 'small bad' }, c.last_error) : null),
        h('td', { class: 'num' }, fmt(c.followers)), h('td', {}, delta(c.change7d)), h('td', {}, delta(c.change30d)),
        h('td', {}, h('button', { class: 'btn small', onclick: action(async () => { await api.del(`/api/accounts/${id}/competitors/${c.username}`); rerender(); }) }, 'הסרה'))))))
      : h('div', { class: 'empty small' }, 'לא הוגדרו מתחרים'));
}

// ───────────── Manual workflows ─────────────
const TYPE_INFO = {
  follow: { title: 'Follow — מעקב אחרי קהל יעד', verb: 'לעקוב אחרי', doneLabel: '✓ עקבתי', openLabel: 'פתיחת הפרופיל באינסטגרם' },
  unfollow: { title: 'Unfollow — הסרת מעקב לפי כללים', verb: 'להסיר מעקב מ-', doneLabel: '✓ הסרתי מעקב', openLabel: 'פתיחת הפרופיל באינסטגרם' },
  story_like: { title: 'לייקים לסטוריז', verb: 'לעשות לייק לסטורי של', doneLabel: '✓ עשיתי לייק', openLabel: 'פתיחת הסטורי באינסטגרם' },
};
const SKIP_REASONS = {
  limit_reached: 'הגעת למגבלה היומית', needs_relationship_import: 'נדרש ייבוא קובץ עוקבים מאינסטגרם', no_candidates: 'אין יעדים מתאימים', cooldown: 'הקפאת בטיחות', account_paused: 'החשבון מושהה',
};

function manualNotice() {
  return h('div', { class: 'alert warn small' },
    'ל-Meta אין API רשמי לפעולה זו. המערכת מתכננת רשימה יומית בקצב בטוח, פותחת עבורך את אינסטגרם, ומתעדת רק פעולות שאישרת שבוצעו בפועל. המערכת לא מבצעת את הפעולה בעצמה ולא עוקפת מנגנוני הגנה.');
}

/** The guided "work mode" card used by Follow / Unfollow / Story likes. */
function taskRunner(id, type, onChange) {
  const box = h('div', { class: 'card task-card' }, loading());
  let timer;
  onLeave(() => clearInterval(timer));
  const info = TYPE_INFO[type];
  async function load() {
    clearInterval(timer);
    const { task, gate } = await api.get(`/api/accounts/${id}/tasks/next?type=${type}`);
    const counter = h('div', { class: 'small muted' }, `בוצעו היום ${gate.doneToday} מתוך ${gate.dailyLimit} · בשעה האחרונה ${gate.doneLastHour}/${gate.hourlyLimit}`);
    if (!task) {
      mount(box, h('h3', {}, 'אין משימות ממתינות להיום'), counter,
        h('button', { class: 'btn', onclick: action(async () => { const r = await api.post(`/api/accounts/${id}/tasks/plan`); const n = r.planned[type] || 0; toast(n ? `נוספו ${n} משימות` : SKIP_REASONS[r.skipped[type]] || 'אין משימות חדשות'); await load(); onChange?.(); }) }, 'תכנון משימות עכשיו'));
      return;
    }
    let opened = false;
    const doneBtn = h('button', { class: 'btn good big', disabled: true }, info.doneLabel);
    const gateMsg = h('div', { class: 'small' });
    const tick = () => {
      if (gate.allowed || !gate.nextAllowedAt || gate.nextAllowedAt <= Date.now()) {
        if (!gate.allowed && gate.nextAllowedAt && gate.nextAllowedAt <= Date.now()) return load();
        gateMsg.textContent = opened ? '' : 'פתח את אינסטגרם, בצע את הפעולה, ואז אשר כאן.';
        doneBtn.disabled = !opened || !gate.allowed;
      } else {
        gateMsg.textContent = `⏳ ${gate.reason} — אפשר להמשיך בעוד ${countdown(gate.nextAllowedAt)}`;
        doneBtn.disabled = true;
      }
    };
    const complete = (outcome, extra = {}) => action(async () => {
      try {
        await api.post(`/api/tasks/${task.id}/complete`, { outcome, ...extra });
      } catch (e) {
        if (e.status === 409 && outcome === 'done' && confirm(`${e.message}\n\nהפעולה כבר בוצעה באינסטגרם? אישור יתועד עם אזהרת בטיחות.`)) {
          await api.post(`/api/tasks/${task.id}/complete`, { outcome, force: true });
        } else throw e;
      }
      await load();
      onChange?.();
    });
    doneBtn.addEventListener('click', complete('done'));
    mount(box,
      h('div', { class: 'small muted' }, `${info.verb}`),
      h('div', { class: 'handle' }, `@${task.username}`),
      h('div', { class: 'small muted' }, task.reason),
      h('div', { class: 'row', }, h('span', { class: 'spacer' }),
        h('a', { class: 'btn primary big', href: task.link, target: '_blank', rel: 'noopener', onclick: () => { opened = true; tick(); } }, `↗ ${info.openLabel}`), h('span', { class: 'spacer' })),
      gateMsg,
      h('div', { class: 'task-actions' },
        doneBtn,
        h('button', { class: 'btn', onclick: complete('skipped') }, 'דילוג'),
        type === 'story_like' ? h('button', { class: 'btn', onclick: complete('no_story') }, 'אין סטורי פעיל') : h('button', { class: 'btn', onclick: complete('not_found') }, 'החשבון לא קיים'),
        h('button', { class: 'btn danger', onclick: complete('failed') }, 'נכשל')),
      counter,
      h('div', { class: 'small muted' }, 'אינסטגרם הציג "נסה שוב מאוחר יותר" או חסימה? ', h('a', { href: `#/a/${id}/safety` }, 'דווח מיד בעמוד הבטיחות')));
    tick();
    timer = setInterval(tick, 1000);
  }
  load().catch((e) => mount(box, h('div', { class: 'alert bad' }, e.message)));
  return box;
}

async function todayList(id, type) {
  const rows = await api.get(`/api/accounts/${id}/tasks?type=${type}`);
  const ST = { pending: ['ממתין', ''], done: ['בוצע', 'good'], skipped: ['דולג', ''], failed: ['נכשל', 'bad'], no_story: ['אין סטורי', ''], not_found: ['לא נמצא', 'warn'], expired: ['פג תוקף', ''], cancelled: ['בוטל', 'warn'] };
  return h('div', { class: 'card' }, h('h3', {}, `רשימת היום (${rows.length})`),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', {}, h('a', { href: r.link, target: '_blank', rel: 'noopener', class: 'ltr' }, `@${r.username}`)),
      h('td', { class: 'small muted hide-sm' }, r.reason),
      h('td', {}, h('span', { class: `badge ${ST[r.status][1]}` }, ST[r.status][0])),
      h('td', { class: 'small muted' }, r.completed_at ? `${dt(r.completed_at)} · ${r.completed_by_name || ''}` : '')))))) : h('div', { class: 'empty small' }, 'אין משימות להיום'));
}

function targetsManager(id, defaults) {
  const wrap = h('div', { class: 'card' });
  let filter = defaults.filter;
  let page = 1;
  let q = '';
  const selected = new Set();
  const FILTERS = { to_follow: 'לעקוב', following: 'נעקבים', non_followers: 'לא עוקבים בחזרה', mutual: 'הדדיים', followers: 'עוקבים שלי', stories: 'מעורבות בסטוריז', whitelist: 'רשימה לבנה', all: 'הכל' };
  async function load() {
    const [data, counts] = await Promise.all([
      api.get(`/api/accounts/${id}/targets?filter=${filter}&page=${page}&q=${encodeURIComponent(q)}`),
      api.get(`/api/accounts/${id}/targets/counts`),
    ]);
    selected.clear();
    const bulk = (patch, msg) => action(async () => {
      if (!selected.size) throw new Error('לא נבחרו חשבונות');
      await api.patch('/api/targets', { ids: [...selected], patch });
      await load();
    }, msg);
    const search = h('input', { placeholder: 'חיפוש שם משתמש', value: q, class: 'ltr' });
    search.addEventListener('change', () => { q = search.value; page = 1; load(); });
    const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
    mount(wrap,
      h('h3', {}, 'קהל יעד וקשרים'),
      h('div', { class: 'chips' }, defaults.filters.map((f) => h('button', { class: ['chip', f === filter && 'active'], onclick: () => { filter = f; page = 1; load(); } }, `${FILTERS[f]} (${fmt(counts[f])})`))),
      h('div', { class: 'row', }, search,
        h('button', { class: 'btn small', onclick: bulk({ whitelisted: true }, 'נוסף לרשימה הלבנה') }, '★ רשימה לבנה'),
        h('button', { class: 'btn small', onclick: bulk({ whitelisted: false }) }, 'הסרה מהלבנה'),
        h('button', { class: 'btn small', onclick: bulk({ follow_wanted: true }, 'סומנו למעקב') }, '+ לעקוב'),
        h('button', { class: 'btn small', onclick: bulk({ engage_stories: true }, 'סומנו לסטוריז') }, '+ סטוריז'),
        h('button', { class: 'btn small danger', onclick: action(async () => { if (!selected.size || !confirm(`למחוק ${selected.size} חשבונות מהרשימה?`)) return; await api.post('/api/targets/delete', { ids: [...selected] }); await load(); }) }, 'מחיקה')),
      data.items.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, h('input', { type: 'checkbox', onchange: (e) => { wrap.querySelectorAll('tbody input[type=checkbox]').forEach((c) => { c.checked = e.target.checked; c.dispatchEvent(new Event('change')); }); } })), ['חשבון', 'קבוצה', 'מצב', 'עוקבים', 'עקבתי ב-'].map((t) => h('th', {}, t)))),
        h('tbody', {}, data.items.map((t) => h('tr', {},
          h('td', {}, h('input', { type: 'checkbox', onchange: (e) => (e.target.checked ? selected.add(t.id) : selected.delete(t.id)) })),
          h('td', {}, h('a', { href: `https://www.instagram.com/${t.username}/`, target: '_blank', rel: 'noopener', class: 'ltr' }, `@${t.username}`), t.whitelisted ? ' ★' : '', t.display_name ? h('div', { class: 'small muted' }, t.display_name) : null),
          h('td', { class: 'small' }, t.segment),
          h('td', {}, h('div', { class: 'row' },
            t.i_follow ? h('span', { class: 'badge primary' }, 'נעקב') : null,
            t.follows_me ? h('span', { class: 'badge good' }, 'עוקב אחריי') : null,
            t.follow_wanted && !t.i_follow ? h('span', { class: 'badge' }, 'לעקוב') : null,
            t.unfollowed_at ? h('span', { class: 'badge warn' }, 'הוסר') : null)),
          h('td', { class: 'num small' }, t.followers_count === null ? (t.enrich_status === 'unavailable' ? 'פרטי' : '—') : fmt(t.followers_count)),
          h('td', { class: 'small muted' }, t.followed_at ? dt(t.followed_at) : '—')))))) : h('div', { class: 'empty small' }, 'אין חשבונות בתצוגה זו'),
      pages > 1 ? h('div', { class: 'row' }, h('button', { class: 'btn small', disabled: page <= 1, onclick: () => { page--; load(); } }, 'הקודם'), h('span', { class: 'small muted' }, `עמוד ${page} מתוך ${pages}`), h('button', { class: 'btn small', disabled: page >= pages, onclick: () => { page++; load(); } }, 'הבא')) : null,
    );
  }
  load().catch((e) => mount(wrap, h('div', { class: 'alert bad' }, e.message)));
  return wrap;
}

function addTargetsForm(id, opts) {
  const form = h('form', { class: 'card stack' },
    h('h3', {}, opts.title),
    h('p', { class: 'small muted' }, 'שם משתמש אחד בכל שורה (אפשר גם קישור לפרופיל). אפשר להוסיף קבוצה והערה: ', h('code', {}, 'username,קבוצה,הערה')),
    h('textarea', { name: 'usernames', required: true, class: 'ltr', placeholder: 'brand.one\n@creator_two\nhttps://instagram.com/shop.three' }),
    h('div', { class: 'row' }, h('input', { name: 'segment', placeholder: 'קבוצת קהל (למשל: מתחרים, לקוחות פוטנציאליים)', maxlength: 40 }),
      h('button', { class: 'btn primary', type: 'submit' }, 'הוספה')));
  form.addEventListener('submit', action(async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const r = await api.post(`/api/accounts/${id}/targets`, { ...d, ...opts.flags });
    toast(`נוספו ${r.added}, עודכנו ${r.updated}${r.invalid.length ? `, ${r.invalid.length} שורות לא תקינות` : ''}`, r.invalid.length ? '' : 'good');
    form.reset();
    rerender();
  }));
  return form;
}

async function manualTab(body, { id, settings }, type) {
  mount(body,
    manualNotice(),
    h('div', { class: 'grid k2' },
      taskRunner(id, type, rerender),
      addTargetsForm(id, { title: 'הוספת קהל יעד למעקב', flags: { followWanted: true } })),
    h('div', { class: 'small muted' }, `מגבלה יומית: ${settings.daily_follow_limit} · שעתית (כל הפעולות): ${settings.hourly_action_limit} · מרווח מינימלי: ${settings.min_action_gap_sec} שנ׳ · שעות פעילות ${settings.active_hour_start}:00–${settings.active_hour_end}:00`),
    (await todayList(id, type)),
    targetsManager(id, { filter: 'to_follow', filters: ['to_follow', 'following', 'all'] }));
}

async function unfollowTab(body, { id, settings, isAdmin }) {
  const imports = await api.get(`/api/accounts/${id}/relationship-imports`);
  const last = imports[0];
  const file = h('input', { type: 'file', accept: '.zip,.json', multiple: true });
  const upload = action(async () => {
    if (!file.files.length) throw new Error('בחר קובץ');
    for (const f of file.files) {
      const r = await api.upload(`/api/accounts/${id}/relationship-import`, f);
      toast(`יובא: ${r.followers ?? '—'} עוקבים, ${r.following ?? '—'} נעקבים · ${r.nonFollowers} לא עוקבים בחזרה${r.lostFollowers ? ` · ${r.lostFollowers} הפסיקו לעקוב` : ''}`, 'good');
    }
    rerender();
  });
  const rules = h('form', { class: 'card stack' },
    h('h3', {}, 'כללי הסרת מעקב'),
    h('div', { class: 'grid k2' },
      h('div', { class: 'field' }, h('label', {}, 'הסרה אחרי (ימים מאז המעקב)'), h('input', { name: 'unfollow_after_days', type: 'number', min: 1, max: 365, value: settings.unfollow_after_days })),
      h('div', { class: 'field' }, h('label', {}, 'מגבלה יומית'), h('input', { name: 'daily_unfollow_limit', type: 'number', min: 0, max: 100, value: settings.daily_unfollow_limit }))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'unfollow_only_non_followers', checked: !!settings.unfollow_only_non_followers }), 'רק חשבונות שאינם עוקבים בחזרה (מומלץ)'),
    h('div', { class: 'small muted' }, 'חשבונות ברשימה הלבנה (★) לעולם לא יוצעו להסרה. חשבון שהוסר לא יוצע שוב למעקב.'),
    h('button', { class: 'btn', type: 'submit', disabled: !isAdmin }, 'שמירת כללים'));
  rules.addEventListener('submit', action(async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(rules));
    await api.patch(`/api/accounts/${id}/settings`, { unfollow_after_days: Number(d.unfollow_after_days), daily_unfollow_limit: Number(d.daily_unfollow_limit), unfollow_only_non_followers: d.unfollow_only_non_followers ? 1 : 0 });
  }, 'הכללים נשמרו'));

  mount(body,
    manualNotice(),
    h('div', { class: 'card stack' },
      h('h3', {}, 'נתוני עוקבים אמיתיים — קובץ ההורדה הרשמי של אינסטגרם'),
      h('p', { class: 'small' }, 'ה-API של Meta אינו מספק רשימת עוקבים. כדי לדעת מי לא עוקב בחזרה ומי הפסיק לעקוב, הורד את הנתונים שלך מאינסטגרם: ',
        h('strong', {}, 'הגדרות ← מרכז החשבונות ← המידע וההרשאות שלך ← הורדת המידע שלך ← "עוקבים ונעקבים" בפורמט JSON'), '. העלה כאן את קובץ ה-ZIP (או followers_1.json ו-following.json).'),
      h('div', { class: 'row' }, file, h('button', { class: 'btn primary', onclick: upload }, 'ייבוא')),
      last ? h('div', { class: 'alert info small' }, `ייבוא אחרון: ${dt(last.imported_at)} · ${fmt(last.followers_total)} עוקבים · ${fmt(last.following_total)} נעקבים`, last.lost_followers !== null ? ` · ${last.lost_followers} הפסיקו לעקוב מאז הייבוא הקודם` : '') : h('div', { class: 'alert warn small' }, 'טרם יובא קובץ. תכנון Unfollow לפי "לא עוקב בחזרה" מושבת עד לייבוא — המערכת לא מנחשת.'),
      last?.lost_usernames?.length ? h('details', {}, h('summary', {}, `מי הפסיק לעקוב (${last.lost_usernames.length})`), h('div', { class: 'chips' }, last.lost_usernames.map((u) => h('a', { class: 'chip ltr', href: `https://www.instagram.com/${u}/`, target: '_blank', rel: 'noopener' }, `@${u}`)))) : null),
    h('div', { class: 'grid k2' }, taskRunner(id, 'unfollow', rerender), rules),
    (await todayList(id, 'unfollow')),
    targetsManager(id, { filter: 'non_followers', filters: ['non_followers', 'following', 'mutual', 'followers', 'whitelist'] }));
}

async function storiesTab(body, { id, settings }) {
  const stories = await api.get(`/api/accounts/${id}/media?type=story&limit=24`);
  mount(body,
    manualNotice(),
    h('div', { class: 'grid k2' },
      taskRunner(id, 'story_like', rerender),
      addTargetsForm(id, { title: 'חשבונות למעורבות בסטוריז', flags: { engageStories: true } })),
    h('div', { class: 'small muted' }, `מגבלה יומית: ${settings.daily_story_like_limit} · כל חשבון לכל היותר פעם ב-${settings.story_like_interval_days} ימים`),
    (await todayList(id, 'story_like')),
    targetsManager(id, { filter: 'stories', filters: ['stories', 'following', 'all'] }),
    h('div', { class: 'card' },
      h('h2', {}, 'הסטוריז שלך ונתוניהם (API רשמי)'),
      h('p', { class: 'small muted' }, 'סטוריז זמינים ב-API רק 24 שעות — המערכת שומרת אותם ואת נתוני החשיפה, הצפיות והתגובות שלהם כל 4 שעות.'),
      stories.length ? h('div', { class: 'media-grid' }, stories.map(mediaItem)) : h('div', { class: 'empty small' }, 'לא נשמרו סטוריז עדיין')));
}

// ───────────── Automation ─────────────
async function automationTab(body, { id, isAdmin }) {
  const STATUS = { queued: ['ממתין', ''], running: ['רץ', 'primary'], succeeded: ['הצליח', 'good'], failed: ['נכשל', 'bad'], cancelled: ['בוטל', 'warn'] };
  const INTERVALS = [[900, '15 דק׳'], [3600, 'שעה'], [3 * 3600, '3 שעות'], [4 * 3600, '4 שעות'], [6 * 3600, '6 שעות'], [12 * 3600, '12 שעות'], [86400, 'יום']];
  async function render() {
    const { schedules, jobs } = await api.get(`/api/accounts/${id}/automation`);
    mount(body,
      h('div', { class: 'card' },
        h('h2', {}, 'מנוע אוטומציות'),
        h('p', { class: 'small muted' }, 'כל האוטומציות פועלות ברקע דרך ה-API הרשמי, בתור משימות עם ניסיונות חוזרים, והשהיה אוטומטית בעת מגבלות. ניתן לעצור ולהפעיל כל אחת בכל רגע.'),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['אוטומציה', 'פעילה', 'תדירות', 'ריצה הבאה', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, schedules.map((s) => {
            const sel = h('select', { disabled: !isAdmin, onchange: action(async (e) => { await api.patch(`/api/accounts/${id}/schedules/${s.job_type}`, { interval_sec: Number(e.target.value) }); render(); }, 'התדירות עודכנה') },
              INTERVALS.map(([v, l]) => h('option', { value: v, selected: v === s.interval_sec ? true : undefined }, l)),
              INTERVALS.some(([v]) => v === s.interval_sec) ? null : h('option', { value: s.interval_sec, selected: true }, `${Math.round(s.interval_sec / 60)} דק׳`));
            return h('tr', {},
              h('td', {}, s.label),
              h('td', {}, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!s.enabled, disabled: !isAdmin, onchange: action(async (e) => { await api.patch(`/api/accounts/${id}/schedules/${s.job_type}`, { enabled: e.target.checked }); render(); }, 'עודכן') }), s.enabled ? 'פעיל' : 'כבוי')),
              h('td', {}, sel),
              h('td', { class: 'small muted' }, s.enabled ? dt(s.next_run_at) : '—'),
              h('td', {}, h('button', { class: 'btn small', onclick: action(async () => { const r = await api.post(`/api/accounts/${id}/jobs`, { type: s.job_type }); toast(r.duplicate ? 'המשימה כבר בתור' : 'נוספה לתור', 'good'); render(); }) }, '▶ הרצה עכשיו')));
          }))))),
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', {}, 'תור משימות'), h('span', { class: 'small muted' }, 'מתעדכן אוטומטית')),
        jobs.length ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['משימה', 'סטטוס', 'ניסיונות', 'זמן', 'פרטים', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, jobs.map((j) => h('tr', {},
            h('td', {}, j.label),
            h('td', {}, h('span', { class: `badge ${STATUS[j.status][1]}` }, STATUS[j.status][0])),
            h('td', { class: 'num' }, `${j.attempts}/${j.max_attempts}`),
            h('td', { class: 'small muted' }, j.status === 'queued' ? `מתוזמן ${dt(j.run_at)}` : dt(j.finished_at || j.updated_at)),
            h('td', { class: 'small' }, j.last_error ? h('span', { class: j.status === 'failed' ? 'bad' : 'muted' }, j.last_error) : j.result ? h('span', { class: 'muted ltr' }, j.result) : ''),
            h('td', {}, j.status === 'queued' ? h('button', { class: 'btn small', onclick: action(async () => { await api.post(`/api/jobs/${j.id}/cancel`); render(); }) }, 'ביטול')
              : j.status === 'failed' || j.status === 'cancelled' ? h('button', { class: 'btn small', onclick: action(async () => { await api.post(`/api/jobs/${j.id}/retry`); render(); }) }, 'ניסיון חוזר') : null)))))) : h('div', { class: 'empty small' }, 'אין משימות')));
  }
  await render();
  const t = setInterval(() => { if (!document.hidden) render().catch(() => {}); }, 5000);
  onLeave(() => clearInterval(t));
}

// ───────────── Safety ─────────────
async function safetyTab(body, { id, isAdmin }) {
  const s = await api.get(`/api/accounts/${id}/safety`);
  const a = s.account;
  const gate = (label, g) => h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('strong', {}, label), g.allowed ? h('span', { class: 'badge good' }, 'מותר כעת') : h('span', { class: 'badge warn' }, 'ממתין')),
    h('div', { class: 'small' }, `היום: ${g.doneToday}/${g.dailyLimit} · שעה אחרונה: ${g.doneLastHour}/${g.hourlyLimit}`),
    g.reason ? h('div', { class: 'small muted' }, `${g.reason}${g.nextAllowedAt ? ` · עד ${dt(g.nextAllowedAt)}` : ''}`) : null);
  const settingsForm = h('form', { class: 'card stack' },
    h('h2', {}, 'מגבלות בטיחות'),
    h('p', { class: 'small muted' }, `ערכים שמרניים מפחיתים סיכון להגבלות. תקרות מקסימליות במערכת: Follow/Unfollow ${state.meta.hardLimits.daily_follow_limit}, סטוריז ${state.meta.hardLimits.daily_story_like_limit} ליום.`),
    h('div', { class: 'grid k3' },
      num('daily_follow_limit', 'Follow ליום', s.settings, 0, 100),
      num('daily_unfollow_limit', 'Unfollow ליום', s.settings, 0, 100),
      num('daily_story_like_limit', 'לייקים לסטוריז ליום', s.settings, 0, 200),
      num('hourly_action_limit', 'פעולות לשעה (סה״כ)', s.settings, 1, 40),
      num('min_action_gap_sec', 'מרווח מינימלי בין פעולות (שנ׳)', s.settings, 10, 3600),
      num('block_cooldown_hours', 'הקפאה אחרי חסימה (שעות)', s.settings, 12, 168)),
    h('button', { class: 'btn primary', type: 'submit', disabled: !isAdmin }, 'שמירה'));
  settingsForm.addEventListener('submit', action(async (e) => {
    e.preventDefault();
    const d = Object.fromEntries([...new FormData(settingsForm)].map(([k, v]) => [k, Number(v)]));
    await api.patch(`/api/accounts/${id}/settings`, d);
  }, 'המגבלות נשמרו'));

  const scopes = a.granted_scopes;
  mount(body,
    h('div', { class: 'grid k3' },
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'מצב חשבון'), h('div', { class: 'value' }, statusBadge(a.status)), a.pause_reason ? h('div', { class: 'small muted' }, a.pause_reason) : null),
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'קריאות API ב-24 שעות'), h('div', { class: 'value num' }, fmt(s.api24h.total)),
        h('div', { class: 'small' }, s.api24h.errors ? h('span', { class: 'bad' }, `${s.api24h.errors} שגיאות: ${Object.entries(s.api24h.byKind).map(([k, n]) => `${k} ${n}`).join(', ')}`) : h('span', { class: 'muted' }, 'ללא שגיאות')),
        s.api24h.lastUsagePct !== null ? h('div', { class: 'small muted' }, `ניצול מכסה אחרון: ${s.api24h.lastUsagePct}%`) : null),
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'טוקן גישה'),
        h('div', { class: 'value' }, s.tokenExpiresInDays === null ? h('span', { class: 'badge good' }, 'ללא תפוגה / מתחדש') : s.tokenExpiresInDays < 7 ? h('span', { class: 'badge bad' }, `${s.tokenExpiresInDays} ימים`) : h('span', { class: 'badge good' }, `${s.tokenExpiresInDays} ימים`)),
        h('div', { class: 'small muted' }, 'מתחדש אוטומטית לפני תפוגה'))),
    h('div', { class: 'card' },
      h('h2', {}, 'הרשאות Meta שניתנו'),
      h('div', { class: 'chips' }, scopes.length ? scopes.map((x) => h('span', { class: 'badge good' }, x)) : h('span', { class: 'muted' }, '—'))),
    h('h2', {}, 'קצב פעולות ידניות'),
    h('div', { class: 'grid k3' }, gate('Follow', s.gates.follow), gate('Unfollow', s.gates.unfollow), gate('לייקים לסטוריז', s.gates.story_like)),
    h('div', { class: 'card stack' },
      h('h2', {}, 'אינסטגרם חסם פעולה?'),
      h('p', { class: 'small' }, 'אם הופיעה הודעה כמו "Try Again Later" / "We restrict certain activity" — דווח מיד. כל הפעולות הידניות יוקפאו, הרשימות יבוטלו, והמערכת לא תציע פעולות עד תום תקופת ההקפאה.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn danger solid', onclick: action(async () => { const note = prompt('מה הופיע באינסטגרם? (לא חובה)') ?? ''; await api.post(`/api/accounts/${id}/report-block`, { note }); rerender(); }, 'דווח — הפעולות הוקפאו') }, '⛔ דיווח על חסימה'),
        a.manual_cooldown_until && a.manual_cooldown_until > Date.now() && isAdmin ? h('button', { class: 'btn', onclick: action(async () => { if (!confirm('לבטל את הקפאת הבטיחות לפני הזמן?')) return; await api.post(`/api/accounts/${id}/clear-cooldown`); rerender(); }) }, 'ביטול הקפאה') : null)),
    settingsForm,
    h('div', { class: 'card' },
      h('h2', {}, 'אירועי בטיחות'),
      s.events.length ? s.events.map((e) => h('div', { class: 'list-item' }, h('span', { class: `dot ${e.level}` }), h('div', {}, h('div', {}, e.message), h('div', { class: 'small muted' }, `${dt(e.created_at)} · ${e.code}`)))) : h('div', { class: 'empty small' }, 'לא נרשמו אירועים')));
}

function num(name, label, settings, min, max) {
  return h('div', { class: 'field' }, h('label', {}, label), h('input', { type: 'number', name, min, max, value: settings[name], required: true }));
}

async function activityTab(body, { id }) {
  const [rows, history] = await Promise.all([api.get(`/api/accounts/${id}/activity?limit=200`), api.get(`/api/accounts/${id}/tasks/history?days=30`)]);
  const T = { follow: 'Follow', unfollow: 'Unfollow', story_like: 'סטוריז' };
  mount(body,
    h('div', { class: 'card' },
      h('h2', {}, 'ביצוע פעולות ידניות — 30 יום'),
      history.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['יום', 'סוג', 'בוצעו', 'דולגו', 'נכשלו', 'פג תוקף'].map((t) => h('th', {}, t)))),
        h('tbody', {}, history.slice().reverse().map((r) => h('tr', {}, h('td', { class: 'num' }, r.day), h('td', {}, T[r.type]), h('td', { class: 'num' }, r.done), h('td', { class: 'num' }, r.skipped), h('td', { class: 'num' }, r.failed), h('td', { class: 'num muted' }, r.expired)))))) : h('div', { class: 'empty small' }, 'אין היסטוריה עדיין')),
    h('div', { class: 'card' }, h('h2', {}, 'יומן פעולות'), activityList(rows)));
}

async function settingsTab(body, { id, account, settings, isAdmin }) {
  const form = h('form', { class: 'card stack' },
    h('h2', {}, 'הגדרות חשבון'),
    h('div', { class: 'grid k3' },
      h('div', { class: 'field' }, h('label', {}, 'אזור זמן'), h('input', { name: 'timezone', value: settings.timezone, class: 'ltr' })),
      num('active_hour_start', 'שעת התחלת פעילות', settings, 0, 23),
      num('active_hour_end', 'שעת סיום פעילות', settings, 1, 24),
      num('story_like_interval_days', 'מרווח ימים בין לייקים לאותו חשבון', settings, 1, 30)),
    h('button', { class: 'btn primary', type: 'submit', disabled: !isAdmin }, 'שמירה'));
  form.addEventListener('submit', action(async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    await api.patch(`/api/accounts/${id}/settings`, { timezone: d.timezone, active_hour_start: Number(d.active_hour_start), active_hour_end: Number(d.active_hour_end), story_like_interval_days: Number(d.story_like_interval_days) });
  }, 'נשמר'));
  mount(body, form,
    h('div', { class: 'card' },
      h('h2', {}, 'פרטי חיבור'),
      h('div', { class: 'small' }, `סוג חיבור: ${account.provider === 'facebook_login' ? 'Facebook Login' : 'Instagram Login'} · מזהה Instagram: `, h('code', {}, account.ig_user_id), ` · חובר ${dt(account.created_at)}`),
      h('a', { class: 'btn', href: '#/accounts' }, 'חידוש חיבור / הרשאות')),
    state.me.role === 'owner' ? h('div', { class: 'card stack' },
      h('h2', { class: 'bad' }, 'מחיקת חשבון'),
      h('p', { class: 'small' }, 'מנתק את החשבון ומוחק לצמיתות את כל הנתונים שלו: היסטוריית צמיחה, קהלי יעד, משימות והטוקן המוצפן.'),
      h('button', { class: 'btn danger', onclick: action(async () => { if (prompt(`להקליד ${account.username} לאישור מחיקה`) !== account.username) return; await api.del(`/api/accounts/${id}`); await refreshAccounts(); location.hash = '#/'; }, 'החשבון נמחק') }, 'מחיקה לצמיתות')) : null);
}
