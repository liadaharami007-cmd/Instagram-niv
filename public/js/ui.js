// DOM helpers — every dynamic value goes through text nodes (no innerHTML with data).
export function h(tag, attrs = {}, ...children) {
  const el = tag === 'svg' || attrs.svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false || k === 'svg') continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const svg = (tag, attrs = {}, ...children) => h(tag, { ...attrs, svg: true }, ...children);
export function mount(target, ...children) {
  target.replaceChildren();
  append(target, children);
}

const nf = new Intl.NumberFormat('he-IL');
export const fmt = (n) => (n === null || n === undefined ? '—' : nf.format(Math.round(n * 100) / 100));
export const signed = (n) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${nf.format(n)}`);
export function delta(n, suffix = '') {
  if (n === null || n === undefined) return h('span', { class: 'delta muted' }, '—');
  return h('span', { class: `delta num ${n > 0 ? 'up' : n < 0 ? 'down' : ''}` }, `${n > 0 ? '▲ +' : n < 0 ? '▼ ' : ''}${nf.format(n)}${suffix}`);
}
const dtf = new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'short' });
export const dt = (ts) => (ts ? dtf.format(new Date(ts)) : '—');
export function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  const abs = Math.abs(s);
  const rtf = new Intl.RelativeTimeFormat('he', { numeric: 'auto' });
  if (abs < 60) return rtf.format(-s, 'second');
  if (abs < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}
export function countdown(ts) {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 60) return `${s} שנ׳`;
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} דק׳`;
  if (s < 86400) return `${Math.floor(s / 3600)} שע׳ ${Math.floor((s % 3600) / 60)} דק׳`;
  return dt(ts);
}

export function toast(msg, kind = '') {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3500);
}

export const STATUS = {
  active: ['פעיל', 'good'],
  paused: ['מושהה', 'warn'],
  restricted: ['מוגבל ע״י Meta', 'bad'],
  needs_reauth: ['נדרש חיבור מחדש', 'bad'],
  disconnected: ['מנותק', 'bad'],
};
export const statusBadge = (s) => h('span', { class: `badge ${(STATUS[s] || [])[1] || ''}` }, (STATUS[s] || [s])[0]);

export function loading() {
  return h('div', { class: 'empty' }, 'טוען…');
}

/** Disables a button while the async action runs, shows errors as toasts. */
export function action(fn, okMsg) {
  return async (e) => {
    const btn = e?.currentTarget;
    if (btn) btn.disabled = true;
    try {
      const r = await fn(e);
      if (okMsg) toast(okMsg, 'good');
      return r;
    } catch (err) {
      toast(err.message || 'שגיאה', 'bad');
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  };
}

// ── Charts (inline SVG, no library) ──
const W = 640;
const H = 200;
const PAD = { t: 12, r: 12, b: 26, l: 48 };

function scale(values) {
  const vals = values.filter((v) => typeof v === 'number');
  if (!vals.length) return null;
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const padding = (max - min) * 0.08;
  return { min: min - padding, max: max + padding };
}

function frame(points, sc, extra) {
  const xs = (i) => PAD.l + (i * (W - PAD.l - PAD.r)) / Math.max(points.length - 1, 1);
  const ys = (v) => PAD.t + (1 - (v - sc.min) / (sc.max - sc.min)) * (H - PAD.t - PAD.b);
  const ticks = [sc.max, (sc.max + sc.min) / 2, sc.min];
  const labelEvery = Math.ceil(points.length / 6);
  return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', direction: 'ltr' },
    ticks.map((t) => [
      svg('line', { x1: PAD.l, x2: W - PAD.r, y1: ys(t), y2: ys(t), class: 'grid-line' }),
      svg('text', { x: PAD.l - 6, y: ys(t) + 4, 'text-anchor': 'end', class: 'label' }, fmt(Math.round(t))),
    ]),
    points.map((p, i) => (i % labelEvery === 0 || i === points.length - 1 ? svg('text', { x: xs(i), y: H - 6, 'text-anchor': 'middle', class: 'label' }, p.x.slice(5)) : null)),
    extra(xs, ys),
  );
}

/** Line chart; null values create gaps (missing data is never interpolated as real). */
export function lineChart(points) {
  const sc = scale(points.map((p) => p.y));
  if (!sc) return h('div', { class: 'empty small' }, 'אין עדיין נתונים לתקופה זו');
  return frame(points, sc, (xs, ys) => {
    const segs = [];
    let cur = [];
    points.forEach((p, i) => {
      if (typeof p.y === 'number') cur.push([xs(i), ys(p.y), p]);
      else if (cur.length) segs.push(cur), (cur = []);
    });
    if (cur.length) segs.push(cur);
    return segs.map((seg) => [
      seg.length > 1 ? svg('path', { class: 'area', d: `M${seg[0][0]},${H - PAD.b} ${seg.map(([x, y]) => `L${x},${y}`).join(' ')} L${seg.at(-1)[0]},${H - PAD.b} Z` }) : null,
      svg('path', { class: 'line', d: seg.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ') }),
      seg.map(([x, y, p]) => svg('circle', { cx: x, cy: y, r: seg.length > 40 ? 1.5 : 3, class: 'pt' }, svg('title', {}, `${p.x}: ${fmt(p.y)}`))),
    ]);
  });
}

export function barChart(points, { signedColors = false } = {}) {
  const vals = points.map((p) => p.y);
  const sc0 = scale([...vals, 0]);
  if (!sc0 || vals.every((v) => typeof v !== 'number')) return h('div', { class: 'empty small' }, 'אין עדיין נתונים לתקופה זו');
  return frame(points, sc0, (xs, ys) => {
    const bw = Math.max(2, ((W - PAD.l - PAD.r) / points.length) * 0.6);
    return points.map((p, i) => {
      if (typeof p.y !== 'number') return null;
      const y0 = ys(0);
      const y1 = ys(p.y);
      return svg('rect', { x: xs(i) - bw / 2, y: Math.min(y0, y1), width: bw, height: Math.max(1, Math.abs(y1 - y0)), class: signedColors ? (p.y >= 0 ? 'bar-pos' : 'bar-neg') : 'bar' }, svg('title', {}, `${p.x}: ${signed(p.y)}`));
    });
  });
}
