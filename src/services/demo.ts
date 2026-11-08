import type { Ctx } from '../context.ts';
import { encrypt, newId } from '../lib/crypto.ts';
import { addDays, dayKey, startOfDay, DAY, HOUR } from '../lib/time.ts';
import type { AccountRow } from './accounts.ts';

/**
 * Demo workspace: a clearly-flagged sample account (is_demo = 1) for presentations and
 * training. It never calls Meta, is labelled "הדגמה" everywhere in the UI, and lives in
 * its own account row so it can never mix with real accounts' data.
 */
const TZ = 'Asia/Jerusalem';
const SEGMENTS = ['לקוחות פוטנציאליים', 'קהל של מתחרים', 'שיתופי פעולה'];
const WORDS = ['cafe', 'studio', 'design', 'fit', 'beauty', 'travel', 'food', 'home', 'style', 'art', 'shop', 'photo'];
const CITIES = ['tlv', 'jlm', 'haifa', 'eilat', 'herzliya', 'ramat'];

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const thumb = (hue: number) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},80%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},75%,45%)"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><circle cx="72" cy="30" r="12" fill="rgba(255,255,255,.55)"/><path d="M0 80 L30 55 L55 75 L75 60 L100 80 V100 H0Z" fill="rgba(255,255,255,.35)"/></svg>`,
  );

export class DemoService {
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  existing(orgId: string): AccountRow | undefined {
    return this.ctx.db.get<AccountRow>('SELECT * FROM ig_accounts WHERE org_id = ? AND is_demo = 1', orgId);
  }

  create(orgId: string, userId: string): AccountRow {
    const found = this.existing(orgId);
    if (found) return found;
    const { db } = this.ctx;
    const r = rng(42);
    const now = this.ctx.now();
    const today = dayKey(now, TZ);
    const id = newId('acc');
    const days = 90;

    db.tx(() => {
      db.run(
        `INSERT INTO ig_accounts (id, org_id, provider, ig_user_id, username, name, account_type, access_token_enc, granted_scopes, is_demo, created_at, updated_at, last_synced_at)
         VALUES (?,?, 'facebook_login', ?, 'niv.demo', 'חשבון הדגמה', 'BUSINESS', ?, ?, 1, ?, ?, ?)`,
        id, orgId, `demo-${id}`, encrypt('demo-account-has-no-token', this.ctx.config.encryptionKey),
        JSON.stringify(['demo']), now - days * DAY, now, now - 20 * 60_000,
      );
      db.run(`INSERT INTO account_settings (account_id, min_action_gap_sec, active_hour_start, active_hour_end) VALUES (?, 15, 0, 24)`, id);
      db.run(`INSERT INTO schedules (account_id, org_id, job_type, interval_sec, enabled, next_run_at) VALUES (?,?, 'plan_manual_tasks', 3600, 1, ?)`, id, orgId, now + HOUR);

      // ── Growth history ──
      const metric = db.raw.prepare(`INSERT INTO daily_metrics (account_id, day, metric, value, source, updated_at) VALUES (?,?,?,?, 'demo', ?)`);
      const snap = db.raw.prepare(`INSERT INTO follower_snapshots (account_id, taken_at, followers_count, follows_count, media_count) VALUES (?,?,?,?,?)`);
      let followers = 4180;
      let follows = 602;
      let mediaCount = 118;
      const postDays = new Set<number>();
      for (let i = days; i >= 1; i -= 3) postDays.add(i - Math.floor(r() * 2));
      for (let i = days; i >= 0; i--) {
        const day = addDays(today, -i);
        const isPost = postDays.has(i);
        const trend = 9 + 7 * Math.sin((days - i) / 10) + (days - i) * 0.08;
        const unf = Math.round(3 + r() * 6);
        const net = Math.round(trend + (r() - 0.45) * 14 + (isPost ? 12 : 0));
        followers += net;
        follows += Math.round((r() - 0.4) * 4);
        if (isPost) mediaCount++;
        const ts = i === 0 ? now : startOfDay(day, TZ) + 21 * HOUR;
        snap.run(id, ts, followers, follows, mediaCount);
        const reach = Math.round((1700 + r() * 900) * (isPost ? 1.9 : 1) * (1 + (days - i) / 300));
        const ti = Math.round(reach * (0.055 + r() * 0.03));
        const vals: Record<string, number> = {
          followers_count: followers, follows_count: follows, media_count: mediaCount,
          new_followers: net + unf, follows: net + unf, unfollows: unf,
          reach, views: Math.round(reach * (2.1 + r() * 0.6)), accounts_engaged: Math.round(reach * 0.085),
          total_interactions: ti, likes: Math.round(ti * 0.74), comments: Math.round(ti * 0.08), shares: Math.round(ti * 0.07), saves: Math.round(ti * 0.11),
          profile_links_taps: Math.round(6 + r() * 22),
        };
        for (const [k, v] of Object.entries(vals)) metric.run(id, day, k, v, now);
      }
      db.run('UPDATE ig_accounts SET followers_count = ?, follows_count = ?, media_count = ? WHERE id = ?', followers, follows, mediaCount, id);

      // ── Posts and stories ──
      const media = db.raw.prepare(
        `INSERT INTO media (account_id, id, media_type, media_product_type, caption, permalink, thumbnail_url, posted_at, like_count, comments_count, insights, synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      let n = 0;
      for (const d of [...postDays].filter((d) => d > 0 && d <= 45).sort((a, b) => a - b)) {
        const reach = Math.round(2600 + r() * 4200);
        const reel = n % 3 === 0;
        const ti = Math.round(reach * (0.06 + r() * 0.05));
        media.run(id, `demo_post_${n}`, reel ? 'VIDEO' : 'IMAGE', reel ? 'REELS' : 'FEED', `פוסט הדגמה ${n + 1}`, null, thumb((n * 47) % 360),
          now - d * DAY - 3 * HOUR, Math.round(ti * 0.8), Math.round(ti * 0.08),
          JSON.stringify({ reach, views: Math.round(reach * (reel ? 3.4 : 1.6)), saved: Math.round(ti * 0.12), shares: Math.round(ti * 0.07), total_interactions: ti }), now);
        n++;
      }
      for (let s = 0; s < 6; s++) {
        const reach = Math.round(600 + r() * 700);
        media.run(id, `demo_story_${s}`, 'IMAGE', 'STORY', null, null, thumb((s * 61 + 200) % 360), now - (s * 7 + 2) * HOUR, null, null,
          JSON.stringify({ reach, views: Math.round(reach * 1.3), replies: Math.round(r() * 9), shares: Math.round(r() * 6), total_interactions: Math.round(reach * 0.05) }), now);
      }

      // ── Competitors ──
      for (const [name, base, growth] of [['competitor.studio_demo', 12400, 22], ['brand.rival_demo', 8100, 9], ['local.shop_demo', 5600, 14]] as const) {
        db.run('INSERT INTO competitors (account_id, username, created_at) VALUES (?,?,?)', id, name, now - 40 * DAY);
        for (let i = 30; i >= 0; i--)
          db.run('INSERT INTO competitor_snapshots (account_id, username, day, followers_count, media_count, taken_at) VALUES (?,?,?,?,?,?)',
            id, name, addDays(today, -i), Math.round(base + (30 - i) * growth + (r() - 0.5) * 30), 300, now);
      }

      // ── Audience (targets) ──
      const tgt = db.raw.prepare(
        `INSERT INTO targets (id, org_id, account_id, username, segment, source, i_follow, follows_me, followed_at, follows_me_since, whitelisted, follow_wanted, engage_stories,
           followers_count, media_count, enrich_status, enriched_at, created_at, updated_at) VALUES (?,?,?,?,?, 'demo', ?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const ids: { id: string; kind: string }[] = [];
      const used = new Set<string>();
      const handle = () => {
        let u: string;
        do u = `${WORDS[Math.floor(r() * WORDS.length)]}.${CITIES[Math.floor(r() * CITIES.length)]}${Math.floor(r() * 90 + 10)}_demo`;
        while (used.has(u));
        used.add(u);
        return u;
      };
      const add = (kind: string, count: number, f: (i: number) => [number, number, number | null, number, number, number]) => {
        for (let i = 0; i < count; i++) {
          const tid = newId('tgt');
          const [iFollow, followsMe, followedAgo, wl, want, stories] = f(i);
          const followedAt = followedAgo === null ? null : now - followedAgo * DAY;
          tgt.run(tid, orgId, id, handle(), SEGMENTS[i % SEGMENTS.length], iFollow, followsMe, followedAt, followsMe ? now - 60 * DAY : null, wl, want, stories,
            Math.round(800 + r() * 20000), Math.round(40 + r() * 600), 'ok', now - 2 * DAY, now - (100 - i) * 60_000, now);
          ids.push({ id: tid, kind });
        }
      };
      add('to_follow', 45, () => [0, 0, null, 0, 1, 0]);
      add('non_follower', 18, (i) => [1, 0, 9 + i * 2, i < 3 ? 1 : 0, 1, i % 2]);
      add('mutual', 14, () => [1, 1, 40, 0, 1, 1]);
      add('fan', 12, () => [0, 1, null, 0, 0, 0]);
      add('stories', 10, () => [0, 0, null, 0, 0, 1]);
      db.run(`INSERT INTO relationship_imports (id, account_id, imported_at, imported_by, followers_total, following_total, new_followers, lost_followers, lost_usernames, files)
              VALUES (?,?,?,?,?,?,?,?,?,?)`, newId('imp'), id, now - 3 * DAY, userId, followers, follows, 64, 2, JSON.stringify(['old.client_demo', 'quiet.fan_demo']), JSON.stringify(['followers_1.json', 'following.json']));

      // ── 14 days of manual work history ──
      const task = db.raw.prepare(
        `INSERT INTO manual_tasks (id, org_id, account_id, target_id, username, type, status, reason, planned_day, created_at, completed_at, completed_by)
         SELECT ?, ?, ?, t.id, t.username, ?, ?, 'היסטוריית הדגמה', ?, ?, ?, ? FROM targets t WHERE t.id = ?`,
      );
      let k = 0;
      for (let i = 14; i >= 1; i--) {
        const day = addDays(today, -i);
        const base = startOfDay(day, TZ) + 10 * HOUR;
        for (const [type, count] of [['follow', 14 + Math.floor(r() * 9)], ['unfollow', 6 + Math.floor(r() * 6)], ['story_like', 18 + Math.floor(r() * 12)]] as const) {
          for (let j = 0; j < count; j++) {
            const t = ids[k++ % ids.length];
            const status = r() < 0.86 ? 'done' : r() < 0.6 ? 'skipped' : type === 'story_like' ? 'no_story' : 'failed';
            task.run(newId('tsk'), orgId, id, type, status, day, base, base + j * 4 * 60_000, userId, t.id);
          }
        }
      }

      this.ctx.safety.event(orgId, id, 'warning', 'usage_high', 'ניצול מכסת ה-API גבוה (78%) — הדגמה', {});
      this.ctx.safety.event(orgId, id, 'info', 'auto_resumed', 'ההשהיה הסתיימה — החשבון חזר לפעילות (הדגמה)', {});
      this.ctx.audit.record(orgId, 'demo.created', { userId, accountId: id });
    });
    const account = this.ctx.accounts.findById(id)!;
    this.ctx.tasks.plan(account);
    return account;
  }
}
