import type { Ctx } from '../context.ts';
import type { MetaApiError, UsageInfo } from '../meta/errors.ts';
import { addDays, dayKey, hourIn, startOfDay, HOUR, MINUTE } from '../lib/time.ts';
import type { AccountRow, AccountSettings } from './accounts.ts';

export type ManualType = 'follow' | 'unfollow' | 'story_like';

/** Hard ceilings users cannot exceed through settings. */
export const HARD_LIMITS = {
  daily_follow_limit: 100,
  daily_unfollow_limit: 100,
  daily_story_like_limit: 200,
  hourly_action_limit: 40,
  min_action_gap_sec: 10,
} as const;

const USAGE_THROTTLE_PCT = 90;
const USAGE_WARN_PCT = 75;
const CIRCUIT_BREAKER_FAILURES = 5;

export interface ApiGate {
  ok: boolean;
  /** When not ok and set, the job should be deferred until this time. */
  retryAt?: number;
  /** When not ok and true, the job should be dropped (needs user action). */
  blocked?: boolean;
  reason?: string;
}

export interface ManualGate {
  allowed: boolean;
  reason: string | null;
  nextAllowedAt: number | null;
  doneToday: number;
  dailyLimit: number;
  doneLastHour: number;
  hourlyLimit: number;
}

/**
 * Meta Account Safety: interprets API errors and usage headers, pauses accounts before
 * Meta does, and enforces conservative pacing on the manual action workflows.
 */
export class SafetyService {
  private readonly ctx: Ctx;
  private lastUsageWarn = new Map<string, number>();

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  event(orgId: string, accountId: string | null, level: 'info' | 'warning' | 'critical', code: string, message: string, details: unknown = {}) {
    this.ctx.db.run(
      'INSERT INTO safety_events (org_id, account_id, level, code, message, details, created_at) VALUES (?,?,?,?,?,?,?)',
      orgId,
      accountId,
      level,
      code,
      message,
      JSON.stringify(details),
      this.ctx.now(),
    );
    this.ctx.log[level === 'critical' ? 'error' : level === 'warning' ? 'warn' : 'info']({ accountId, code }, message);
  }

  events(orgId: string, accountId: string, limit = 50) {
    return this.ctx.db
      .all('SELECT * FROM safety_events WHERE org_id = ? AND account_id = ? ORDER BY id DESC LIMIT ?', orgId, accountId, limit)
      .map((r) => ({ ...r, details: JSON.parse(r.details) }));
  }

  /** Decides whether an API job for this account may run right now. Auto-resumes expired pauses. */
  checkApi(account: AccountRow): ApiGate {
    const now = this.ctx.now();
    if (account.status === 'disconnected') return { ok: false, blocked: true, reason: 'החשבון נותק' };
    if (account.status === 'needs_reauth') return { ok: false, blocked: true, reason: 'נדרש חיבור מחדש של החשבון' };
    if (account.status === 'paused' || account.status === 'restricted') {
      if (account.paused_until && account.paused_until <= now) {
        this.resume(account, null, 'auto');
        return { ok: true };
      }
      return { ok: false, retryAt: account.paused_until ?? now + HOUR, reason: account.pause_reason ?? 'החשבון מושהה' };
    }
    return { ok: true };
  }

  apiSucceeded(accountId: string) {
    this.ctx.db.run('UPDATE ig_accounts SET consecutive_failures = 0 WHERE id = ? AND consecutive_failures > 0', accountId);
  }

  /**
   * Applies the safety policy for a failed Graph call.
   * Returns how the queue should treat the job.
   */
  apiFailed(account: AccountRow, err: MetaApiError): { action: 'retry' | 'defer' | 'drop'; retryAt?: number } {
    const now = this.ctx.now();
    const details = err.toJSON();
    this.ctx.db.run('UPDATE ig_accounts SET last_error = ?, updated_at = ? WHERE id = ?', `${err.userMessage}: ${err.message}`.slice(0, 500), now, account.id);
    switch (err.kind) {
      case 'token_invalid': {
        this.ctx.db.run(`UPDATE ig_accounts SET status = 'needs_reauth', updated_at = ? WHERE id = ?`, now, account.id);
        const n = this.ctx.queue.cancelForAccount(account.id, 'token invalid');
        this.event(account.org_id, account.id, 'critical', 'token_invalid', `${err.userMessage}. ${n} משימות בוטלו.`, details);
        return { action: 'drop' };
      }
      case 'policy_block': {
        const until = now + 24 * HOUR;
        this.pause(account, until, 'Meta חסמה זמנית פעולות (מדיניות)', null, 'restricted');
        this.event(account.org_id, account.id, 'critical', 'policy_block', `${err.userMessage}. השהיה עד ${new Date(until).toISOString()}`, details);
        return { action: 'defer', retryAt: until };
      }
      case 'rate_limit': {
        const until = now + Math.max(err.retryAfterSec ? err.retryAfterSec * 1000 : HOUR, 5 * MINUTE);
        this.pause(account, until, 'מגבלת קריאות API של Meta', null);
        this.event(account.org_id, account.id, 'warning', 'rate_limit', `${err.userMessage}. חידוש אוטומטי ב-${new Date(until).toISOString()}`, details);
        return { action: 'defer', retryAt: until };
      }
      case 'permission':
        this.event(account.org_id, account.id, 'warning', 'permission_missing', `${err.userMessage}: ${err.message}`, details);
        return { action: 'drop' };
      case 'invalid_request':
        return { action: 'drop' };
      case 'transient':
      default: {
        const fails = (this.ctx.db.get<{ c: number }>(
          'UPDATE ig_accounts SET consecutive_failures = consecutive_failures + 1 WHERE id = ? RETURNING consecutive_failures AS c',
          account.id,
        )?.c ?? 1);
        if (fails >= CIRCUIT_BREAKER_FAILURES) {
          const until = now + HOUR;
          this.pause(account, until, `מפסק זרם: ${fails} כשלים רצופים`, null);
          this.event(account.org_id, account.id, 'warning', 'circuit_breaker', `${fails} כשלים רצופים מול Meta — החשבון הושהה לשעה כדי למנוע הסלמה`, details);
          return { action: 'defer', retryAt: until };
        }
        return { action: 'retry' };
      }
    }
  }

  /** Called for every Graph response that carries usage headers. */
  onUsage(accountId: string, usage: UsageInfo) {
    const account = this.ctx.accounts.findById(accountId);
    if (!account) return;
    const now = this.ctx.now();
    if (usage.maxPct >= USAGE_THROTTLE_PCT || usage.regainMinutes > 0) {
      const until = now + Math.max(usage.regainMinutes * MINUTE, 15 * MINUTE);
      if (account.status === 'active') {
        this.pause(account, until, `ניצול API ${usage.maxPct}% — האטה מונעת`, null);
        this.event(account.org_id, accountId, 'warning', 'usage_throttle', `ניצול מכסת ה-API הגיע ל-${usage.maxPct}%. הפעולות הושהו עד ${new Date(until).toISOString()}`, usage.raw);
      }
    } else if (usage.maxPct >= USAGE_WARN_PCT && now - (this.lastUsageWarn.get(accountId) ?? 0) > HOUR) {
      this.lastUsageWarn.set(accountId, now);
      this.event(account.org_id, accountId, 'warning', 'usage_high', `ניצול מכסת ה-API גבוה (${usage.maxPct}%)`, usage.raw);
    }
  }

  pause(account: AccountRow, until: number | null, reason: string, userId: string | null, status: 'paused' | 'restricted' = 'paused') {
    const now = this.ctx.now();
    this.ctx.db.run(
      'UPDATE ig_accounts SET status = ?, paused_until = ?, pause_reason = ?, updated_at = ? WHERE id = ? AND status NOT IN (\'disconnected\',\'needs_reauth\')',
      status,
      until,
      reason,
      now,
      account.id,
    );
    if (until) this.ctx.queue.deferAccount(account.id, until);
    if (userId) this.ctx.audit.record(account.org_id, 'account.paused', { userId, accountId: account.id, details: { until, reason } });
  }

  resume(account: AccountRow, userId: string | null, by: 'user' | 'auto' = 'user') {
    const now = this.ctx.now();
    const r = this.ctx.db.run(
      `UPDATE ig_accounts SET status = 'active', paused_until = NULL, pause_reason = NULL, consecutive_failures = 0, updated_at = ? WHERE id = ? AND status IN ('paused','restricted')`,
      now,
      account.id,
    );
    if (!r.changes) return;
    this.ctx.db.run(`UPDATE jobs SET run_at = ? WHERE account_id = ? AND status = 'queued' AND run_at > ?`, now, account.id, now);
    if (by === 'auto') this.event(account.org_id, account.id, 'info', 'auto_resumed', 'ההשהיה הסתיימה — החשבון חזר לפעילות');
    else this.ctx.audit.record(account.org_id, 'account.resumed', { userId, accountId: account.id });
  }

  /** User reports that Instagram showed an action-block ("Try again later"). */
  reportActionBlock(account: AccountRow, settings: AccountSettings, userId: string, note?: string) {
    const now = this.ctx.now();
    const until = now + settings.block_cooldown_hours * HOUR;
    this.ctx.db.tx(() => {
      this.ctx.db.run('UPDATE ig_accounts SET manual_cooldown_until = ?, updated_at = ? WHERE id = ?', until, now, account.id);
      this.ctx.db.run(`UPDATE manual_tasks SET status = 'cancelled', note = 'action block reported' WHERE account_id = ? AND status = 'pending'`, account.id);
    });
    this.event(account.org_id, account.id, 'critical', 'action_block_reported', `דווחה חסימת פעולות באינסטגרם. כל הפעולות הידניות הוקפאו ל-${settings.block_cooldown_hours} שעות.`, { note });
    this.ctx.audit.record(account.org_id, 'safety.action_block_reported', { userId, accountId: account.id, details: { until, note } });
    return until;
  }

  clearCooldown(account: AccountRow, userId: string) {
    this.ctx.db.run('UPDATE ig_accounts SET manual_cooldown_until = NULL WHERE id = ?', account.id);
    this.ctx.audit.record(account.org_id, 'safety.cooldown_cleared', { userId, accountId: account.id });
  }

  /** Pacing for manual actions: daily/hourly caps, minimum gap, active hours, cooldowns. */
  manualGate(account: AccountRow, s: AccountSettings, type: ManualType): ManualGate {
    const now = this.ctx.now();
    const today = dayKey(now, s.timezone);
    const dayStart = startOfDay(today, s.timezone);
    const dailyLimit = type === 'follow' ? s.daily_follow_limit : type === 'unfollow' ? s.daily_unfollow_limit : s.daily_story_like_limit;
    const doneToday =
      this.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM manual_tasks WHERE account_id = ? AND type = ? AND status = 'done' AND completed_at >= ?`, account.id, type, dayStart)?.n ?? 0;
    const lastHour = this.ctx.db.all<{ completed_at: number }>(
      `SELECT completed_at FROM manual_tasks WHERE account_id = ? AND status = 'done' AND completed_at >= ? ORDER BY completed_at ASC`,
      account.id,
      now - HOUR,
    );
    const last = this.ctx.db.get<{ t: number }>(`SELECT MAX(completed_at) AS t FROM manual_tasks WHERE account_id = ? AND status = 'done'`, account.id)?.t ?? 0;
    const base = { doneToday, dailyLimit, doneLastHour: lastHour.length, hourlyLimit: s.hourly_action_limit };
    const deny = (reason: string, nextAllowedAt: number | null): ManualGate => ({ allowed: false, reason, nextAllowedAt, ...base });

    if (account.status === 'disconnected') return deny('החשבון נותק', null);
    if (account.status === 'restricted' || (account.status === 'paused' && (!account.paused_until || account.paused_until > now)))
      return deny(account.pause_reason ?? 'החשבון מושהה', account.paused_until ?? null);
    if (account.manual_cooldown_until && account.manual_cooldown_until > now)
      return deny('הקפאת בטיחות אחרי חסימת פעולות', account.manual_cooldown_until);
    if (doneToday >= dailyLimit) return deny('הגעת למגבלה היומית לפעולה זו', startOfDay(addDays(today, 1), s.timezone));
    const hour = hourIn(now, s.timezone);
    if (hour < s.active_hour_start || hour >= s.active_hour_end) {
      const startDay = hour >= s.active_hour_end ? addDays(today, 1) : today;
      return deny(`מחוץ לשעות הפעילות (${s.active_hour_start}:00–${s.active_hour_end}:00)`, startOfDay(startDay, s.timezone) + s.active_hour_start * HOUR);
    }
    if (lastHour.length >= s.hourly_action_limit) return deny('הגעת למגבלה השעתית', lastHour[0].completed_at + HOUR);
    if (last && now - last < s.min_action_gap_sec * 1000) return deny('המתנה בין פעולות', last + s.min_action_gap_sec * 1000);
    return { allowed: true, reason: null, nextAllowedAt: null, ...base };
  }

  apiStats(accountId: string, sinceMs: number) {
    const now = this.ctx.now();
    const rows = this.ctx.db.all<{ kind: string | null; n: number }>(
      'SELECT error_kind AS kind, COUNT(*) AS n FROM api_calls WHERE account_id = ? AND created_at >= ? GROUP BY error_kind',
      accountId,
      now - sinceMs,
    );
    const usage = this.ctx.db.get<{ usage_pct: number; created_at: number }>(
      'SELECT usage_pct, created_at FROM api_calls WHERE account_id = ? AND usage_pct IS NOT NULL ORDER BY id DESC LIMIT 1',
      accountId,
    );
    const total = rows.reduce((a, r) => a + r.n, 0);
    const errors = rows.filter((r) => r.kind).reduce((a, r) => a + r.n, 0);
    return { total, errors, byKind: Object.fromEntries(rows.filter((r) => r.kind).map((r) => [r.kind, r.n])), lastUsagePct: usage?.usage_pct ?? null, lastUsageAt: usage?.created_at ?? null };
  }
}
