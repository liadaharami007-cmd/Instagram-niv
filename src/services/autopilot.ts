import type { Ctx } from '../context.ts';
import { newId } from '../lib/crypto.ts';
import { badRequest } from '../lib/errors.ts';
import type { AccountRow } from './accounts.ts';

/**
 * Autopilot: the one-screen, switch-per-feature view of everything that runs automatically.
 * Defaults are switched ON when an account is connected, so nothing needs to be activated.
 * Follow / Unfollow / story likes are listed honestly as not supported by Meta.
 */
export const DEFAULT_TEXTS = {
  price_dm: 'היי! תודה על ההתעניינות 🙏 אשמח לתת לך את כל הפרטים — כתבו לי כאן מה מעניין אתכם ואחזור אליכם בהקדם.',
  price_public: ['שלחנו לך את הפרטים בהודעה פרטית 💌', 'היי {username}, הפרטים מחכים לך בדיירקט ✨'],
  welcome_dm: 'היי, תודה שכתבת לנו! 🙌 קיבלנו את ההודעה ונחזור אליך בהקדם.',
};
const PRICE_KEYWORDS = ['מחיר', 'כמה עולה', 'כמה זה', 'עלות', 'פרטים', 'price', 'how much'];

type RuleKey = 'price_reply' | 'dm_welcome';

export class AutopilotService {
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  private rule(account: AccountRow, key: RuleKey) {
    return this.ctx.db.get<{ id: string; enabled: number; dm_text: string | null; hits: number }>('SELECT id, enabled, dm_text, hits FROM reply_rules WHERE account_id = ? AND system_key = ?', account.id, key);
  }

  private createRule(account: AccountRow, key: RuleKey, enabled: boolean) {
    const now = this.ctx.now();
    const price = key === 'price_reply';
    this.ctx.db.run(
      `INSERT OR IGNORE INTO reply_rules (id, org_id, account_id, name, channel, match_type, keywords, public_replies, dm_text, priority, enabled, enabled_at, created_at, updated_at, system_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId('rul'), account.org_id, account.id, price ? 'שאלות מחיר → פרטים בהודעה פרטית' : 'הודעת פתיחה בדיירקט',
      price ? 'comment' : 'dm', price ? 'keywords' : 'any', JSON.stringify(price ? PRICE_KEYWORDS : []), JSON.stringify(price ? DEFAULT_TEXTS.price_public : []),
      price ? DEFAULT_TEXTS.price_dm : DEFAULT_TEXTS.welcome_dm, 10, enabled ? 1 : 0, now, now, now, key,
    );
  }

  /** Called once when a real account is connected for the first time. */
  applyDefaults(account: AccountRow) {
    if (account.is_demo) return;
    this.createRule(account, 'price_reply', true);
    this.createRule(account, 'dm_welcome', true);
    this.ctx.autoReplies.ensureSubscribed(account);
  }

  status(account: AccountRow) {
    const price = this.rule(account, 'price_reply');
    const welcome = this.rule(account, 'dm_welcome');
    const likes = this.ctx.engagement.status(account);
    const replies = this.ctx.autoReplies.history(account, 1);
    const sched = (t: string) => this.ctx.db.get<{ enabled: number }>('SELECT enabled FROM schedules WHERE account_id = ? AND job_type = ?', account.id, t)?.enabled === 1;
    const rt = this.ctx.autoReplies.status(account);
    return {
      account: { id: account.id, username: account.username, status: account.status, provider: account.provider, is_demo: account.is_demo },
      features: [
        { key: 'analytics', title: 'נתוני צמיחה', desc: 'עוקבים, שינוי יומי ושבועי, חשיפה ומעורבות — מתעדכן לבד', on: account.is_demo ? true : sched('sync_profile'), always: true, stat: account.last_synced_at ? 'סונכרן' : 'בסנכרון ראשון…', at: account.last_synced_at },
        { key: 'safety', title: 'הגנת חשבון', desc: 'עוצר הכול לבד אם Meta מגבילה, ומחדש כשאפשר', on: true, always: true, stat: account.status === 'active' ? 'החשבון תקין' : account.pause_reason || account.status },
        { key: 'price_reply', title: 'מישהו כתב "מחיר"? נשלחת לו הודעה פרטית', desc: 'מגיב בתגובה ובהודעה פרטית לכל מי שכותב מחיר / כמה עולה / פרטים', on: !!price?.enabled, text: price?.dm_text ?? DEFAULT_TEXTS.price_dm, stat: `${price?.hits ?? 0} פעמים`, needs: null },
        { key: 'dm_welcome', title: 'הודעת פתיחה בדיירקט', desc: 'מי שכותב לכם מקבל תשובה מיד (פעם בשבוע לכל אדם)', on: !!welcome?.enabled, text: welcome?.dm_text ?? DEFAULT_TEXTS.welcome_dm, stat: `${welcome?.hits ?? 0} פעמים`,
          needs: rt.lastWebhookAt || account.is_demo ? null : 'עובד אחרי חיבור Webhooks בהגדרות Meta (פעם אחת)' },
        { key: 'likes', title: 'לייקים אוטומטיים לקהל היעד', desc: 'לייק לפוסטים ורילס חדשים של החשבונות שתבחרו, בקצב בטוח', on: likes.running, stat: `${likes.doneToday} היום`, targets: likes.targets.total, needs: likes.blocker },
      ],
      notSupported: [
        { key: 'follow', title: 'Follow אוטומטי' },
        { key: 'unfollow', title: 'Unfollow אוטומטי' },
        { key: 'story_like', title: 'לייקים לסטוריז' },
      ],
      today: { replies: replies.sent24h, likes: likes.doneToday },
    };
  }

  /** One switch per feature. Optional text updates the message that is sent. */
  set(account: AccountRow, key: string, input: { on?: boolean; text?: string }, userId: string) {
    if (key === 'price_reply' || key === 'dm_welcome') {
      if (!this.rule(account, key)) this.createRule(account, key, !!input.on);
      const r = this.rule(account, key)!;
      if (input.text !== undefined) {
        const t = String(input.text).trim();
        if (t.length < 2 || t.length > 1000) throw badRequest('נוסח ההודעה חייב להיות בין 2 ל-1,000 תווים');
        this.ctx.db.run('UPDATE reply_rules SET dm_text = ?, updated_at = ? WHERE id = ?', t, this.ctx.now(), r.id);
      }
      if (input.on !== undefined) this.ctx.autoReplies.updateRule(account.org_id, r.id, userId, { enabled: !!input.on });
      if (input.on) this.ctx.autoReplies.ensureSubscribed(account);
      return;
    }
    if (key === 'likes') {
      if (input.on) this.ctx.engagement.start(account, userId);
      else this.ctx.engagement.stop(account, 'נעצר ידנית', userId);
      return;
    }
    throw badRequest('לא ניתן לשנות את ההגדרה הזו');
  }
}
