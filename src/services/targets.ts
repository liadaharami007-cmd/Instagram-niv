import type { Ctx } from '../context.ts';
import { newId } from '../lib/crypto.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import type { AccountRow } from './accounts.ts';

const USERNAME_RE = /^[a-z0-9._]{1,30}$/;

/** Normalises "@User.Name", "instagram.com/user.name/" etc. into a valid handle, or null. */
export function normalizeUsername(input: string): string | null {
  let s = input.trim().toLowerCase();
  const url = s.match(/instagram\.com\/(?:_u\/)?([a-z0-9._]+)/);
  if (url) s = url[1];
  s = s.replace(/^@/, '').replace(/\/+$/, '');
  return USERNAME_RE.test(s) && !s.startsWith('.') && !s.endsWith('.') && !s.includes('..') ? s : null;
}

export type TargetFilter = 'all' | 'to_follow' | 'following' | 'non_followers' | 'followers' | 'mutual' | 'whitelist' | 'stories' | 'auto_like';

const FILTERS: Record<TargetFilter, string> = {
  all: '1=1',
  to_follow: 'follow_wanted = 1 AND i_follow = 0',
  following: 'i_follow = 1',
  non_followers: 'i_follow = 1 AND follows_me = 0',
  followers: 'follows_me = 1',
  mutual: 'i_follow = 1 AND follows_me = 1',
  whitelist: 'whitelisted = 1',
  stories: 'engage_stories = 1',
  auto_like: 'auto_like = 1',
};

const EDITABLE = new Set(['segment', 'notes', 'whitelisted', 'follow_wanted', 'engage_stories', 'auto_like']);

export class TargetsService {
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  /**
   * Adds handles (one per line, optional ",segment,notes"). Existing targets keep their state
   * but receive the requested flags.
   */
  add(account: AccountRow, userId: string, text: string, opts: { segment?: string; followWanted?: boolean; engageStories?: boolean; whitelisted?: boolean; autoLike?: boolean; source?: string }) {
    const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 5000) throw badRequest('ניתן להוסיף עד 5,000 חשבונות בפעם אחת');
    const now = this.ctx.now();
    let added = 0;
    let updated = 0;
    const invalid: string[] = [];
    this.ctx.db.tx(() => {
      for (const line of lines) {
        const [rawUser, rawSegment, ...rest] = line.split(/[,\t;]/);
        const username = normalizeUsername(rawUser ?? '');
        if (!username) {
          invalid.push(line.slice(0, 60));
          continue;
        }
        const segment = (rawSegment?.trim() || opts.segment || 'general').slice(0, 40);
        const notes = rest.join(',').trim().slice(0, 300) || null;
        const r = this.ctx.db.run(
          `INSERT INTO targets (id, org_id, account_id, username, segment, source, notes, follow_wanted, engage_stories, whitelisted, auto_like, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(account_id, username) DO UPDATE SET
             follow_wanted = MAX(targets.follow_wanted, excluded.follow_wanted),
             engage_stories = MAX(targets.engage_stories, excluded.engage_stories),
             whitelisted = MAX(targets.whitelisted, excluded.whitelisted),
             auto_like = MAX(targets.auto_like, excluded.auto_like),
             segment = CASE WHEN excluded.segment != 'general' THEN excluded.segment ELSE targets.segment END,
             notes = COALESCE(excluded.notes, targets.notes), updated_at = excluded.updated_at`,
          newId('tgt'), account.org_id, account.id, username, segment, opts.source ?? 'manual', notes,
          opts.followWanted ? 1 : 0, opts.engageStories ? 1 : 0, opts.whitelisted ? 1 : 0, opts.autoLike ? 1 : 0, now, now,
        );
        if (r.changes) {
          const fresh = this.ctx.db.get<{ created_at: number }>('SELECT created_at FROM targets WHERE account_id = ? AND username = ?', account.id, username);
          if (fresh?.created_at === now) added++;
          else updated++;
        }
      }
    });
    this.ctx.audit.record(account.org_id, 'targets.added', { userId, accountId: account.id, details: { added, updated, invalid: invalid.length, ...opts } });
    return { added, updated, invalid };
  }

  list(account: AccountRow, opts: { filter?: string; q?: string; segment?: string; page?: number; pageSize?: number }) {
    const filter = (opts.filter && opts.filter in FILTERS ? opts.filter : 'all') as TargetFilter;
    const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
    const page = Math.max(opts.page ?? 1, 1);
    const where = `account_id = ? AND ${FILTERS[filter]} AND (? IS NULL OR username LIKE ?) AND (? IS NULL OR segment = ?)`;
    const q = opts.q ? `%${opts.q.toLowerCase().replace(/[%_]/g, '')}%` : null;
    const params = [account.id, q, q, opts.segment ?? null, opts.segment ?? null];
    const total = this.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM targets WHERE ${where}`, ...params)!.n;
    const items = this.ctx.db.all(`SELECT * FROM targets WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize);
    return { items, total, page, pageSize };
  }

  counts(account: AccountRow) {
    const out: Record<string, number> = {};
    for (const [k, w] of Object.entries(FILTERS)) out[k] = this.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM targets WHERE account_id = ? AND ${w}`, account.id)!.n;
    return { ...out, segmentList: this.ctx.db.all<{ segment: string; n: number }>('SELECT segment, COUNT(*) AS n FROM targets WHERE account_id = ? GROUP BY segment ORDER BY n DESC', account.id) };
  }

  get(orgId: string, id: string) {
    const t = this.ctx.db.get('SELECT * FROM targets WHERE id = ? AND org_id = ?', id, orgId);
    if (!t) throw notFound('היעד');
    return t;
  }

  update(orgId: string, ids: string[], patch: Record<string, unknown>, userId: string) {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!EDITABLE.has(k)) throw badRequest(`שדה לא ניתן לעריכה: ${k}`);
      if (k === 'segment' || k === 'notes') {
        sets.push(`${k} = ?`);
        vals.push(v === null ? null : String(v).slice(0, k === 'segment' ? 40 : 300));
      } else {
        sets.push(`${k} = ?`);
        vals.push(v ? 1 : 0);
      }
    }
    if (!sets.length || !ids.length) return 0;
    if (ids.length > 1000) throw badRequest('עד 1,000 יעדים בפעולה אחת');
    const n = this.ctx.db.run(
      `UPDATE targets SET ${sets.join(', ')}, updated_at = ? WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      ...vals, this.ctx.now(), orgId, ...ids,
    ).changes;
    this.ctx.audit.record(orgId, 'targets.updated', { userId, details: { count: n, patch } });
    return n;
  }

  remove(orgId: string, ids: string[], userId: string) {
    if (!ids.length) return 0;
    const n = this.ctx.db.run(`DELETE FROM targets WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`, orgId, ...ids).changes;
    this.ctx.audit.record(orgId, 'targets.deleted', { userId, details: { count: n } });
    return n;
  }
}
