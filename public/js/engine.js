import { api } from './api.js';
import { h, mount, fmt, dt, ago, action } from './ui.js';
import { onLeave } from './app.js';
import { rerender } from './account.js';

const REQ = { '1-follow': '1. Follow', '2-unfollow': '2. Unfollow', '3-story-likes': '3. לייקים לסטוריז', '4-analytics': '4. נתוני צמיחה', '5-safety': '5. בטיחות חשבון', extra: 'תוספת' };
const STATE = {
  not_supported: ['❌ לא נתמך ע״י Meta', 'bad'],
  needs_other_login: ['דורש חיבור Facebook Login', 'warn'],
  verified: ['✅ עובד — אומת בהרצה אמיתית', 'good'],
  failing: ['⚠️ נכשל בהרצה האחרונה', 'bad'],
  not_run_yet: ['⏳ טרם הורץ', ''],
  active: ['✅ פעיל', 'good'],
  demo: ['הדגמה — לא מחובר', ''],
};

/** "What actually works" — derived from real job outcomes, per account. */
export async function capabilitiesTab(body, { id }) {
  const caps = await api.get(`/api/accounts/${id}/capabilities`);
  const groups = Object.keys(REQ);
  mount(body,
    h('div', { class: 'alert info small' }, 'הסטטוס כאן נגזר מהרצות אמיתיות מול Meta בחשבון הזה — לא מהנחות. "לא נתמך" = אין ל-Meta שום ממשק רשמי, והמערכת לא מבצעת ולא מדווחת על הפעולה.'),
    h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['דרישה', 'יכולת', 'מצב בחשבון הזה', 'פירוט'].map((t) => h('th', {}, t)))),
      h('tbody', {}, groups.flatMap((g) => caps.filter((c) => c.requirement === g).map((c) => h('tr', {},
        h('td', { class: 'small' }, REQ[g]),
        h('td', {}, h('strong', {}, c.title)),
        h('td', {}, h('span', { class: `badge ${STATE[c.state][1]}` }, STATE[c.state][0]),
          c.lastSuccessAt ? h('div', { class: 'small muted' }, `הצלחה אחרונה: ${ago(c.lastSuccessAt)}`) : null,
          c.lastFailure && c.state === 'failing' ? h('div', { class: 'small bad' }, c.lastFailure.error || '') : null),
        h('td', { class: 'small muted' }, c.note, ' ', h('a', { href: c.source, target: '_blank', rel: 'noopener' }, 'תיעוד Meta'))))))))),
  );
}

/** Official Likes API engine: start / stop / monitor. */
export async function likesTab(body, { id, isAdmin }) {
  const st = await api.get(`/api/accounts/${id}/engine/likes`);
  const ST = { queued: ['ממתין', 'primary'], done: ['בוצע ✓', 'good'], failed: ['נכשל', 'bad'], cancelled: ['בוטל', ''] };
  const form = h('form', { class: 'row' },
    h('input', { name: 'usernames', class: 'ltr', placeholder: 'שמות משתמש של קהל היעד (מופרדים בפסיק)', required: true }),
    h('button', { class: 'btn', type: 'submit' }, 'הוספה למנוע'));
  form.addEventListener('submit', action(async (e) => {
    e.preventDefault();
    const v = new FormData(form).get('usernames').split(/[,\s]+/).filter(Boolean).join('\n');
    await api.post(`/api/accounts/${id}/targets`, { usernames: v, autoLike: true });
    rerender();
  }, 'נוסף'));
  const limits = h('form', { class: 'row' },
    h('label', { class: 'check' }, 'ליום ', h('input', { name: 'daily_like_limit', type: 'number', min: 0, max: 200, value: st.limits.daily, class: 'narrow' })),
    h('label', { class: 'check' }, 'לשעה ', h('input', { name: 'likes_per_hour', type: 'number', min: 1, max: 30, value: st.limits.perHour, class: 'narrow' })),
    h('label', { class: 'check' }, 'פוסטים עד גיל (ימים) ', h('input', { name: 'like_media_max_age_days', type: 'number', min: 1, max: 30, value: st.limits.maxAgeDays, class: 'narrow' })),
    h('button', { class: 'btn small', type: 'submit', disabled: !isAdmin }, 'שמירה'));
  limits.addEventListener('submit', action(async (e) => {
    e.preventDefault();
    await api.patch(`/api/accounts/${id}/settings`, Object.fromEntries([...new FormData(limits)].map(([k, v]) => [k, Number(v)])));
  }, 'נשמר'));

  mount(body,
    h('div', { class: 'alert info small' }, 'מנוע אמיתי על ה-Likes API הרשמי של Meta: מאתר פוסטים חדשים של חשבונות קהל היעד (Business Discovery) ומבצע לייק בקצב מבוקר. לייק נספר רק כש-Meta מחזירה success. לא נתמך ע״י Meta: סטוריז, חשבונות פרטיים, Follow/Unfollow.'),
    st.blocker ? h('div', { class: 'alert warn' }, `המנוע לא יכול לרוץ בחשבון זה: ${st.blocker}`) : null,
    h('div', { class: 'card row between' },
      h('div', {}, h('h2', {}, st.running ? '🟢 המנוע פועל' : '⚪ המנוע כבוי'),
        h('div', { class: 'small muted' }, st.running ? `סבב הבא: ${dt(st.nextRunAt)}` : 'כבוי כברירת מחדל — מופעל רק באישור שלך')),
      st.running
        ? h('button', { class: 'btn danger big', onclick: action(async () => { await api.post(`/api/accounts/${id}/engine/likes/stop`); rerender(); }, 'המנוע נעצר') }, '⏹ עצירה')
        : h('button', { class: 'btn primary big', disabled: !!st.blocker || !isAdmin || !st.targets.total, onclick: action(async () => { await api.post(`/api/accounts/${id}/engine/likes/start`); rerender(); }, 'המנוע הופעל') }, '▶ הפעלה')),
    h('div', { class: 'grid k4' },
      kpi('לייקים היום', `${fmt(st.doneToday)}/${fmt(st.limits.daily)}`),
      kpi('בתור', fmt(st.queued)),
      kpi('7 ימים: בוצעו / נכשלו', `${fmt(st.week.done)} / ${fmt(st.week.failed)}`),
      kpi('חשבונות יעד', `${fmt(st.targets.total)}`, st.targets.unavailable ? h('div', { class: 'small muted' }, `${st.targets.unavailable} פרטיים/אישיים — Meta לא חושפת פוסטים`) : null)),
    h('div', { class: 'card stack' }, h('h3', {}, 'חשבונות יעד ללייקים'), form, h('h3', {}, 'מגבלות קצב'), limits),
    h('div', { class: 'card' }, h('h2', {}, 'יומן פעולות (מנוטר)'),
      st.actions.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['חשבון', 'פוסט', 'מתוזמן / בוצע', 'מצב', 'פירוט'].map((t) => h('th', {}, t)))),
        h('tbody', {}, st.actions.map((a) => h('tr', {},
          h('td', { class: 'ltr small' }, `@${a.target_username}`),
          h('td', { class: 'small' }, a.permalink ? h('a', { href: a.permalink, target: '_blank', rel: 'noopener' }, a.media_type || 'פוסט') : a.media_type || a.media_id),
          h('td', { class: 'small muted' }, dt(a.executed_at || a.run_at)),
          h('td', {}, h('span', { class: `badge ${ST[a.status][1]}` }, ST[a.status][0])),
          h('td', { class: 'small bad' }, a.error || '')))))) : h('div', { class: 'empty small' }, 'עדיין לא בוצעו פעולות')),
  );
  if (st.running) {
    const t = setInterval(() => { if (!document.hidden) rerender(); }, 15000);
    onLeave(() => clearInterval(t));
  }
}

const kpi = (label, value, extra) => h('div', { class: 'card kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value num' }, value), extra || null);
