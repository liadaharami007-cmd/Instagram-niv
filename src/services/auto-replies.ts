import type { Ctx } from '../context.ts';
import { newId } from '../lib/crypto.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { DAY, HOUR } from '../lib/time.ts';
import { MetaApiError } from '../meta/errors.ts';
import type { AccountRow } from './accounts.ts';

export interface RuleRow {
  id: string;
  org_id: string;
  account_id: string;
  name: string;
  channel: 'comment' | 'dm';
  match_type: 'any' | 'keywords';
  keywords: string;
  public_replies: string;
  dm_text: string | null;
  media_id: string | null;
  enabled: number;
  priority: number;
  hits: number;
  enabled_at: number;
}

export interface IncomingComment {
  id: string;
  text: string;
  username?: string;
  fromId?: string;
  mediaId?: string;
  timestamp?: number;
}

export interface IncomingMessage {
  mid: string;
  senderId: string;
  text: string;
}

/** Lowercase, strip Hebrew niqqud and punctuation so "מחיר?!" matches "מחיר". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function ruleMatches(rule: Pick<RuleRow, 'match_type' | 'keywords'>, text: string): boolean {
  if (rule.match_type === 'any') return true;
  const t = ` ${normalize(text)} `;
  return (JSON.parse(rule.keywords) as string[]).some((k) => {
    const n = normalize(k);
    return n.length > 0 && t.includes(n);
  });
}

/** Ready-made rules for one-click setup. */
export const TEMPLATES = [
  { key: 'price_dm', name: 'מי ששואל "מחיר" מקבל פרטים בפרטי', channel: 'comment', match_type: 'keywords', keywords: ['מחיר', 'כמה עולה', 'פרטים', 'price'], public_replies: ['שלחנו לך את כל הפרטים בהודעה פרטית 💌', 'היי {username}, הפרטים מחכים לך בדיירקט ✨'], dm_text: 'היי! תודה על ההתעניינות 🙏 אשמח לתת לך את כל הפרטים — כתבו לי כאן מה מעניין אתכם ואחזור אליכם בהקדם.' },
  { key: 'thanks', name: 'תודה על כל תגובה', channel: 'comment', match_type: 'any', keywords: [], public_replies: ['תודה רבה {username} ❤️', 'איזה כיף לקרוא, תודה! 🙏', 'תודה {username}! 💛'], dm_text: null },
  { key: 'coupon', name: 'מילת קוד → קופון בפרטי', channel: 'comment', match_type: 'keywords', keywords: ['קופון', 'הנחה'], public_replies: ['שלחנו לך קוד הנחה בפרטי 🎁'], dm_text: 'איזה כיף שבאת! 🎁 שלחו לנו כאן "קופון" ונשלח את קוד ההנחה העדכני.' },
  { key: 'dm_welcome', name: 'הודעת פתיחה בדיירקט', channel: 'dm', match_type: 'any', keywords: [], public_replies: [], dm_text: 'היי, תודה שכתבת לנו! 🙌 קיבלנו את ההודעה ונחזור אליך בהקדם.' },
  { key: 'dm_hours', name: 'שעות פעילות / כתובת בדיירקט', channel: 'dm', match_type: 'keywords', keywords: ['שעות', 'כתובת', 'איפה', 'פתוחים'], public_replies: [], dm_text: 'תודה ששאלתם! 📍 נשלח לכם כאן את שעות הפעילות והכתובת בהקדם.' },
] as const;

const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Comment and DM auto-replies on the official APIs:
 *  - public reply:   POST /{comment-id}/replies
 *  - private reply:  POST /{ig-user-id}/messages  recipient={comment_id}
 *  - DM reply:       POST /{ig-user-id}/messages  recipient={id}
 * At-most-once per comment/message (unique row written before sending) and an hourly cap.
 */
export class AutoReplyService {
  private readonly ctx: Ctx;
  private lastLimitWarn = new Map<string, number>();
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  rules(account: AccountRow) {
    return this.ctx.db
      .all<RuleRow>('SELECT * FROM reply_rules WHERE account_id = ? ORDER BY channel, priority, created_at', account.id)
      .map((r) => ({ ...r, keywords: JSON.parse(r.keywords) as string[], public_replies: JSON.parse(r.public_replies) as string[] }));
  }

  private clean(input: any) {
    const channel = input.channel === 'dm' ? 'dm' : 'comment';
    const match_type = input.match_type === 'any' ? 'any' : 'keywords';
    const list = (v: unknown, max: number, len: number) =>
      (Array.isArray(v) ? v : String(v ?? '').split(/\n|,/)).map((x) => String(x).trim()).filter(Boolean).slice(0, max).map((x) => x.slice(0, len));
    const keywords = list(input.keywords, 30, 60);
    const public_replies = channel === 'comment' ? list(input.public_replies, 10, 300) : [];
    const dm_text = String(input.dm_text ?? '').trim().slice(0, 1000) || null;
    const name = String(input.name ?? '').trim().slice(0, 80) || 'כלל ללא שם';
    if (match_type === 'keywords' && !keywords.length) throw badRequest('יש להזין לפחות מילת מפתח אחת');
    if (!public_replies.length && !dm_text) throw badRequest('יש להזין תשובה ציבורית או הודעה פרטית');
    const media_id = input.media_id ? String(input.media_id).replace(/\D/g, '').slice(0, 40) || null : null;
    return { name, channel, match_type, keywords, public_replies, dm_text, media_id, priority: Math.min(Math.max(Number(input.priority ?? 100) || 100, 1), 1000) };
  }

  createRule(account: AccountRow, userId: string, input: any) {
    const r = input.template ? { ...TEMPLATES.find((t) => t.key === input.template) } : input;
    if (input.template && !r.key) throw notFound('התבנית');
    const c = this.clean(r);
    const now = this.ctx.now();
    const id = newId('rul');
    this.ctx.db.run(
      `INSERT INTO reply_rules (id, org_id, account_id, name, channel, match_type, keywords, public_replies, dm_text, media_id, priority, enabled, enabled_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 1, ?,?,?)`,
      id, account.org_id, account.id, c.name, c.channel, c.match_type, JSON.stringify(c.keywords), JSON.stringify(c.public_replies), c.dm_text, c.media_id, c.priority, now, now, now,
    );
    this.ensureSubscribed(account);
    this.ctx.audit.record(account.org_id, 'autoreply.rule_created', { userId, accountId: account.id, details: { name: c.name, channel: c.channel } });
    return id;
  }

  updateRule(orgId: string, ruleId: string, userId: string, input: any) {
    const rule = this.ctx.db.get<RuleRow>('SELECT * FROM reply_rules WHERE id = ? AND org_id = ?', ruleId, orgId);
    if (!rule) throw notFound('הכלל');
    const now = this.ctx.now();
    if (Object.keys(input).length === 1 && 'enabled' in input) {
      // Re-enabling only applies to new comments from now on (never replies to the backlog).
      this.ctx.db.run('UPDATE reply_rules SET enabled = ?, enabled_at = CASE WHEN ? = 1 AND enabled = 0 THEN ? ELSE enabled_at END, updated_at = ? WHERE id = ?', input.enabled ? 1 : 0, input.enabled ? 1 : 0, now, now, ruleId);
    } else {
      const c = this.clean({ ...rule, keywords: JSON.parse(rule.keywords), public_replies: JSON.parse(rule.public_replies), ...input });
      this.ctx.db.run(
        'UPDATE reply_rules SET name=?, channel=?, match_type=?, keywords=?, public_replies=?, dm_text=?, media_id=?, priority=?, updated_at=? WHERE id = ?',
        c.name, c.channel, c.match_type, JSON.stringify(c.keywords), JSON.stringify(c.public_replies), c.dm_text, c.media_id, c.priority, now, ruleId,
      );
    }
    this.ctx.audit.record(orgId, 'autoreply.rule_updated', { userId, accountId: rule.account_id, details: { ruleId, ...input } });
  }

  deleteRule(orgId: string, ruleId: string, userId: string) {
    const r = this.ctx.db.run('DELETE FROM reply_rules WHERE id = ? AND org_id = ?', ruleId, orgId);
    if (!r.changes) throw notFound('הכלל');
    this.ctx.audit.record(orgId, 'autoreply.rule_deleted', { userId, details: { ruleId } });
  }

  history(account: AccountRow, limit = 100) {
    const rows = this.ctx.db.all(
      `SELECT a.*, r.name AS rule_name FROM auto_replies a LEFT JOIN reply_rules r ON r.id = a.rule_id WHERE a.account_id = ? ORDER BY a.id DESC LIMIT ?`,
      account.id, Math.min(limit, 300),
    );
    const stats = this.ctx.db.get<{ sent24h: number; failed24h: number }>(
      `SELECT SUM(status = 'sent') AS sent24h, SUM(status = 'failed') AS failed24h FROM auto_replies WHERE account_id = ? AND created_at > ?`, account.id, this.ctx.now() - DAY,
    );
    return { rows, sent24h: stats?.sent24h ?? 0, failed24h: stats?.failed24h ?? 0 };
  }

  status(account: AccountRow) {
    return {
      webhookConfigured: Boolean(this.ctx.config.meta.webhookVerifyToken),
      webhookUrl: `${this.ctx.config.publicBaseUrl}/meta/webhook`,
      subscribedAt: account.webhook_subscribed_at ?? null,
      lastWebhookAt: account.last_webhook_at ?? null,
      polledAt: account.comments_polled_at ?? null,
    };
  }

  ensureSubscribed(account: AccountRow) {
    if (account.is_demo || account.webhook_subscribed_at) return;
    this.ctx.queue.enqueue({ type: 'subscribe_webhooks', orgId: account.org_id, accountId: account.id, dedupeKey: `subscribe_webhooks:${account.id}` });
  }

  private req(account: AccountRow, path: string, params: Record<string, string | number | undefined>, method: 'GET' | 'POST' = 'GET') {
    return this.ctx.graph.request<any>({ provider: account.provider, token: this.ctx.accounts.token(account), path, params, method, accountId: account.id });
  }

  /** Subscribes the account so Meta pushes comments/messages to /meta/webhook. */
  async subscribe(account: AccountRow) {
    if (account.provider === 'instagram_login') {
      await this.req(account, `${account.ig_user_id}/subscribed_apps`, { subscribed_fields: 'comments,messages' }, 'POST');
    } else if (account.fb_page_id) {
      await this.req(account, `${account.fb_page_id}/subscribed_apps`, { subscribed_fields: 'feed,messages' }, 'POST');
    }
    this.ctx.db.run('UPDATE ig_accounts SET webhook_subscribed_at = ? WHERE id = ?', this.ctx.now(), account.id);
    return { subscribed: true };
  }

  private underLimit(account: AccountRow): boolean {
    const limit = this.ctx.accounts.settings(account.id).auto_reply_hourly_limit;
    const n = this.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM auto_replies WHERE account_id = ? AND status = 'sent' AND created_at > ?`, account.id, this.ctx.now() - HOUR)!.n;
    if (n < limit) return true;
    if (this.ctx.now() - (this.lastLimitWarn.get(account.id) ?? 0) > HOUR) {
      this.lastLimitWarn.set(account.id, this.ctx.now());
      this.ctx.safety.event(account.org_id, account.id, 'warning', 'autoreply_limit', `הגעת למגבלת ${limit} תגובות אוטומטיות לשעה — תגובות נוספות ידולגו עד שהמונה יתאפס`);
    }
    return false;
  }

  /** Reserves the (source, action) slot. Returns false if it was already handled. */
  private reserve(account: AccountRow, rule: RuleRow, channel: string, sourceId: string, action: string, from: { id?: string; username?: string }, text: string, reply: string) {
    const r = this.ctx.db.run(
      `INSERT OR IGNORE INTO auto_replies (org_id, account_id, rule_id, channel, source_id, from_id, from_username, incoming_text, action, reply_text, status, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'failed', 'in progress', ?)`,
      account.org_id, account.id, rule.id, channel, sourceId, from.id ?? null, from.username ?? null, text.slice(0, 500), action, reply, this.ctx.now(),
    );
    return r.changes > 0;
  }

  private async send(account: AccountRow, sourceId: string, action: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      this.ctx.db.run(`UPDATE auto_replies SET status = 'sent', error = NULL WHERE account_id = ? AND source_id = ? AND action = ?`, account.id, sourceId, action);
      return true;
    } catch (err) {
      const msg = err instanceof MetaApiError ? `${err.userMessage}: ${err.message}` : (err as Error).message;
      this.ctx.db.run(`UPDATE auto_replies SET status = 'failed', error = ? WHERE account_id = ? AND source_id = ? AND action = ?`, msg.slice(0, 300), account.id, sourceId, action);
      // Account-level problems go to the safety engine via the job; per-message rejections are just recorded.
      if (err instanceof MetaApiError && ['token_invalid', 'rate_limit', 'policy_block'].includes(err.kind)) throw err;
      return false;
    }
  }

  async handleComment(account: AccountRow, c: IncomingComment) {
    if (!c.text || c.fromId === account.ig_user_id || (c.username && c.username.toLowerCase() === account.username.toLowerCase())) return { skipped: 'own or empty' };
    const rules = this.ctx.db.all<RuleRow>(`SELECT * FROM reply_rules WHERE account_id = ? AND channel = 'comment' AND enabled = 1 ORDER BY priority, created_at`, account.id);
    const ts = c.timestamp ?? this.ctx.now();
    const rule = rules.find((r) => (!r.media_id || r.media_id === c.mediaId) && ts >= r.enabled_at - 60_000 && ruleMatches(r, c.text));
    if (!rule) return { skipped: 'no matching rule' };
    if (!this.underLimit(account)) return { skipped: 'hourly limit' };
    const from = { id: c.fromId, username: c.username };
    const out: Record<string, boolean> = {};
    const publics: string[] = JSON.parse(rule.public_replies);
    if (publics.length) {
      const text = pick(publics).replaceAll('{username}', c.username ? `@${c.username}` : '').replace(/\s+/g, ' ').trim();
      if (this.reserve(account, rule, 'comment', c.id, 'public_reply', from, c.text, text))
        out.public = await this.send(account, c.id, 'public_reply', () => this.req(account, `${c.id}/replies`, { message: text }, 'POST'));
    }
    if (rule.dm_text && this.reserve(account, rule, 'comment', c.id, 'private_reply', from, c.text, rule.dm_text)) {
      out.private = await this.send(account, c.id, 'private_reply', () =>
        this.req(account, `${account.ig_user_id}/messages`, { recipient: JSON.stringify({ comment_id: c.id }), message: JSON.stringify({ text: rule.dm_text }) }, 'POST'));
    }
    if (Object.keys(out).length) this.ctx.db.run('UPDATE reply_rules SET hits = hits + 1 WHERE id = ?', rule.id);
    return { rule: rule.name, ...out };
  }

  async handleMessage(account: AccountRow, m: IncomingMessage) {
    if (!m.text || m.senderId === account.ig_user_id) return { skipped: 'own or empty' };
    const rules = this.ctx.db.all<RuleRow>(`SELECT * FROM reply_rules WHERE account_id = ? AND channel = 'dm' AND enabled = 1 ORDER BY priority, created_at`, account.id);
    const rule = rules.find((r) => ruleMatches(r, m.text));
    if (!rule || !rule.dm_text) return { skipped: 'no matching rule' };
    // Welcome-type rules answer a person once a week; keyword rules at most once an hour.
    const cooldown = rule.match_type === 'any' ? 7 * DAY : HOUR;
    const recent = this.ctx.db.get('SELECT 1 FROM auto_replies WHERE account_id = ? AND rule_id = ? AND from_id = ? AND created_at > ?', account.id, rule.id, m.senderId, this.ctx.now() - cooldown);
    if (recent) return { skipped: 'cooldown' };
    if (!this.underLimit(account)) return { skipped: 'hourly limit' };
    if (!this.reserve(account, rule, 'dm', m.mid, 'dm_reply', { id: m.senderId }, m.text, rule.dm_text)) return { skipped: 'duplicate' };
    const ok = await this.send(account, m.mid, 'dm_reply', () =>
      this.req(account, `${account.ig_user_id}/messages`, { recipient: JSON.stringify({ id: m.senderId }), message: JSON.stringify({ text: rule.dm_text }) }, 'POST'));
    if (ok) this.ctx.db.run('UPDATE reply_rules SET hits = hits + 1 WHERE id = ?', rule.id);
    return { rule: rule.name, sent: ok };
  }

  /** Fallback when webhooks are not configured: reads new comments on recent posts. */
  async pollComments(account: AccountRow) {
    const hasRules = this.ctx.db.get(`SELECT 1 FROM reply_rules WHERE account_id = ? AND channel = 'comment' AND enabled = 1`, account.id);
    if (!hasRules) return { skipped: 'no comment rules' };
    const now = this.ctx.now();
    const since = (account.comments_polled_at ?? now - HOUR) - 5 * 60_000;
    const media = (await this.req(account, `${account.ig_user_id}/media`, { fields: 'id,timestamp', limit: 10 })).data.data ?? [];
    let seen = 0;
    let handled = 0;
    for (const m of media) {
      if (m.timestamp && Date.parse(m.timestamp) < now - 30 * DAY) continue;
      const comments = (await this.req(account, `${m.id}/comments`, { fields: 'id,text,username,timestamp,from{id,username}', limit: 50 })).data.data ?? [];
      for (const c of comments) {
        const ts = c.timestamp ? Date.parse(String(c.timestamp).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : now;
        if (ts < since) continue;
        seen++;
        const r = await this.handleComment(account, { id: String(c.id), text: c.text ?? '', username: c.username ?? c.from?.username, fromId: c.from?.id, mediaId: String(m.id), timestamp: ts });
        if (!('skipped' in r)) handled++;
      }
    }
    this.ctx.db.run('UPDATE ig_accounts SET comments_polled_at = ? WHERE id = ?', now, account.id);
    return { media: media.length, newComments: seen, replied: handled };
  }
}
