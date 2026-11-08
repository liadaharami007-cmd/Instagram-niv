import { api } from './api.js';
import { h, mount, fmt, ago, toast, action } from './ui.js';
import { rerender } from './account.js';

/** The account home: every automation is one switch. */
export async function autopilotTab(body, { id, isAdmin }) {
  const st = await api.get(`/api/accounts/${id}/autopilot`);
  const allOn = st.features.every((f) => f.on || f.needs);

  const set = (key, payload, msg) => action(async () => {
    await api.patch(`/api/accounts/${id}/autopilot/${key}`, payload);
    toast(msg, 'good');
    rerender();
  });

  const card = (f) => {
    const sw = f.always
      ? h('span', { class: 'badge good big-badge' }, 'פועל תמיד')
      : h('label', { class: 'switch', title: f.on ? 'כיבוי' : 'הפעלה' },
          h('input', { type: 'checkbox', checked: f.on, disabled: !isAdmin || (!!f.needs && !f.on && f.key === 'likes'), onchange: (e) => set(f.key, { on: e.target.checked }, e.target.checked ? 'הופעל ✓' : 'כובה')(e) }),
          h('span', { class: 'slider' }));
    const extra = [];
    if (f.text !== undefined) {
      const box = h('div', { class: 'hidden stack' });
      const ta = h('textarea', { rows: 3 }, f.text);
      mount(box, ta, h('button', { class: 'btn primary small', onclick: (e) => set(f.key, { text: ta.value }, 'הנוסח נשמר ✓')(e) }, 'שמירה'));
      extra.push(h('div', { class: 'msg-preview small' }, '✉️ ', f.text),
        h('button', { class: 'btn small', disabled: !isAdmin, onclick: () => box.classList.toggle('hidden') }, '✏️ שינוי הנוסח'), box);
    }
    if (f.key === 'likes' && !f.needs) {
      const inp = h('input', { class: 'ltr', placeholder: 'שמות משתמש, מופרדים בפסיק' });
      extra.push(h('div', { class: 'small muted' }, `${fmt(f.targets)} חשבונות ברשימה`),
        h('div', { class: 'row' }, inp, h('button', { class: 'btn small', onclick: action(async () => {
          const v = inp.value.split(/[,\s]+/).filter(Boolean).join('\n');
          if (!v) throw new Error('הקלידו שם משתמש');
          await api.post(`/api/accounts/${id}/targets`, { usernames: v, autoLike: true });
          toast('נוסף ✓ — הלייקים יתחילו בסבב הבא', 'good');
          rerender();
        }) }, '+ הוספה')));
    }
    return h('div', { class: ['card', 'feature', f.on ? 'on' : 'off'] },
      h('div', { class: 'row between' }, h('h3', {}, f.title), sw),
      h('div', { class: 'small muted' }, f.desc),
      f.needs ? h('div', { class: 'alert warn small' }, f.needs) : h('div', { class: 'small' }, f.on ? `🟢 ${f.stat ?? ''}${f.at ? ` · ${ago(f.at)}` : ''}` : '⚪ כבוי'),
      ...extra);
  };

  mount(body,
    h('div', { class: 'card hero' },
      h('div', { class: 'big-num' }, allOn ? '🟢' : '🟡'),
      h('div', {}, h('h2', {}, allOn ? 'הכול פועל אוטומטית' : 'רוב המערכת פועלת אוטומטית'),
        h('div', { class: 'muted' }, `היום: ${fmt(st.today.replies)} תשובות נשלחו · ${fmt(st.today.likes)} לייקים`))),
    h('div', { class: 'grid k2' }, st.features.map(card)),
    h('div', { class: 'card feature unsupported' },
      h('h3', {}, '❌ ', st.notSupported.map((x) => x.title).join(' · ')),
      h('div', { class: 'small' }, 'Meta לא מאפשרת לבצע את הפעולות האלה אוטומטית — אין להן ממשק רשמי. מערכות שעושות זאת עוקפות את ההגנות של אינסטגרם ומסכנות את החשבון, ולכן המערכת לא עושה את זה.'),
      h('a', { class: 'small', href: `#/a/${id}/capabilities` }, 'פירוט מלא — מה עובד ומה לא')));
}
