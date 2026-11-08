import type { Ctx } from '../context.ts';
import { newId } from '../lib/crypto.ts';
import { badRequest } from '../lib/errors.ts';
import { readZip } from '../lib/zip.ts';
import type { AccountRow } from './accounts.ts';
import { normalizeUsername } from './targets.ts';

export interface Relationship {
  username: string;
  timestamp: number | null;
}

export interface ParsedExport {
  followers: Relationship[] | null;
  following: Relationship[] | null;
  files: string[];
}

const FOLLOWERS_RE = /(^|\/)followers(_\d+)?\.json$/i;
const FOLLOWING_RE = /(^|\/)following\.json$/i;

function extract(json: unknown): Relationship[] {
  const list: any[] = Array.isArray(json)
    ? json
    : json && typeof json === 'object'
      ? ((Object.values(json).find((v) => Array.isArray(v)) as any[]) ?? [])
      : [];
  const out: Relationship[] = [];
  for (const entry of list) {
    const sld = entry?.string_list_data?.[0] ?? {};
    const raw = sld.value || entry?.title || sld.href || '';
    const username = normalizeUsername(String(raw));
    if (username) out.push({ username, timestamp: Number.isFinite(sld.timestamp) ? sld.timestamp * 1000 : null });
  }
  return out;
}

/**
 * Parses Instagram's official "Download your information" export (JSON format):
 * a full .zip, or individual followers_N.json / following.json files.
 */
export function parseInstagramExport(buf: Buffer, filename = ''): ParsedExport {
  const files: { name: string; data: () => Buffer }[] = [];
  if (buf.subarray(0, 2).toString('latin1') === 'PK') {
    const entries = readZip(buf);
    for (const e of entries) files.push({ name: e.name, data: e.read });
    if (!entries.some((e) => FOLLOWERS_RE.test(e.name) || FOLLOWING_RE.test(e.name)) && entries.some((e) => /followers.*\.html$/i.test(e.name)))
      throw badRequest('הקובץ הורד בפורמט HTML. יש לבקש מאינסטגרם את ההורדה בפורמט JSON.');
  } else {
    files.push({ name: filename || 'upload.json', data: () => buf });
  }
  let followers: Relationship[] | null = null;
  let following: Relationship[] | null = null;
  const used: string[] = [];
  for (const f of files) {
    const isFollowers = FOLLOWERS_RE.test(f.name);
    const isFollowing = FOLLOWING_RE.test(f.name);
    if (!isFollowers && !isFollowing) continue;
    let json: unknown;
    try {
      json = JSON.parse(f.data().toString('utf8'));
    } catch {
      throw badRequest(`הקובץ ${f.name} אינו JSON תקין`);
    }
    const rows = extract(json);
    if (isFollowers) followers = [...(followers ?? []), ...rows];
    else following = rows;
    used.push(f.name.split('/').pop()!);
  }
  if (!followers && !following) throw badRequest('לא נמצאו בקובץ רשימות followers או following. יש להעלות את קובץ ה-ZIP של אינסטגרם, או followers_1.json / following.json.');
  return { followers, following, files: used };
}

export class RelationshipImportService {
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  /** Applies the export as the source of truth for who follows whom. */
  apply(account: AccountRow, userId: string, parsed: ParsedExport) {
    const now = this.ctx.now();
    const hadImport = !!this.ctx.db.get('SELECT 1 FROM relationship_imports WHERE account_id = ? LIMIT 1', account.id);
    const followers = parsed.followers ? new Map(parsed.followers.map((r) => [r.username, r.timestamp])) : null;
    const following = parsed.following ? new Map(parsed.following.map((r) => [r.username, r.timestamp])) : null;
    let newFollowers = 0;
    const lost: string[] = [];

    this.ctx.db.tx(() => {
      const all = new Set([...(followers?.keys() ?? []), ...(following?.keys() ?? [])]);
      for (const username of all) {
        this.ctx.db.run(
          `INSERT OR IGNORE INTO targets (id, org_id, account_id, username, source, created_at, updated_at) VALUES (?,?,?,?, 'export', ?, ?)`,
          newId('tgt'), account.org_id, account.id, username, now, now,
        );
      }
      const rows = this.ctx.db.all<{ id: string; username: string; follows_me: number; i_follow: number; followed_at: number | null; follows_me_since: number | null }>(
        'SELECT id, username, follows_me, i_follow, followed_at, follows_me_since FROM targets WHERE account_id = ?', account.id,
      );
      for (const t of rows) {
        let followsMe = t.follows_me;
        let iFollow = t.i_follow;
        let followedAt = t.followed_at;
        let since = t.follows_me_since;
        if (followers) {
          const inF = followers.has(t.username);
          if (hadImport && t.follows_me && !inF) lost.push(t.username);
          if (hadImport && !t.follows_me && inF) newFollowers++;
          followsMe = inF ? 1 : 0;
          since = inF ? (since ?? followers.get(t.username) ?? now) : null;
        }
        if (following) {
          const inG = following.has(t.username);
          iFollow = inG ? 1 : 0;
          if (inG && !followedAt) followedAt = following.get(t.username) ?? now;
        }
        if (followsMe !== t.follows_me || iFollow !== t.i_follow || followedAt !== t.followed_at || since !== t.follows_me_since) {
          this.ctx.db.run(
            'UPDATE targets SET follows_me = ?, i_follow = ?, followed_at = ?, follows_me_since = ?, updated_at = ? WHERE id = ?',
            followsMe, iFollow, followedAt, since, now, t.id,
          );
        }
      }
      this.ctx.db.run(
        `INSERT INTO relationship_imports (id, account_id, imported_at, imported_by, followers_total, following_total, new_followers, lost_followers, lost_usernames, files)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        newId('imp'), account.id, now, userId, followers?.size ?? null, following?.size ?? null,
        hadImport && followers ? newFollowers : null, hadImport && followers ? lost.length : null, JSON.stringify(lost.slice(0, 2000)), JSON.stringify(parsed.files),
      );
    });
    const nonFollowers = this.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM targets WHERE account_id = ? AND i_follow = 1 AND follows_me = 0', account.id)!.n;
    const result = {
      followers: followers?.size ?? null,
      following: following?.size ?? null,
      newFollowers: hadImport && followers ? newFollowers : null,
      lostFollowers: hadImport && followers ? lost.length : null,
      lostUsernames: lost.slice(0, 200),
      nonFollowers,
      files: parsed.files,
    };
    this.ctx.audit.record(account.org_id, 'relationships.imported', { userId, accountId: account.id, details: { ...result, lostUsernames: undefined } });
    return result;
  }

  list(account: AccountRow) {
    return this.ctx.db
      .all('SELECT * FROM relationship_imports WHERE account_id = ? ORDER BY imported_at DESC LIMIT 20', account.id)
      .map((r) => ({ ...r, lost_usernames: JSON.parse(r.lost_usernames), files: JSON.parse(r.files) }));
  }
}
