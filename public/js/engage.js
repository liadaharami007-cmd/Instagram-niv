import { api } from './api.js';
import { h, mount, fmt, dt, ago, toast, action } from './ui.js';
import { onLeave } from './app.js';
import { rerender } from './account.js';

const TYPE = { IMAGE: 'פוסט תמונה', REELS: 'רילס', STORIES: 'סטורי' };
const PST = { scheduled: ['מתוזמן', 'primary'], publishing: ['בפרסום…', 'warn'], published: ['פורסם', 'good'], failed: ['נכשל', 'bad'], cancelled: ['בוטל', ''] };

function localInput(ts) {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

// ───────────── Scheduled publishing ─────────────
export async function publishTab(body, { id, account }) {
  const data = await api.get(`/api/accounts/${id}/posts`);
  let type = 'IMAGE';
  let upload = null;
  let when = 'later';

  const preview = h('div', { class: 'upload-preview empty small' }, 'לא נבחר קובץ');
  const file = h('input', { type: 'file', accept: 'image/jpeg,video/mp4', class: 'hidden' });
  const urlInput = h('input', { class: 'ltr hidden', placeholder: 'https://… קישור ציבורי לקובץ JPEG / MP4' });
  const caption = h('textarea', { maxlength: 2200, placeholder: 'כיתוב לפוסט, כולל #האשטגים ו-@תיוגים' });
  const counter = h('div', { class: 'small muted' });
  const at = h('input', { type: 'datetime-local', value: localInput(Math.ceil((Date.now() + 3600_000) / 900_000) * 900_000) });
  const submit = h('button', { class: 'btn primary big', type: 'button' });
  const typeChips = h('div', { class: 'chips' });
  const whenChips = h('div', { class: 'chips' });

  const sync = () => {
    const tags = (caption.value.match(/#[^\s#]+/g) || []).length;
    counter.textContent = `${caption.value.length}/2,200 תווים · ${tags}/30 האשטגים`;
    counter.classList.toggle('bad', caption.value.length > 2200 || tags > 30);
    caption.disabled = type === 'STORIES';
    caption.placeholder = type === 'STORIES' ? 'בסטורי אין כיתוב (מגבלת Meta)' : 'כיתוב לפוסט, כולל #האשטגים ו-@תיוגים';
    at.classList.toggle('hidden', when === 'now');
    submit.textContent = when === 'now' ? '🚀 פרסום עכשיו' : '📅 תזמון פרסום';
    mount(typeChips, Object.entries(TYPE).map(([k, l]) => h('button', { type: 'button', class: ['chip', k === type && 'active'], onclick: () => { type = k; sync(); } }, l)));
    mount(whenChips, [['later', 'בתאריך ושעה'], ['now', 'עכשיו']].map(([k, l]) => h('button', { type: 'button', class: ['chip', k === when && 'active'], onclick: () => { when = k; sync(); } }, l)));
  };
  caption.addEventListener('input', sync);

  file.addEventListener('change', action(async () => {
    const f = file.files[0];
    if (!f) return;
    mount(preview, 'מעלה…');
    upload = await api.upload(`/api/accounts/${id}/uploads`, f);
    const local = URL.createObjectURL(f);
    if (upload.contentType === 'video/mp4') type = type === 'IMAGE' ? 'REELS' : type;
    mount(preview, upload.contentType === 'video/mp4' ? h('video', { src: local, muted: true, controls: true }) : h('img', { src: local, alt: '' }),
      h('div', { class: 'small muted' }, `${f.name}${upload.width ? ` · ${upload.width}×${upload.height}` : ''}`));
    preview.classList.remove('empty');
    sync();
  }));

  submit.addEventListener('click', action(async () => {
    const payload = { mediaType: type, caption: type === 'STORIES' ? '' : caption.value };
    if (upload) payload.uploadId = upload.id;
    else payload.mediaUrl = urlInput.value;
    if (when === 'later') payload.scheduledAt = new Date(at.value).getTime();
    await api.post(`/api/accounts/${id}/posts`, payload);
    toast(when === 'now' ? 'נשלח לפרסום — יופיע באינסטגרם תוך רגעים' : 'הפרסום תוזמן ✓', 'good');
    rerender();
  }));

  const drop = h('div', { class: 'dropzone', onclick: () => file.click() }, h('div', { class: 'big-num' }, '⬆'), h('div', {}, 'לחיצה לבחירת תמונה (JPEG) או סרטון (MP4)'), h('div', { class: 'small muted' }, 'תמונה עד 8MB · סרטון עד 100MB'));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); file.files = e.dataTransfer.files; file.dispatchEvent(new Event('change')); });

  sync();
  const upcoming = data.posts.filter((p) => p.status === 'scheduled' || p.status === 'publishing');
  const past = data.posts.filter((p) => !(p.status === 'scheduled' || p.status === 'publishing'));
  mount(body,
    account.is_demo ? h('div', { class: 'alert warn small' }, 'בחשבון הדגמה הפרסום לא נשלח לאינסטגרם.') : null,
    data.publicUrlProblem && !account.is_demo ? h('div', { class: 'alert warn small' }, data.publicUrlProblem) : null,
    h('div', { class: 'grid k2' },
      h('div', { class: 'card stack' },
        h('div', { class: 'row between' }, h('h2', {}, 'פרסום חדש'), h('span', { class: 'badge good' }, 'API רשמי — אוטומטי לגמרי')),
        typeChips,
        drop, file, preview,
        h('button', { type: 'button', class: 'btn small', onclick: () => urlInput.classList.toggle('hidden') }, 'או: קישור לקובץ באינטרנט'), urlInput,
        caption, counter,
        whenChips, at,
        submit,
        h('div', { class: 'small muted' }, `${data.used24h}/${data.limit24h} פרסומים דרך המערכת ב-24 השעות האחרונות (מגבלת Meta)`)),
      h('div', { class: 'card' },
        h('h2', {}, `מתוזמנים (${upcoming.length})`),
        upcoming.length ? upcoming.map(postRow) : h('div', { class: 'empty small' }, 'אין פרסומים מתוזמנים'))),
    h('div', { class: 'card' }, h('h2', {}, 'היסטוריית פרסומים'), past.length ? past.map(postRow) : h('div', { class: 'empty small' }, 'עדיין לא פורסם דבר דרך המערכת')),
  );
  if (upcoming.length) {
    const t = setInterval(() => { if (!document.hidden) rerender(); }, 15000);
    onLeave(() => clearInterval(t));
  }
}

function postRow(p) {
  const showImg = p.media_url.startsWith(location.origin) || p.media_url.startsWith('data:');
  const isVideo = p.media_type === 'REELS';
  return h('div', { class: 'list-item' },
    showImg && !isVideo ? h('img', { class: 'post-thumb', src: p.media_url, alt: '' }) : h('div', { class: 'post-thumb icon' }, isVideo ? '🎬' : '🖼'),
    h('div', { class: 'spacer' },
      h('div', { class: 'row' }, h('strong', {}, TYPE[p.media_type]), h('span', { class: `badge ${PST[p.status][1]}` }, PST[p.status][0]),
        h('span', { class: 'small muted' }, p.status === 'published' ? `פורסם ${dt(p.published_at)}` : dt(p.scheduled_at))),
      p.caption ? h('div', { class: 'small clamp' }, p.caption) : null,
      p.error ? h('div', { class: `small ${p.status === 'failed' ? 'bad' : 'muted'}` }, p.error) : null,
      h('div', { class: 'row' },
        p.permalink ? h('a', { class: 'btn small', href: p.permalink, target: '_blank', rel: 'noopener' }, 'צפייה באינסטגרם') : null,
        p.status === 'scheduled' ? h('button', { class: 'btn small', onclick: action(async () => {
          const v = prompt('מועד חדש (YYYY-MM-DD HH:MM)', localInput(p.scheduled_at).replace('T', ' '));
          if (!v) return;
          await api.patch(`/api/posts/${p.id}`, { scheduledAt: new Date(v.replace(' ', 'T')).getTime() });
          rerender();
        }, 'המועד עודכן') }, 'שינוי מועד') : null,
        p.status === 'scheduled' || p.status === 'failed' ? h('button', { class: 'btn small', onclick: action(async () => { await api.post(`/api/posts/${p.id}/cancel`); rerender(); }) }, 'ביטול') : null,
        p.status === 'failed' ? h('button', { class: 'btn small', onclick: action(async () => { await api.post(`/api/posts/${p.id}/retry`); rerender(); }, 'נשלח שוב לפרסום') }, 'ניסיון חוזר') : null)));
}

// ───────────── Auto replies ─────────────
const CH = { comment: 'תגובות', dm: 'הודעות דיירקט' };
const ACT = { public_reply: 'תגובה ציבורית', private_reply: 'הודעה פרטית', dm_reply: 'מענה בדיירקט' };

export async function repliesTab(body, { id, account, isAdmin }) {
  const [{ rules, status, limit }, templates, hist] = await Promise.all([
    api.get(`/api/accounts/${id}/reply-rules`), api.get('/api/reply-templates'), api.get(`/api/accounts/${id}/auto-replies?limit=60`),
  ]);
  const editor = h('div');
  const realtime = !!status.lastWebhookAt;
  const hasDm = rules.some((r) => r.channel === 'dm' && r.enabled);

  function openEditor(rule) {
    const r = rule || { name: '', channel: 'comment', match_type: 'keywords', keywords: [], public_replies: [], dm_text: '' };
    const f = h('form', { class: 'card stack editor' },
      h('h2', {}, rule ? `עריכת כלל: ${rule.name}` : 'כלל חדש'),
      h('div', { class: 'grid k3' },
        h('div', { class: 'field' }, h('label', {}, 'שם הכלל'), h('input', { name: 'name', value: r.name, required: true, maxlength: 80 })),
        h('div', { class: 'field' }, h('label', {}, 'על מה להגיב'), h('select', { name: 'channel' }, h('option', { value: 'comment', selected: r.channel === 'comment' || undefined }, 'תגובות לפוסטים'), h('option', { value: 'dm', selected: r.channel === 'dm' || undefined }, 'הודעות בדיירקט'))),
        h('div', { class: 'field' }, h('label', {}, 'מתי'), h('select', { name: 'match_type' }, h('option', { value: 'keywords', selected: r.match_type === 'keywords' || undefined }, 'כשיש מילת מפתח'), h('option', { value: 'any', selected: r.match_type === 'any' || undefined }, 'לכל הודעה / תגובה')))),
      h('div', { class: 'field' }, h('label', {}, 'מילות מפתח (מופרדות בפסיק)'), h('input', { name: 'keywords', value: r.keywords.join(', '), placeholder: 'מחיר, כמה עולה, פרטים' })),
      h('div', { class: 'field comment-only' }, h('label', {}, 'תגובה ציבורית — כל שורה היא גרסה (נבחרת אקראית, כדי לא לחזור על אותו טקסט)'),
        h('textarea', { name: 'public_replies', placeholder: 'תודה {username}! שלחנו לך פרטים בפרטי 💌' }, r.public_replies.join('\n')),
        h('div', { class: 'small muted' }, '{username} יוחלף בשם המגיב')),
      h('div', { class: 'field' }, h('label', {}, 'הודעה פרטית (נשלחת בדיירקט)'), h('textarea', { name: 'dm_text' }, r.dm_text || '')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'שמירה'), h('button', { class: 'btn', type: 'button', onclick: () => mount(editor) }, 'ביטול')));
    const ch = f.querySelector('select[name=channel]');
    const toggle = () => f.querySelector('.comment-only').classList.toggle('hidden', ch.value === 'dm');
    ch.addEventListener('change', toggle);
    toggle();
    f.addEventListener('submit', action(async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      const payload = { ...d, keywords: d.keywords, public_replies: d.public_replies ?? '' };
      if (rule) await api.patch(`/api/reply-rules/${rule.id}`, payload);
      else await api.post(`/api/accounts/${id}/reply-rules`, payload);
      rerender();
    }, 'הכלל נשמר'));
    mount(editor, f);
    f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const limitInput = h('input', { type: 'number', min: 1, max: 200, value: limit, class: 'narrow' });
  mount(body,
    account.is_demo ? h('div', { class: 'alert warn small' }, 'בחשבון הדגמה הכללים נשמרים אבל לא נשלחות תגובות לאינסטגרם.') : null,
    h('div', { class: 'grid k3' },
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'נשלחו ב-24 שעות'), h('div', { class: 'value num' }, fmt(hist.sent24h)), hist.failed24h ? h('div', { class: 'small bad' }, `${hist.failed24h} נכשלו`) : null),
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'כללים פעילים'), h('div', { class: 'value num' }, fmt(rules.filter((r) => r.enabled).length))),
      h('div', { class: 'card kpi' }, h('div', { class: 'label' }, 'קליטת תגובות והודעות'),
        h('div', { class: 'value' }, realtime ? h('span', { class: 'badge good' }, 'בזמן אמת ✓') : h('span', { class: 'badge warn' }, 'בדיקה כל 15 דק׳')),
        h('div', { class: 'small muted' }, realtime ? `עדכון אחרון ${ago(status.lastWebhookAt)}` : 'תגובות נבדקות אוטומטית. הודעות דיירקט דורשות Webhooks.'))),
    hasDm && !realtime && !account.is_demo ? h('div', { class: 'alert warn small' }, 'יש כלל להודעות דיירקט, אבל עדיין לא התקבלו עדכונים מ-Meta. יש להגדיר Webhooks באפליקציה של Meta: ', h('code', {}, status.webhookUrl)) : null,
    h('div', { class: 'card' },
      h('h2', {}, 'הפעלה בלחיצה — תבניות מוכנות'),
      h('div', { class: 'template-grid' }, templates.map((t) => h('div', { class: 'template' },
        h('div', {}, h('strong', {}, t.name)),
        h('div', { class: 'small muted' }, t.channel === 'dm' ? 'הודעות דיירקט' : 'תגובות', ' · ', t.match_type === 'any' ? 'לכל אחד' : `מילים: ${t.keywords.join(', ')}`),
        rules.some((r) => r.name === t.name) ? h('span', { class: 'badge good' }, 'פעיל ✓') : h('button', { class: 'btn primary small', disabled: !isAdmin, onclick: action(async () => {
          await api.post(`/api/accounts/${id}/reply-rules`, { template: t.key });
          toast(t.dm_text?.includes('[') ? 'הופעל ✓ — כדאי לערוך את הטקסט שבסוגריים המרובעים' : 'הופעל ✓', 'good');
          rerender();
        }) }, '➕ הפעלה'))))),
    editor,
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, 'הכללים שלי'), h('button', { class: 'btn', disabled: !isAdmin, onclick: () => openEditor(null) }, '+ כלל מותאם')),
      rules.length ? rules.map((r) => h('div', { class: 'list-item' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!r.enabled, disabled: !isAdmin, onchange: action(async (e) => { await api.patch(`/api/reply-rules/${r.id}`, { enabled: e.target.checked }); }, 'עודכן') })),
        h('div', { class: 'spacer' },
          h('div', { class: 'row' }, h('strong', {}, r.name), h('span', { class: 'badge' }, CH[r.channel]), h('span', { class: 'small muted' }, `${fmt(r.hits)} הפעלות`)),
          h('div', { class: 'chips small' }, r.match_type === 'any' ? h('span', { class: 'badge primary' }, 'לכל אחד') : r.keywords.map((k) => h('span', { class: 'badge primary' }, k))),
          r.public_replies.length ? h('div', { class: 'small' }, '💬 ', r.public_replies[0], r.public_replies.length > 1 ? ` (+${r.public_replies.length - 1} גרסאות)` : '') : null,
          r.dm_text ? h('div', { class: 'small muted clamp' }, '✉️ ', r.dm_text) : null),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', disabled: !isAdmin, onclick: () => openEditor(r) }, 'עריכה'),
          h('button', { class: 'btn small danger', disabled: !isAdmin, onclick: action(async () => { if (!confirm(`למחוק את "${r.name}"?`)) return; await api.del(`/api/reply-rules/${r.id}`); rerender(); }) }, 'מחיקה'))))
        : h('div', { class: 'empty small' }, 'אין כללים עדיין — בחר תבנית למעלה')),
    h('div', { class: 'card' },
      h('h2', {}, 'מה נשלח לאחרונה'),
      hist.rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['זמן', 'מאת', 'כתב/ה', 'סוג', 'תשובה', 'מצב'].map((t) => h('th', {}, t)))),
        h('tbody', {}, hist.rows.map((x) => h('tr', {},
          h('td', { class: 'small muted' }, dt(x.created_at)),
          h('td', { class: 'ltr small' }, x.from_username ? `@${x.from_username}` : '—'),
          h('td', { class: 'small' }, x.incoming_text),
          h('td', { class: 'small' }, ACT[x.action]),
          h('td', { class: 'small' }, h('div', { class: 'clamp' }, x.reply_text)),
          h('td', {}, x.status === 'sent' ? h('span', { class: 'badge good' }, 'נשלח') : x.status === 'skipped' ? h('span', { class: 'badge' }, 'דולג') : h('span', { class: 'badge bad', title: x.error || '' }, 'נכשל'))))))) : h('div', { class: 'empty small' }, 'עוד לא נשלחו תגובות אוטומטיות')),
    h('div', { class: 'card row' }, h('span', {}, 'מקסימום תגובות אוטומטיות לשעה (הגנה מפני ספאם):'), limitInput,
      h('button', { class: 'btn small', disabled: !isAdmin, onclick: action(async () => { await api.patch(`/api/accounts/${id}/settings`, { auto_reply_hourly_limit: Number(limitInput.value) }); }, 'נשמר') }, 'שמירה')),
  );
}
