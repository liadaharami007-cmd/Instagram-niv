import type { Ctx } from '../context.ts';
import { badRequest } from '../lib/errors.ts';
import { addDays, dayKey, daysBetween, startOfDay, DAY } from '../lib/time.ts';
import { MetaApiError } from '../meta/errors.ts';
import { FB_IG_FIELDS, IG_PROFILE_FIELDS } from '../meta/oauth.ts';
import type { AccountRow } from './accounts.ts';

/** Account-level metrics requested as one total_value group per day. */
export const TOTAL_VALUE_METRICS = ['views', 'reach', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'profile_links_taps'];
const MEDIA_METRICS = ['reach', 'views', 'saved', 'shares', 'total_interactions', 'likes', 'comments'];
const STORY_METRICS = ['reach', 'views', 'replies', 'shares', 'total_interactions'];
const META_REPORTING_TZ = 'America/Los_Angeles';

export const METRIC_LABELS: Record<string, string> = {
  followers_count: 'עוקבים',
  follows_count: 'נעקבים',
  media_count: 'פוסטים',
  new_followers: 'עוקבים חדשים (Meta)',
  follows: 'התחילו לעקוב',
  unfollows: 'הפסיקו לעקוב',
  views: 'צפיות',
  reach: 'חשיפה (Reach)',
  accounts_engaged: 'חשבונות מעורבים',
  total_interactions: 'אינטראקציות',
  likes: 'לייקים',
  comments: 'תגובות',
  shares: 'שיתופים',
  saves: 'שמירות',
  profile_links_taps: 'הקלקות על קישורים',
};

type Unsupported = MetaApiError & { kind: 'invalid_request' };
const isUnsupported = (e: unknown): e is Unsupported => e instanceof MetaApiError && e.kind === 'invalid_request' && (e.code === 100 || e.code === 110);

export class AnalyticsService {
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  private req(account: AccountRow, path: string, params: Record<string, string | number | undefined>) {
    return this.ctx.graph.request<any>({ provider: account.provider, token: this.ctx.accounts.token(account), path, params, accountId: account.id });
  }

  private upsertMetric(accountId: string, day: string, metric: string, value: number, source: string) {
    this.ctx.db.run(
      `INSERT INTO daily_metrics (account_id, day, metric, value, source, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(account_id, day, metric) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`,
      accountId, day, metric, value, source, this.ctx.now(),
    );
  }

  // ───────────────────────────── Sync (writes real Meta data) ─────────────────────────────

  async syncProfile(account: AccountRow) {
    const fields = account.provider === 'instagram_login' ? IG_PROFILE_FIELDS : FB_IG_FIELDS;
    const { data } = await this.req(account, account.ig_user_id, { fields });
    const now = this.ctx.now();
    const tz = this.ctx.accounts.settings(account.id).timezone;
    const day = dayKey(now, tz);
    this.ctx.db.tx(() => {
      this.ctx.db.run(
        `UPDATE ig_accounts SET username = COALESCE(?, username), name = ?, profile_picture_url = ?, account_type = COALESCE(?, account_type),
           followers_count = ?, follows_count = ?, media_count = ?, last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
        data.username ?? null, data.name ?? null, data.profile_picture_url ?? null, data.account_type ?? null,
        data.followers_count ?? null, data.follows_count ?? null, data.media_count ?? null, now, now, account.id,
      );
      if (typeof data.followers_count === 'number') {
        this.ctx.db.run(
          'INSERT INTO follower_snapshots (account_id, taken_at, followers_count, follows_count, media_count) VALUES (?,?,?,?,?)',
          account.id, now, data.followers_count, data.follows_count ?? null, data.media_count ?? null,
        );
        this.upsertMetric(account.id, day, 'followers_count', data.followers_count, 'snapshot');
      }
      if (typeof data.follows_count === 'number') this.upsertMetric(account.id, day, 'follows_count', data.follows_count, 'snapshot');
      if (typeof data.media_count === 'number') this.upsertMetric(account.id, day, 'media_count', data.media_count, 'snapshot');
    });
    return { followers: data.followers_count, follows: data.follows_count, media: data.media_count };
  }

  /** Fetches one insights request; returns null (and remembers) when Meta says the metric is unsupported. */
  private async insight(account: AccountRow, metricKey: string, params: Record<string, string | number | undefined>): Promise<any[] | null> {
    if (JSON.parse(account.unsupported_metrics).includes(metricKey)) return null;
    try {
      const { data } = await this.req(account, `${account.ig_user_id}/insights`, params);
      return data.data ?? [];
    } catch (err) {
      if (isUnsupported(err)) {
        this.ctx.accounts.markUnsupportedMetric(account, metricKey);
        this.ctx.safety.event(account.org_id, account.id, 'info', 'metric_unavailable', `המדד "${METRIC_LABELS[metricKey] ?? metricKey}" אינו זמין לחשבון זה ב-Meta: ${err.message}`);
        return null;
      }
      throw err;
    }
  }

  async syncInsights(account: AccountRow, days = 3) {
    days = Math.min(Math.max(days, 1), 30);
    const now = this.ctx.now();
    const tz = this.ctx.accounts.settings(account.id).timezone;
    const stored: Record<string, number> = {};
    const bump = (m: string) => (stored[m] = (stored[m] ?? 0) + 1);

    // 1) Daily new followers (time series, last 30 days, requires 100+ followers per Meta).
    const since = Math.floor((now - days * DAY) / 1000);
    const until = Math.floor(now / 1000);
    const fc = await this.insight(account, 'new_followers', { metric: 'follower_count', period: 'day', since, until });
    for (const s of fc ?? []) {
      for (const v of s.values ?? []) {
        if (typeof v.value !== 'number' || !v.end_time) continue;
        const end = Date.parse(String(v.end_time).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
        if (Number.isNaN(end)) continue;
        this.upsertMetric(account.id, dayKey(end - 1, META_REPORTING_TZ), 'new_followers', v.value, 'insights');
        bump('new_followers');
      }
    }

    // 2) Per-day totals for engagement metrics, and follows/unfollows breakdown.
    const today = dayKey(now, tz);
    for (const day of daysBetween(addDays(today, -(days - 1)), today)) {
      const range = { since: Math.floor(startOfDay(day, tz) / 1000), until: Math.min(Math.floor(startOfDay(addDays(day, 1), tz) / 1000), until) };
      if (range.until <= range.since) continue;
      const wanted = TOTAL_VALUE_METRICS.filter((m) => !JSON.parse(account.unsupported_metrics).includes(m));
      let rows: any[] | null = null;
      if (wanted.length) {
        try {
          rows = (await this.req(account, `${account.ig_user_id}/insights`, { metric: wanted.join(','), metric_type: 'total_value', period: 'day', ...range })).data.data;
        } catch (err) {
          if (!isUnsupported(err)) throw err;
          // One metric in the group is not supported: fetch individually and remember the bad ones.
          rows = [];
          for (const m of wanted) rows.push(...((await this.insight(account, m, { metric: m, metric_type: 'total_value', period: 'day', ...range })) ?? []));
        }
      }
      for (const r of rows ?? []) {
        const v = r.total_value?.value;
        if (typeof v === 'number') {
          this.upsertMetric(account.id, day, r.name, v, 'insights');
          bump(r.name);
        }
      }
      const fu = await this.insight(account, 'follows_and_unfollows', { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day', breakdown: 'follow_type', ...range });
      for (const r of fu ?? []) {
        for (const b of r.total_value?.breakdowns ?? []) {
          for (const res of b.results ?? []) {
            const key = res.dimension_values?.[0];
            // Meta: FOLLOWER = accounts that followed, NON_FOLLOWER = accounts that unfollowed / left.
            const metric = key === 'FOLLOWER' ? 'follows' : key === 'NON_FOLLOWER' ? 'unfollows' : null;
            if (metric && typeof res.value === 'number') {
              this.upsertMetric(account.id, day, metric, res.value, 'insights');
              bump(metric);
            }
          }
        }
      }
    }
    return { days, stored };
  }

  private async mediaInsights(account: AccountRow, mediaId: string, metrics: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const attempt = async (list: string[]) => {
      const { data } = await this.req(account, `${mediaId}/insights`, { metric: list.join(',') });
      for (const r of data.data ?? []) {
        const v = r.total_value?.value ?? r.values?.[0]?.value;
        if (typeof v === 'number') out[r.name] = v;
      }
    };
    try {
      await attempt(metrics);
    } catch (err) {
      if (!isUnsupported(err)) throw err;
      try {
        await attempt(['reach', 'total_interactions']);
      } catch (e2) {
        if (!isUnsupported(e2)) throw e2;
      }
    }
    return out;
  }

  private saveMedia(accountId: string, m: any, insights: Record<string, number> | null) {
    this.ctx.db.run(
      `INSERT INTO media (account_id, id, media_type, media_product_type, caption, permalink, thumbnail_url, posted_at, like_count, comments_count, insights, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(account_id, id) DO UPDATE SET caption = excluded.caption, permalink = excluded.permalink, thumbnail_url = excluded.thumbnail_url,
         like_count = excluded.like_count, comments_count = excluded.comments_count,
         insights = CASE WHEN excluded.insights = '{}' THEN media.insights ELSE excluded.insights END, synced_at = excluded.synced_at`,
      accountId, String(m.id), m.media_type ?? null, m.media_product_type ?? null, m.caption?.slice(0, 2000) ?? null, m.permalink ?? null,
      m.thumbnail_url ?? m.media_url ?? null, m.timestamp ? Date.parse(m.timestamp) : null, m.like_count ?? null, m.comments_count ?? null,
      JSON.stringify(insights ?? {}), this.ctx.now(),
    );
  }

  async syncMedia(account: AccountRow, limit = 25) {
    const { data } = await this.req(account, `${account.ig_user_id}/media`, {
      fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url',
      limit,
    });
    const items: any[] = data.data ?? [];
    const cutoff = this.ctx.now() - 30 * DAY;
    let withInsights = 0;
    for (const m of items) {
      const recent = m.timestamp && Date.parse(m.timestamp) >= cutoff;
      const ins = recent ? await this.mediaInsights(account, m.id, MEDIA_METRICS) : null;
      if (ins && Object.keys(ins).length) withInsights++;
      this.saveMedia(account.id, m, ins);
    }
    return { media: items.length, withInsights };
  }

  /** Stories live 24h and their insights disappear with them — this captures them periodically. */
  async syncStories(account: AccountRow) {
    const { data } = await this.req(account, `${account.ig_user_id}/stories`, { fields: 'id,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url' });
    const items: any[] = data.data ?? [];
    for (const s of items) this.saveMedia(account.id, { ...s, media_product_type: 'STORY' }, await this.mediaInsights(account, s.id, STORY_METRICS));
    return { stories: items.length };
  }

  /** Business Discovery (Facebook-Login accounts only): public stats of another business/creator account. */
  async businessDiscovery(account: AccountRow, username: string) {
    if (account.provider !== 'facebook_login') throw badRequest('Business Discovery זמין רק לחשבונות שחוברו דרך Facebook Login');
    const { data } = await this.req(account, account.ig_user_id, {
      fields: `business_discovery.username(${username}){username,name,biography,followers_count,follows_count,media_count}`,
    });
    return data.business_discovery as { username: string; name?: string; biography?: string; followers_count?: number; follows_count?: number; media_count?: number };
  }

  async syncCompetitors(account: AccountRow) {
    const list = this.ctx.db.all<{ username: string }>('SELECT username FROM competitors WHERE account_id = ?', account.id);
    const day = dayKey(this.ctx.now(), this.ctx.accounts.settings(account.id).timezone);
    let ok = 0;
    for (const c of list) {
      try {
        const bd = await this.businessDiscovery(account, c.username);
        this.ctx.db.run(
          `INSERT INTO competitor_snapshots (account_id, username, day, followers_count, media_count, taken_at) VALUES (?,?,?,?,?,?)
           ON CONFLICT(account_id, username, day) DO UPDATE SET followers_count = excluded.followers_count, media_count = excluded.media_count, taken_at = excluded.taken_at`,
          account.id, c.username, day, bd.followers_count ?? null, bd.media_count ?? null, this.ctx.now(),
        );
        this.ctx.db.run('UPDATE competitors SET last_error = NULL WHERE account_id = ? AND username = ?', account.id, c.username);
        ok++;
      } catch (err) {
        if (!isUnsupported(err)) throw err;
        this.ctx.db.run('UPDATE competitors SET last_error = ? WHERE account_id = ? AND username = ?', 'החשבון אינו עסקי/יוצר או שאינו קיים', account.id, c.username);
      }
    }
    return { competitors: list.length, ok };
  }

  async enrichTargets(account: AccountRow, batch = 25) {
    const stale = this.ctx.now() - 14 * DAY;
    const targets = this.ctx.db.all<{ id: string; username: string }>(
      `SELECT id, username FROM targets WHERE account_id = ? AND (enriched_at IS NULL OR enriched_at < ?) AND (follow_wanted = 1 OR engage_stories = 1)
       ORDER BY enriched_at IS NOT NULL, created_at LIMIT ?`,
      account.id, stale, batch,
    );
    let ok = 0;
    for (const t of targets) {
      const now = this.ctx.now();
      try {
        const bd = await this.businessDiscovery(account, t.username);
        this.ctx.db.run(
          `UPDATE targets SET followers_count = ?, follows_count = ?, media_count = ?, display_name = ?, biography = ?, enrich_status = 'ok', enriched_at = ?, updated_at = ? WHERE id = ?`,
          bd.followers_count ?? null, bd.follows_count ?? null, bd.media_count ?? null, bd.name ?? null, bd.biography?.slice(0, 500) ?? null, now, now, t.id,
        );
        ok++;
      } catch (err) {
        if (!isUnsupported(err)) throw err;
        this.ctx.db.run(`UPDATE targets SET enrich_status = 'unavailable', enriched_at = ?, updated_at = ? WHERE id = ?`, now, now, t.id);
      }
    }
    return { checked: targets.length, enriched: ok };
  }

  // ───────────────────────────── Read side (reports) ─────────────────────────────

  private followersAt(accountId: string, ts: number): number | null {
    return this.ctx.db.get<{ f: number }>('SELECT followers_count AS f FROM follower_snapshots WHERE account_id = ? AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1', accountId, ts)?.f ?? null;
  }

  summary(account: AccountRow) {
    const now = this.ctx.now();
    const cur = account.followers_count;
    const change = (ms: number) => {
      const past = this.followersAt(account.id, now - ms);
      return cur !== null && past !== null ? cur - past : null;
    };
    const first = this.ctx.db.get<{ t: number }>('SELECT MIN(taken_at) AS t FROM follower_snapshots WHERE account_id = ?', account.id)?.t ?? null;
    return { followers: cur, follows: account.follows_count, media: account.media_count, change1d: change(DAY), change7d: change(7 * DAY), change30d: change(30 * DAY), trackingSince: first };
  }

  series(account: AccountRow, days: number) {
    days = Math.min(Math.max(days, 7), 365);
    const tz = this.ctx.accounts.settings(account.id).timezone;
    const today = dayKey(this.ctx.now(), tz);
    const from = addDays(today, -(days - 1));
    const rows = this.ctx.db.all<{ day: string; metric: string; value: number }>(
      'SELECT day, metric, value FROM daily_metrics WHERE account_id = ? AND day >= ? AND day <= ?',
      account.id, addDays(from, -1), today,
    );
    const map = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const o = map.get(r.day) ?? {};
      o[r.metric] = r.value;
      map.set(r.day, o);
    }
    let prev: number | undefined = map.get(addDays(from, -1))?.followers_count;
    return daysBetween(from, today).map((day) => {
      const m = map.get(day) ?? {};
      const f = m.followers_count;
      const net = f !== undefined && prev !== undefined ? f - prev : null;
      if (f !== undefined) prev = f;
      return { day, ...m, net_change: net };
    });
  }

  weekly(account: AccountRow) {
    const s = this.series(account, 14);
    const sum = (arr: any[], k: string) => {
      const vals = arr.map((d) => d[k]).filter((v) => typeof v === 'number');
      return vals.length ? vals.reduce((a: number, b: number) => a + b, 0) : null;
    };
    const prev = s.slice(0, 7);
    const cur = s.slice(7);
    const metrics = ['net_change', 'new_followers', 'follows', 'unfollows', 'reach', 'views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves'];
    const now = this.ctx.now();
    const posts = (from: number, to: number) =>
      this.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM media WHERE account_id = ? AND posted_at >= ? AND posted_at < ? AND (media_product_type IS NULL OR media_product_type != 'STORY')`, account.id, from, to)?.n ?? 0;
    const rows = metrics.map((m) => {
      const a = sum(cur, m);
      const b = sum(prev, m);
      return { metric: m, label: METRIC_LABELS[m] ?? 'שינוי נטו בעוקבים', current: a, previous: b, deltaPct: a !== null && b ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null };
    });
    const pc = posts(now - 7 * DAY, now);
    const pp = posts(now - 14 * DAY, now - 7 * DAY);
    rows.push({ metric: 'posts', label: 'פוסטים שפורסמו', current: pc, previous: pp, deltaPct: pp ? Math.round(((pc - pp) / pp) * 1000) / 10 : null });
    return rows;
  }

  topMedia(account: AccountRow, product: 'feed' | 'story', limit = 12) {
    const rows = this.ctx.db.all(
      `SELECT * FROM media WHERE account_id = ? AND ${product === 'story' ? "media_product_type = 'STORY'" : "(media_product_type IS NULL OR media_product_type != 'STORY')"}
       ORDER BY posted_at DESC LIMIT ?`,
      account.id, Math.min(limit, 100),
    );
    return rows.map((r) => ({ ...r, insights: JSON.parse(r.insights) }));
  }

  compare(orgId: string) {
    return this.ctx.accounts.list(orgId).map((a) => {
      const s = this.summary(a);
      const w = this.series(a, 7);
      const tot = (k: string) => w.reduce((acc, d: any) => (typeof d[k] === 'number' ? (acc ?? 0) + d[k] : acc), null as number | null);
      const interactions = tot('total_interactions');
      return {
        id: a.id, username: a.username, status: a.status, followers: s.followers, change7d: s.change7d, change30d: s.change30d,
        reach7d: tot('reach'), interactions7d: interactions,
        engagementRate: interactions !== null && s.followers ? Math.round((interactions / s.followers) * 10000) / 100 : null,
      };
    });
  }

  competitors(account: AccountRow) {
    const list = this.ctx.db.all('SELECT * FROM competitors WHERE account_id = ? ORDER BY username', account.id);
    return list.map((c) => {
      const snaps = this.ctx.db.all<{ day: string; followers_count: number }>(
        'SELECT day, followers_count FROM competitor_snapshots WHERE account_id = ? AND username = ? ORDER BY day DESC LIMIT 31', account.id, c.username,
      );
      const latest = snaps[0];
      const ago = (n: number) => snaps.find((s) => s.day <= addDays(latest?.day ?? '', -n));
      const d = (n: number) => (latest && ago(n) ? latest.followers_count - ago(n)!.followers_count : null);
      return { ...c, followers: latest?.followers_count ?? null, day: latest?.day ?? null, change7d: d(7), change30d: d(30), history: snaps.reverse() };
    });
  }

  addCompetitor(account: AccountRow, username: string) {
    if (account.provider !== 'facebook_login') throw badRequest('מעקב מתחרים דורש חיבור דרך Facebook Login (Business Discovery API)');
    this.ctx.db.run('INSERT OR IGNORE INTO competitors (account_id, username, created_at) VALUES (?,?,?)', account.id, username, this.ctx.now());
    this.ctx.queue.enqueue({ type: 'sync_competitors', orgId: account.org_id, accountId: account.id, dedupeKey: `sync_competitors:${account.id}` });
  }

  csv(account: AccountRow, days: number): string {
    const cols = ['day', 'followers_count', 'net_change', 'new_followers', 'follows', 'unfollows', 'reach', 'views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'profile_links_taps'];
    const lines = [cols.join(',')];
    for (const d of this.series(account, days) as any[]) lines.push(cols.map((c) => d[c] ?? '').join(','));
    return '﻿' + lines.join('\n');
  }
}
