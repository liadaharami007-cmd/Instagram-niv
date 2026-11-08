import type { Ctx } from '../context.ts';
import { newId } from '../lib/crypto.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { dayKey, DAY } from '../lib/time.ts';
import type { AccountRow, AccountSettings } from './accounts.ts';
import type { ManualType } from './safety.ts';

export const MANUAL_TYPES: ManualType[] = ['follow', 'unfollow', 'story_like'];
export type Outcome = 'done' | 'skipped' | 'failed' | 'no_story' | 'not_found';
const OUTCOMES = new Set<Outcome>(['done', 'skipped', 'failed', 'no_story', 'not_found']);

/** Official Instagram web links. On phones they open the Instagram app (universal links). */
export function instagramLink(type: ManualType, username: string): string {
  return type === 'story_like' ? `https://www.instagram.com/stories/${username}/` : `https://www.instagram.com/${username}/`;
}

/**
 * Follow / Unfollow / Story-like are NOT exposed by any official Meta API.
 * This service plans them as human tasks within safe limits, and records only what the
 * operator confirms was actually performed in Instagram.
 */
export class ManualTasksService {
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  private dailyLimit(s: AccountSettings, type: ManualType) {
    return type === 'follow' ? s.daily_follow_limit : type === 'unfollow' ? s.daily_unfollow_limit : s.daily_story_like_limit;
  }

  private candidatesSql(type: ManualType): string {
    const notQueued = `AND NOT EXISTS (SELECT 1 FROM manual_tasks m WHERE m.target_id = t.id AND m.type = '${type}'
                        AND (m.status = 'pending' OR (m.status IN ('skipped','failed','not_found','no_story') AND m.completed_at > ?)))`;
    switch (type) {
      case 'follow':
        // Never re-follow someone this account already unfollowed.
        return `SELECT t.id, t.username, t.segment FROM targets t WHERE t.account_id = ? AND t.follow_wanted = 1 AND t.i_follow = 0
                AND t.unfollowed_at IS NULL ${notQueued} ORDER BY t.created_at LIMIT ?`;
      case 'unfollow':
        return `SELECT t.id, t.username, t.followed_at FROM targets t WHERE t.account_id = ? AND t.i_follow = 1 AND t.whitelisted = 0
                AND (? = 0 OR t.follows_me = 0) AND t.followed_at IS NOT NULL AND t.followed_at <= ? ${notQueued} ORDER BY t.followed_at LIMIT ?`;
      case 'story_like':
        return `SELECT t.id, t.username FROM targets t WHERE t.account_id = ? AND t.engage_stories = 1
                AND (t.last_story_like_at IS NULL OR t.last_story_like_at <= ?) ${notQueued} ORDER BY t.last_story_like_at IS NOT NULL, t.last_story_like_at LIMIT ?`;
    }
  }

  /** Creates today's task list for each type, up to the remaining daily limit. Idempotent. */
  plan(account: AccountRow): { planned: Record<string, number>; skipped: Record<string, string> } {
    const now = this.ctx.now();
    const s = this.ctx.accounts.settings(account.id);
    const today = dayKey(now, s.timezone);
    const planned: Record<string, number> = {};
    const skipped: Record<string, string> = {};

    this.ctx.db.run(`UPDATE manual_tasks SET status = 'expired' WHERE account_id = ? AND status = 'pending' AND planned_day < ?`, account.id, today);

    if (account.status === 'disconnected' || account.status === 'restricted' || (account.status === 'paused' && (!account.paused_until || account.paused_until > now))) {
      for (const t of MANUAL_TYPES) skipped[t] = 'account_paused';
      return { planned, skipped };
    }
    if (account.manual_cooldown_until && account.manual_cooldown_until > now) {
      for (const t of MANUAL_TYPES) skipped[t] = 'cooldown';
      return { planned, skipped };
    }
    const lastImport = this.ctx.db.get<{ t: number }>('SELECT MAX(imported_at) AS t FROM relationship_imports WHERE account_id = ?', account.id)?.t;

    for (const type of MANUAL_TYPES) {
      const already = this.ctx.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM manual_tasks WHERE account_id = ? AND type = ? AND planned_day = ? AND status NOT IN ('cancelled','expired')`,
        account.id, type, today,
      )!.n;
      const remaining = this.dailyLimit(s, type) - already;
      if (remaining <= 0) {
        skipped[type] = 'limit_reached';
        continue;
      }
      if (type === 'unfollow' && s.unfollow_only_non_followers && !lastImport) {
        // Without real follower data we cannot know who follows back — refuse to guess.
        skipped[type] = 'needs_relationship_import';
        continue;
      }
      const retryWindow = now - 3 * DAY;
      const rows =
        type === 'follow'
          ? this.ctx.db.all(this.candidatesSql(type), account.id, retryWindow, remaining)
          : type === 'unfollow'
            ? this.ctx.db.all(this.candidatesSql(type), account.id, s.unfollow_only_non_followers, now - s.unfollow_after_days * DAY, retryWindow, remaining)
            : this.ctx.db.all(this.candidatesSql(type), account.id, now - s.story_like_interval_days * DAY, retryWindow, remaining);
      const reason =
        type === 'follow' ? 'קהל יעד' : type === 'unfollow' ? (s.unfollow_only_non_followers ? `לא עוקב בחזרה אחרי ${s.unfollow_after_days} ימים` : `נעקב מעל ${s.unfollow_after_days} ימים`) : 'מעורבות בסטוריז';
      let n = 0;
      this.ctx.db.tx(() => {
        for (const r of rows) {
          n += this.ctx.db.run(
            `INSERT OR IGNORE INTO manual_tasks (id, org_id, account_id, target_id, username, type, reason, planned_day, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
            newId('tsk'), account.org_id, account.id, r.id, r.username, type, type === 'follow' && r.segment ? `${reason}: ${r.segment}` : reason, today, now,
          ).changes;
        }
      });
      planned[type] = n;
      if (!n) skipped[type] = 'no_candidates';
    }
    return { planned, skipped };
  }

  list(account: AccountRow, opts: { type?: string; status?: string; day?: string; limit?: number }) {
    const s = this.ctx.accounts.settings(account.id);
    const day = opts.day ?? dayKey(this.ctx.now(), s.timezone);
    const rows = this.ctx.db.all(
      `SELECT m.*, u.name AS completed_by_name, t.segment, t.followers_count, t.follows_me, t.followed_at
         FROM manual_tasks m LEFT JOIN users u ON u.id = m.completed_by LEFT JOIN targets t ON t.id = m.target_id
        WHERE m.account_id = ? AND (? IS NULL OR m.type = ?) AND (? IS NULL OR m.status = ?) AND m.planned_day = ?
        ORDER BY CASE m.status WHEN 'pending' THEN 0 ELSE 1 END, m.created_at, m.id LIMIT ?`,
      account.id, opts.type ?? null, opts.type ?? null, opts.status ?? null, opts.status ?? null, day, Math.min(opts.limit ?? 200, 500),
    );
    return rows.map((r) => ({ ...r, link: instagramLink(r.type, r.username) }));
  }

  summary(account: AccountRow) {
    const s = this.ctx.accounts.settings(account.id);
    const day = dayKey(this.ctx.now(), s.timezone);
    const rows = this.ctx.db.all<{ type: string; status: string; n: number }>(
      'SELECT type, status, COUNT(*) AS n FROM manual_tasks WHERE account_id = ? AND planned_day = ? GROUP BY type, status', account.id, day,
    );
    const out: Record<string, any> = {};
    for (const type of MANUAL_TYPES) {
      const by = Object.fromEntries(rows.filter((r) => r.type === type).map((r) => [r.status, r.n]));
      out[type] = { byStatus: by, limit: this.dailyLimit(s, type), gate: this.ctx.safety.manualGate(account, s, type) };
    }
    return { day, ...out };
  }

  history(account: AccountRow, days = 30) {
    return this.ctx.db.all(
      `SELECT planned_day AS day, type, SUM(status = 'done') AS done, SUM(status IN ('skipped','no_story','not_found')) AS skipped,
              SUM(status = 'failed') AS failed, SUM(status = 'expired') AS expired
         FROM manual_tasks WHERE account_id = ? AND planned_day >= ? GROUP BY planned_day, type ORDER BY planned_day`,
      account.id, dayKey(this.ctx.now() - days * DAY, this.ctx.accounts.settings(account.id).timezone),
    );
  }

  /** Next task for the operator, plus whether pacing allows doing it now. */
  next(account: AccountRow, type: ManualType) {
    const s = this.ctx.accounts.settings(account.id);
    const gate = this.ctx.safety.manualGate(account, s, type);
    const task = this.ctx.db.get(
      `SELECT * FROM manual_tasks WHERE account_id = ? AND type = ? AND status = 'pending' AND planned_day = ? ORDER BY created_at, id LIMIT 1`,
      account.id, type, dayKey(this.ctx.now(), s.timezone),
    );
    return { gate, task: task ? { ...task, link: instagramLink(type, task.username) } : null };
  }

  /**
   * Records the operator's confirmation. Only 'done' changes relationship state.
   * The pacing gate is enforced before a task may be confirmed as done.
   */
  complete(orgId: string, taskId: string, outcome: string, userId: string, note?: string, force = false) {
    if (!OUTCOMES.has(outcome as Outcome)) throw badRequest('תוצאה לא תקינה');
    const task = this.ctx.db.get('SELECT * FROM manual_tasks WHERE id = ? AND org_id = ?', taskId, orgId);
    if (!task) throw notFound('המשימה');
    if (task.status !== 'pending') throw conflict('המשימה כבר טופלה');
    const account = this.ctx.accounts.get(orgId, task.account_id);
    const s = this.ctx.accounts.settings(account.id);
    if (outcome === 'done') {
      const gate = this.ctx.safety.manualGate(account, s, task.type);
      if (!gate.allowed && !force) throw conflict(`לא ניתן לאשר כעת: ${gate.reason}`, { gate });
      if (!gate.allowed && force) {
        this.ctx.safety.event(orgId, account.id, 'warning', 'limit_override', `פעולה ידנית אושרה מעבר למגבלת הבטיחות (${gate.reason})`, { taskId, userId });
      }
    }
    const now = this.ctx.now();
    this.ctx.db.tx(() => {
      this.ctx.db.run('UPDATE manual_tasks SET status = ?, completed_at = ?, completed_by = ?, note = ? WHERE id = ?', outcome, now, userId, note?.slice(0, 300) ?? null, taskId);
      if (outcome === 'done') {
        if (task.type === 'follow') this.ctx.db.run('UPDATE targets SET i_follow = 1, followed_at = ?, updated_at = ? WHERE id = ?', now, now, task.target_id);
        if (task.type === 'unfollow') this.ctx.db.run('UPDATE targets SET i_follow = 0, unfollowed_at = ?, updated_at = ? WHERE id = ?', now, now, task.target_id);
        if (task.type === 'story_like') this.ctx.db.run('UPDATE targets SET last_story_like_at = ?, updated_at = ? WHERE id = ?', now, now, task.target_id);
      }
      if (outcome === 'not_found') this.ctx.db.run('UPDATE targets SET follow_wanted = 0, engage_stories = 0, updated_at = ? WHERE id = ?', now, task.target_id);
    });
    this.ctx.audit.record(orgId, `manual.${task.type}.${outcome}`, { userId, accountId: account.id, details: { username: task.username, taskId, note, forced: force || undefined } });
    return this.next(account, task.type);
  }

  /** Records an action the operator performed outside the planned list (e.g. spontaneous follow). */
  logAdHoc(account: AccountRow, type: ManualType, rawUsername: string, userId: string, normalize: (s: string) => string | null) {
    const username = normalize(rawUsername);
    if (!username) throw badRequest('שם משתמש לא תקין');
    const s = this.ctx.accounts.settings(account.id);
    this.ctx.targets.add(account, userId, username, { source: 'manual', followWanted: type === 'follow', engageStories: type === 'story_like' });
    const target = this.ctx.db.get<{ id: string }>('SELECT id FROM targets WHERE account_id = ? AND username = ?', account.id, username)!;
    const id = newId('tsk');
    const day = dayKey(this.ctx.now(), s.timezone);
    const r = this.ctx.db.run(
      `INSERT OR IGNORE INTO manual_tasks (id, org_id, account_id, target_id, username, type, reason, planned_day, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, account.org_id, account.id, target.id, username, type, 'פעולה ידנית שנרשמה', day, this.ctx.now(),
    );
    const taskId = r.changes ? id : this.ctx.db.get<{ id: string }>(`SELECT id FROM manual_tasks WHERE account_id = ? AND type = ? AND target_id = ? AND planned_day = ?`, account.id, type, target.id, day)!.id;
    return this.complete(account.org_id, taskId, 'done', userId, 'נרשם ידנית', true);
  }
}
