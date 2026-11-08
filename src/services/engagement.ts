import type { Ctx } from '../context.ts';
import { decrypt } from '../lib/crypto.ts';
import { dayKey, hourIn, startOfDay, DAY, HOUR } from '../lib/time.ts';
import { MetaApiError } from '../meta/errors.ts';
import { badRequest } from '../lib/errors.ts';
import type { AccountRow } from './accounts.ts';

/**
 * Automatic likes through Meta's official Likes API
 * (POST /{ig-user-id}/likes, Instagram API with Facebook Login, permission instagram_manage_engagement).
 *
 * Supported by Meta: Feed images, Reels and Carousels of public accounts.
 * NOT supported by Meta: Stories, private accounts, follow/unfollow (no endpoint exists).
 *
 * Pipeline: auto_like_plan (hourly) finds fresh posts of target accounts via Business Discovery,
 * queues spaced like_media jobs within daily/hourly budgets; like_media performs the real call and
 * records success only when Meta answers { success: true }.
 */
export class EngagementService {
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  /** Why the engine cannot run for this account, or null if it can. */
  blocker(account: AccountRow): string | null {
    if (account.is_demo) return 'חשבון הדגמה — אין חיבור ל-Meta';
    if (account.provider !== 'facebook_login') return 'ה-API הרשמי ללייקים זמין רק לחשבונות שחוברו דרך Facebook Login';
    if (!account.user_token_enc) return 'חסר טוקן משתמש של פייסבוק — יש לחבר מחדש דרך Facebook Login';
    if (account.user_token_expires_at && account.user_token_expires_at < this.ctx.now()) return 'טוקן המשתמש של פייסבוק פג — יש לחבר מחדש';
    return null;
  }

  private userToken(account: AccountRow) {
    return decrypt(account.user_token_enc!, this.ctx.config.encryptionKey);
  }

  private counts(accountId: string, tz: string) {
    const now = this.ctx.now();
    const dayStart = startOfDay(dayKey(now, tz), tz);
    const q = (sql: string, ...p: (string | number)[]) => this.ctx.db.get<{ n: number }>(sql, ...p)!.n;
    return {
      doneToday: q(`SELECT COUNT(*) AS n FROM engagement_actions WHERE account_id = ? AND status = 'done' AND executed_at >= ?`, accountId, dayStart),
      queued: q(`SELECT COUNT(*) AS n FROM engagement_actions WHERE account_id = ? AND status = 'queued'`, accountId),
      doneLastHour: q(`SELECT COUNT(*) AS n FROM engagement_actions WHERE account_id = ? AND status = 'done' AND executed_at >= ?`, accountId, now - HOUR),
    };
  }

  /** Finds fresh posts of target accounts and queues spaced like jobs within the budgets. */
  async plan(account: AccountRow) {
    const block = this.blocker(account);
    if (block) return { skipped: block };
    const s = this.ctx.accounts.settings(account.id);
    const now = this.ctx.now();
    const hour = hourIn(now, s.timezone);
    if (hour < s.active_hour_start || hour >= s.active_hour_end) return { skipped: 'outside active hours' };
    const c = this.counts(account.id, s.timezone);
    const budget = Math.min(s.daily_like_limit - c.doneToday - c.queued, s.likes_per_hour - c.queued);
    if (budget <= 0) return { skipped: 'budget exhausted', ...c };

    const targets = this.ctx.db.all<{ id: string; username: string }>(
      `SELECT id, username FROM targets WHERE account_id = ? AND auto_like = 1 AND COALESCE(enrich_status, '') != 'unavailable'
       ORDER BY last_auto_like_check_at IS NOT NULL, last_auto_like_check_at LIMIT ?`,
      account.id, Math.min(budget * 2, 20),
    );
    const spacing = Math.floor(HOUR / s.likes_per_hour);
    const minTime = now - s.like_media_max_age_days * DAY;
    let queued = 0;
    let checked = 0;
    let unavailable = 0;
    for (const t of targets) {
      if (queued >= budget) break;
      checked++;
      this.ctx.db.run('UPDATE targets SET last_auto_like_check_at = ? WHERE id = ?', now, t.id);
      let media: any[];
      try {
        const { data } = await this.ctx.graph.request<any>({
          provider: 'facebook_login', token: this.ctx.accounts.token(account), accountId: account.id, path: account.ig_user_id,
          params: { fields: `business_discovery.username(${t.username}){media.limit(6){id,timestamp,media_type,media_product_type,permalink}}` },
        });
        media = data.business_discovery?.media?.data ?? [];
      } catch (err) {
        if (err instanceof MetaApiError && err.kind === 'invalid_request') {
          // Personal or private account, or username does not exist: Meta exposes no posts for it.
          this.ctx.db.run(`UPDATE targets SET enrich_status = 'unavailable', enriched_at = ? WHERE id = ?`, now, t.id);
          unavailable++;
          continue;
        }
        throw err;
      }
      const pick = media.find(
        (m) =>
          m.id && m.media_product_type !== 'STORY' && (!m.timestamp || Date.parse(String(m.timestamp).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) >= minTime) &&
          !this.ctx.db.get('SELECT 1 FROM engagement_actions WHERE account_id = ? AND media_id = ?', account.id, String(m.id)),
      );
      if (!pick) continue;
      const runAt = now + queued * spacing + Math.floor(Math.random() * spacing * 0.5) + 15_000;
      const r = this.ctx.db.run(
        `INSERT OR IGNORE INTO engagement_actions (org_id, account_id, target_username, media_id, media_type, permalink, action, status, run_at, created_at)
         VALUES (?,?,?,?,?,?, 'like', 'queued', ?, ?)`,
        account.org_id, account.id, t.username, String(pick.id), pick.media_product_type ?? pick.media_type ?? null, pick.permalink ?? null, runAt, now,
      );
      if (!r.changes) continue;
      this.ctx.queue.enqueue({ type: 'like_media', orgId: account.org_id, accountId: account.id, runAt, maxAttempts: 4, payload: { actionId: r.lastInsertRowid }, dedupeKey: `like:${r.lastInsertRowid}` });
      queued++;
    }
    return { checkedTargets: checked, queued, unavailableTargets: unavailable, budget };
  }

  /** Performs one like. Success is recorded only on Meta's { success: true }. */
  async like(account: AccountRow, actionId: number) {
    const a = this.ctx.db.get<{ id: number; media_id: string; status: string }>('SELECT * FROM engagement_actions WHERE id = ? AND account_id = ?', actionId, account.id);
    if (!a || a.status !== 'queued') return { skipped: a?.status ?? 'missing' };
    const block = this.blocker(account);
    if (block) return this.finish(actionId, 'cancelled', block);
    const s = this.ctx.accounts.settings(account.id);
    const c = this.counts(account.id, s.timezone);
    if (c.doneToday >= s.daily_like_limit) return this.finish(actionId, 'cancelled', 'הגעת למגבלה היומית');
    try {
      const { data } = await this.ctx.graph.request<any>({
        provider: 'facebook_login', token: this.userToken(account), accountId: account.id, method: 'POST', path: `${account.ig_user_id}/likes`, params: { media_id: a.media_id },
      });
      if (data?.success === true) return this.finish(actionId, 'done', null);
      return this.finish(actionId, 'failed', `Meta לא אישרה את הלייק: ${JSON.stringify(data).slice(0, 200)}`);
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      if (err.kind === 'invalid_request') return this.finish(actionId, 'failed', `${err.userMessage}: ${err.message}`);
      if (err.kind === 'permission') {
        this.finish(actionId, 'failed', `${err.userMessage}: ${err.message}`);
        this.stop(account, 'חסרה הרשאת instagram_manage_engagement — המנוע נעצר');
      }
      throw err; // rate limits / blocks / token problems go through the safety engine
    }
  }

  finish(actionId: number, status: 'done' | 'failed' | 'cancelled', error: string | null) {
    this.ctx.db.run(`UPDATE engagement_actions SET status = ?, error = ?, executed_at = ? WHERE id = ? AND status = 'queued'`, status, error, this.ctx.now(), actionId);
    return { status, error };
  }

  cancelQueued(account: AccountRow, reason: string) {
    const now = this.ctx.now();
    this.ctx.db.run(`UPDATE jobs SET status = 'cancelled', finished_at = ?, last_error = ? WHERE account_id = ? AND type = 'like_media' AND status = 'queued'`, now, reason, account.id);
    return this.ctx.db.run(`UPDATE engagement_actions SET status = 'cancelled', error = ?, executed_at = ? WHERE account_id = ? AND status = 'queued'`, reason, now, account.id).changes;
  }

  start(account: AccountRow, userId: string) {
    const block = this.blocker(account);
    if (block) throw badRequest(block);
    this.ctx.db.run(`UPDATE schedules SET enabled = 1, next_run_at = ? WHERE account_id = ? AND job_type = 'auto_like_plan'`, this.ctx.now(), account.id);
    this.ctx.queue.enqueue({ type: 'auto_like_plan', orgId: account.org_id, accountId: account.id, priority: 20, dedupeKey: `auto_like_plan:${account.id}` });
    this.ctx.audit.record(account.org_id, 'engine.likes_started', { userId, accountId: account.id });
  }

  stop(account: AccountRow, reason: string, userId: string | null = null) {
    this.ctx.db.run(`UPDATE schedules SET enabled = 0 WHERE account_id = ? AND job_type = 'auto_like_plan'`, account.id);
    this.ctx.db.run(`UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE account_id = ? AND type = 'auto_like_plan' AND status = 'queued'`, this.ctx.now(), account.id);
    const n = this.cancelQueued(account, reason);
    if (userId) this.ctx.audit.record(account.org_id, 'engine.likes_stopped', { userId, accountId: account.id, details: { cancelled: n } });
    else this.ctx.safety.event(account.org_id, account.id, 'warning', 'likes_engine_stopped', reason);
  }

  status(account: AccountRow) {
    const s = this.ctx.accounts.settings(account.id);
    const sched = this.ctx.db.get<{ enabled: number; next_run_at: number }>(`SELECT enabled, next_run_at FROM schedules WHERE account_id = ? AND job_type = 'auto_like_plan'`, account.id);
    const week = this.ctx.db.get<{ done: number; failed: number }>(
      `SELECT SUM(status = 'done') AS done, SUM(status = 'failed') AS failed FROM engagement_actions WHERE account_id = ? AND created_at > ?`, account.id, this.ctx.now() - 7 * DAY,
    );
    const targets = this.ctx.db.get<{ total: number; unavailable: number }>(
      `SELECT COUNT(*) AS total, SUM(COALESCE(enrich_status, '') = 'unavailable') AS unavailable FROM targets WHERE account_id = ? AND auto_like = 1`, account.id,
    );
    return {
      blocker: this.blocker(account),
      running: !!sched?.enabled,
      nextRunAt: sched?.enabled ? sched.next_run_at : null,
      limits: { daily: s.daily_like_limit, perHour: s.likes_per_hour, maxAgeDays: s.like_media_max_age_days },
      ...this.counts(account.id, s.timezone),
      week: { done: week?.done ?? 0, failed: week?.failed ?? 0 },
      targets: { total: targets?.total ?? 0, unavailable: targets?.unavailable ?? 0 },
      actions: this.ctx.db.all('SELECT * FROM engagement_actions WHERE account_id = ? ORDER BY id DESC LIMIT 100', account.id),
    };
  }
}
