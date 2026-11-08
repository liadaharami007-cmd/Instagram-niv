import type { Ctx } from '../context.ts';
import { decrypt, encrypt, newId } from '../lib/crypto.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { isValidTimeZone, DAY, HOUR } from '../lib/time.ts';
import { MetaApiError } from '../meta/errors.ts';
import type { Provider } from '../meta/graph-client.ts';
import type { ConnectedProfile } from '../meta/oauth.ts';
import { HARD_LIMITS } from './safety.ts';

export interface AccountRow {
  id: string;
  org_id: string;
  provider: Provider;
  ig_user_id: string;
  username: string;
  name: string | null;
  account_type: string | null;
  profile_picture_url: string | null;
  fb_page_id: string | null;
  access_token_enc: string;
  token_expires_at: number | null;
  token_refreshed_at: number | null;
  granted_scopes: string;
  status: 'active' | 'paused' | 'needs_reauth' | 'restricted' | 'disconnected';
  paused_until: number | null;
  pause_reason: string | null;
  manual_cooldown_until: number | null;
  consecutive_failures: number;
  unsupported_metrics: string;
  last_error: string | null;
  followers_count: number | null;
  follows_count: number | null;
  media_count: number | null;
  last_synced_at: number | null;
  is_demo: number;
  comments_polled_at: number | null;
  webhook_subscribed_at: number | null;
  last_webhook_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface AccountSettings {
  account_id: string;
  timezone: string;
  daily_follow_limit: number;
  daily_unfollow_limit: number;
  daily_story_like_limit: number;
  hourly_action_limit: number;
  min_action_gap_sec: number;
  unfollow_after_days: number;
  unfollow_only_non_followers: number;
  story_like_interval_days: number;
  active_hour_start: number;
  active_hour_end: number;
  block_cooldown_hours: number;
  auto_reply_hourly_limit: number;
}

/** Background automations per account. All are official Graph API reads or local planning. */
export const SCHEDULE_DEFAULTS: { type: string; intervalSec: number; providers?: Provider[] }[] = [
  { type: 'sync_profile', intervalSec: 3 * 3600 },
  { type: 'sync_insights', intervalSec: 12 * 3600 },
  { type: 'sync_media', intervalSec: 12 * 3600 },
  { type: 'sync_stories', intervalSec: 4 * 3600 },
  { type: 'plan_manual_tasks', intervalSec: 3600 },
  { type: 'poll_comments', intervalSec: 15 * 60 },
  { type: 'refresh_token', intervalSec: 24 * 3600, providers: ['instagram_login'] },
  { type: 'enrich_targets', intervalSec: 6 * 3600, providers: ['facebook_login'] },
  { type: 'sync_competitors', intervalSec: 24 * 3600, providers: ['facebook_login'] },
];

export const API_JOB_TYPES = new Set([
  'sync_profile', 'sync_insights', 'sync_media', 'sync_stories', 'refresh_token', 'enrich_targets', 'sync_competitors',
  'publish_post', 'poll_comments', 'process_comment', 'process_dm', 'subscribe_webhooks',
]);

const SETTINGS_RULES: Record<string, [number, number]> = {
  daily_follow_limit: [0, HARD_LIMITS.daily_follow_limit],
  daily_unfollow_limit: [0, HARD_LIMITS.daily_unfollow_limit],
  daily_story_like_limit: [0, HARD_LIMITS.daily_story_like_limit],
  hourly_action_limit: [1, HARD_LIMITS.hourly_action_limit],
  min_action_gap_sec: [HARD_LIMITS.min_action_gap_sec, 3600],
  unfollow_after_days: [1, 365],
  unfollow_only_non_followers: [0, 1],
  story_like_interval_days: [1, 30],
  active_hour_start: [0, 23],
  active_hour_end: [1, 24],
  block_cooldown_hours: [12, 168],
  auto_reply_hourly_limit: [1, 200],
};

export class AccountsService {
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  findById(id: string): AccountRow | undefined {
    return this.ctx.db.get<AccountRow>('SELECT * FROM ig_accounts WHERE id = ?', id);
  }

  /** Tenant-scoped lookup: throws 404 when the account belongs to another organization. */
  get(orgId: string, id: string): AccountRow {
    const a = this.ctx.db.get<AccountRow>('SELECT * FROM ig_accounts WHERE id = ? AND org_id = ?', id, orgId);
    if (!a) throw notFound('החשבון');
    return a;
  }

  list(orgId: string): AccountRow[] {
    return this.ctx.db.all<AccountRow>(`SELECT * FROM ig_accounts WHERE org_id = ? AND status != 'disconnected' ORDER BY created_at`, orgId);
  }

  settings(accountId: string): AccountSettings {
    return this.ctx.db.get<AccountSettings>('SELECT * FROM account_settings WHERE account_id = ?', accountId)!;
  }

  token(account: AccountRow): string {
    return decrypt(account.access_token_enc, this.ctx.config.encryptionKey);
  }

  /** Public representation — never includes the token. */
  toPublic(a: AccountRow) {
    const { access_token_enc: _t, granted_scopes, unsupported_metrics, ...rest } = a;
    return { ...rest, granted_scopes: JSON.parse(granted_scopes) as string[], unsupported_metrics: JSON.parse(unsupported_metrics) as string[] };
  }

  /** Persists accounts returned by OAuth / token connect. Re-connecting refreshes the token and reactivates. */
  saveConnected(orgId: string, userId: string, provider: Provider, profiles: ConnectedProfile[]): AccountRow[] {
    const now = this.ctx.now();
    const saved: AccountRow[] = [];
    for (const p of profiles) {
      const existing = this.ctx.db.get<AccountRow>('SELECT * FROM ig_accounts WHERE org_id = ? AND ig_user_id = ?', orgId, p.igUserId);
      const tokenEnc = encrypt(p.token, this.ctx.config.encryptionKey);
      const id = existing?.id ?? newId('acc');
      this.ctx.db.tx(() => {
        if (existing) {
          this.ctx.db.run(
            `UPDATE ig_accounts SET provider=?, username=?, name=?, account_type=?, profile_picture_url=?, fb_page_id=?, access_token_enc=?,
               token_expires_at=?, token_refreshed_at=?, granted_scopes=?, status='active', paused_until=NULL, pause_reason=NULL,
               consecutive_failures=0, unsupported_metrics='[]', last_error=NULL, app_scoped_user_id=?, updated_at=? WHERE id=?`,
            provider, p.username, p.name ?? null, p.accountType ?? null, p.profilePictureUrl ?? null, p.fbPageId ?? null, tokenEnc,
            p.tokenExpiresAt, now, JSON.stringify(p.scopes), p.appScopedUserId ?? null, now, id,
          );
        } else {
          this.ctx.db.run(
            `INSERT INTO ig_accounts (id, org_id, provider, ig_user_id, app_scoped_user_id, username, name, account_type, profile_picture_url, fb_page_id,
               access_token_enc, token_expires_at, token_refreshed_at, granted_scopes, followers_count, follows_count, media_count, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            id, orgId, provider, p.igUserId, p.appScopedUserId ?? null, p.username, p.name ?? null, p.accountType ?? null, p.profilePictureUrl ?? null,
            p.fbPageId ?? null, tokenEnc, p.tokenExpiresAt, now, JSON.stringify(p.scopes), p.followersCount ?? null, p.followsCount ?? null,
            p.mediaCount ?? null, now, now,
          );
          this.ctx.db.run('INSERT INTO account_settings (account_id) VALUES (?)', id);
        }
        this.ensureSchedules(orgId, id, provider);
      });
      // Initial data load: profile now, 30-day insights backfill, media and stories.
      this.ctx.queue.enqueue({ type: 'sync_profile', orgId, accountId: id, priority: 10, dedupeKey: `sync_profile:${id}` });
      this.ctx.queue.enqueue({ type: 'sync_insights', orgId, accountId: id, priority: 20, payload: { days: 30 }, dedupeKey: `sync_insights:${id}` });
      this.ctx.queue.enqueue({ type: 'sync_media', orgId, accountId: id, priority: 30, dedupeKey: `sync_media:${id}` });
      this.ctx.queue.enqueue({ type: 'sync_stories', orgId, accountId: id, priority: 30, dedupeKey: `sync_stories:${id}` });
      this.ctx.audit.record(orgId, existing ? 'account.reconnected' : 'account.connected', { userId, accountId: id, details: { provider, username: p.username } });
      saved.push(this.findById(id)!);
    }
    return saved;
  }

  /** Adds schedules introduced by newer versions to already-connected accounts. */
  ensureAllSchedules() {
    for (const a of this.ctx.db.all<AccountRow>(`SELECT * FROM ig_accounts WHERE is_demo = 0 AND status != 'disconnected'`)) this.ensureSchedules(a.org_id, a.id, a.provider);
  }

  private ensureSchedules(orgId: string, accountId: string, provider: Provider) {
    const now = this.ctx.now();
    for (const s of SCHEDULE_DEFAULTS) {
      if (s.providers && !s.providers.includes(provider)) continue;
      this.ctx.db.run(
        `INSERT INTO schedules (account_id, org_id, job_type, interval_sec, enabled, next_run_at) VALUES (?,?,?,?,1,?)
         ON CONFLICT(account_id, job_type) DO NOTHING`,
        accountId, orgId, s.type, s.intervalSec, now + s.intervalSec * 1000,
      );
    }
    // Remove schedules that do not apply to this provider (e.g. after switching login type).
    const allowed = SCHEDULE_DEFAULTS.filter((s) => !s.providers || s.providers.includes(provider)).map((s) => s.type);
    this.ctx.db.run(`DELETE FROM schedules WHERE account_id = ? AND job_type NOT IN (${allowed.map(() => '?').join(',')})`, accountId, ...allowed);
  }

  /** Connect with an access token the user generated in the Meta App Dashboard. */
  async connectWithToken(orgId: string, userId: string, provider: Provider, rawToken: string): Promise<AccountRow[]> {
    const token = rawToken.trim();
    if (!/^[A-Za-z0-9_\-|.]{20,1024}$/.test(token)) throw badRequest('טוקן הגישה אינו בפורמט תקין');
    let profiles: ConnectedProfile[];
    if (provider === 'instagram_login') {
      let usable = token;
      let expiresAt: number | null = null;
      if (this.ctx.oauth.isConfigured('instagram_login')) {
        try {
          const long = await this.ctx.oauth.exchangeInstagramLongLived(token);
          usable = long.token;
          expiresAt = long.expiresAt;
        } catch (err) {
          // Already long-lived tokens cannot be exchanged again — that is fine, keep the original.
          if (err instanceof MetaApiError && err.kind === 'token_invalid') throw badRequest('Meta דחתה את הטוקן: ' + err.message);
        }
      }
      // Dashboard-generated tokens carry whatever permissions the app has; they are discovered on use.
      profiles = [await this.ctx.oauth.profileFromInstagramToken(usable, expiresAt, [])];
    } else {
      profiles = await this.ctx.oauth.profilesFromFacebookUserToken(token);
      if (!profiles.length) throw badRequest('לא נמצאו חשבונות Instagram מקצועיים המקושרים לדפי הפייסבוק של הטוקן');
    }
    return this.saveConnected(orgId, userId, provider, profiles);
  }

  updateSettings(account: AccountRow, patch: Record<string, unknown>, userId: string): AccountSettings {
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'timezone') {
        if (typeof v !== 'string' || !isValidTimeZone(v)) throw badRequest('אזור זמן לא תקין');
        sets.push('timezone = ?');
        vals.push(v);
        continue;
      }
      const rule = SETTINGS_RULES[k];
      if (!rule) throw badRequest(`הגדרה לא מוכרת: ${k}`);
      const n = Number(v);
      if (!Number.isInteger(n) || n < rule[0] || n > rule[1]) throw badRequest(`הערך של ${k} חייב להיות בין ${rule[0]} ל-${rule[1]}`);
      sets.push(`${k} = ?`);
      vals.push(n);
    }
    if (sets.length) this.ctx.db.run(`UPDATE account_settings SET ${sets.join(', ')} WHERE account_id = ?`, ...vals, account.id);
    const s = this.settings(account.id);
    if (s.active_hour_start >= s.active_hour_end) {
      this.ctx.db.run('UPDATE account_settings SET active_hour_start = 9, active_hour_end = 22 WHERE account_id = ?', account.id);
      throw badRequest('שעת ההתחלה חייבת להיות לפני שעת הסיום');
    }
    this.ctx.audit.record(account.org_id, 'account.settings_updated', { userId, accountId: account.id, details: patch });
    return s;
  }

  /** Disconnects and permanently deletes all data of the account (GDPR-style erase). */
  remove(account: AccountRow, userId: string | null, reason = 'user'): void {
    this.ctx.queue.cancelForAccount(account.id, 'account removed');
    this.ctx.db.run('DELETE FROM ig_accounts WHERE id = ?', account.id);
    this.ctx.audit.record(account.org_id, 'account.deleted', { userId, details: { username: account.username, reason } });
  }

  /** Refreshes Instagram-Login long-lived tokens well before their 60-day expiry. */
  async refreshTokenIfNeeded(account: AccountRow): Promise<{ refreshed: boolean; expiresAt: number | null }> {
    if (account.provider !== 'instagram_login') return { refreshed: false, expiresAt: account.token_expires_at };
    const now = this.ctx.now();
    const age = now - (account.token_refreshed_at ?? 0);
    const expiresSoon = !account.token_expires_at || account.token_expires_at - now < 20 * DAY;
    if (!expiresSoon || age < 24 * HOUR) return { refreshed: false, expiresAt: account.token_expires_at };
    const r = await this.ctx.oauth.refreshInstagramToken(this.token(account));
    this.ctx.db.run(
      'UPDATE ig_accounts SET access_token_enc = ?, token_expires_at = ?, token_refreshed_at = ?, updated_at = ? WHERE id = ?',
      encrypt(r.token, this.ctx.config.encryptionKey), r.expiresAt, now, now, account.id,
    );
    return { refreshed: true, expiresAt: r.expiresAt };
  }

  schedules(accountId: string) {
    return this.ctx.db.all('SELECT job_type, interval_sec, enabled, next_run_at, last_enqueued_at FROM schedules WHERE account_id = ? ORDER BY job_type', accountId);
  }

  updateSchedule(account: AccountRow, jobType: string, patch: { enabled?: boolean; interval_sec?: number }, userId: string) {
    const s = this.ctx.db.get('SELECT * FROM schedules WHERE account_id = ? AND job_type = ?', account.id, jobType);
    if (!s) throw notFound('האוטומציה');
    if (patch.interval_sec !== undefined) {
      const n = Number(patch.interval_sec);
      if (!Number.isInteger(n) || n < 900 || n > 7 * 86400) throw badRequest('מרווח הזמן חייב להיות בין 15 דקות ל-7 ימים');
      this.ctx.db.run('UPDATE schedules SET interval_sec = ?, next_run_at = MIN(next_run_at, ?) WHERE account_id = ? AND job_type = ?', n, this.ctx.now() + n * 1000, account.id, jobType);
    }
    if (patch.enabled !== undefined) {
      this.ctx.db.run('UPDATE schedules SET enabled = ? WHERE account_id = ? AND job_type = ?', patch.enabled ? 1 : 0, account.id, jobType);
      if (!patch.enabled) this.ctx.db.run(`UPDATE jobs SET status='cancelled', finished_at=?, last_error='automation disabled' WHERE account_id=? AND type=? AND status='queued'`, this.ctx.now(), account.id, jobType);
    }
    this.ctx.audit.record(account.org_id, 'automation.updated', { userId, accountId: account.id, details: { jobType, ...patch } });
  }

  markUnsupportedMetric(account: AccountRow, metric: string) {
    const list = new Set<string>(JSON.parse(account.unsupported_metrics));
    if (list.has(metric)) return;
    list.add(metric);
    account.unsupported_metrics = JSON.stringify([...list]);
    this.ctx.db.run('UPDATE ig_accounts SET unsupported_metrics = ? WHERE id = ?', account.unsupported_metrics, account.id);
  }
}
