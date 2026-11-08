import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context.ts';
import { newId, randomToken } from '../lib/crypto.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { detectMedia, jpegSize } from '../lib/media.ts';
import { DAY, HOUR, MINUTE } from '../lib/time.ts';
import { MetaApiError } from '../meta/errors.ts';
import { RetryLater } from '../queue/queue.ts';
import type { AccountRow } from './accounts.ts';

export type PostType = 'IMAGE' | 'REELS' | 'STORIES';
const TYPES: PostType[] = ['IMAGE', 'REELS', 'STORIES'];
export const PUBLISH_LIMIT_24H = 100; // Meta: 100 API-published posts per 24h per account
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_VIDEO = 100 * 1024 * 1024;

export interface PostRow {
  id: string;
  org_id: string;
  account_id: string;
  media_type: PostType;
  media_url: string;
  upload_id: string | null;
  caption: string | null;
  scheduled_at: number;
  status: 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';
  container_id: string | null;
  ig_media_id: string | null;
  permalink: string | null;
  error: string | null;
  created_at: number;
  published_at: number | null;
}

/** Official Content Publishing API: create container → wait until FINISHED → media_publish. */
export class PublishingService {
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  publicUrl(uploadId: string) {
    return `${this.ctx.config.publicBaseUrl}/u/${uploadId}`;
  }

  /** Meta downloads media from our server, so it must be reachable over public HTTPS. */
  publicUrlProblem(): string | null {
    const u = this.ctx.config.publicBaseUrl;
    if (!u.startsWith('https://') || /localhost|127\.0\.0\.1/.test(u)) return 'כדי ש-Meta תוכל להוריד את הקבצים, השרת צריך כתובת ציבורית ב-HTTPS (PUBLIC_BASE_URL). בינתיים אפשר לפרסם מקישור ציבורי לתמונה.';
    return null;
  }

  saveUpload(account: AccountRow, buf: Buffer, filename: string) {
    const kind = detectMedia(buf);
    if (!kind) throw badRequest('פורמט לא נתמך. אינסטגרם מקבל תמונות JPEG וסרטוני MP4.');
    if (kind === 'image/jpeg' && buf.length > MAX_IMAGE) throw badRequest('תמונה עד 8MB');
    if (kind === 'video/mp4' && buf.length > MAX_VIDEO) throw badRequest('סרטון עד 100MB');
    const size = kind === 'image/jpeg' ? jpegSize(buf) : null;
    const id = randomToken(24);
    mkdirSync(this.ctx.config.uploadsDir, { recursive: true });
    writeFileSync(join(this.ctx.config.uploadsDir, id), buf);
    this.ctx.db.run(
      'INSERT INTO uploads (id, org_id, account_id, filename, content_type, size, width, height, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, account.org_id, account.id, filename.slice(0, 200), kind, buf.length, size?.width ?? null, size?.height ?? null, this.ctx.now(),
    );
    return { id, url: this.publicUrl(id), contentType: kind, width: size?.width ?? null, height: size?.height ?? null, size: buf.length };
  }

  getUpload(id: string) {
    return this.ctx.db.get<{ id: string; content_type: string; size: number }>('SELECT id, content_type, size FROM uploads WHERE id = ?', id);
  }

  private validate(type: PostType, caption: string, upload?: { content_type: string; width: number | null; height: number | null }) {
    if (!TYPES.includes(type)) throw badRequest('סוג פרסום לא תקין');
    if (caption.length > 2200) throw badRequest('הכיתוב ארוך מ-2,200 תווים');
    if ((caption.match(/#[^\s#]+/g) ?? []).length > 30) throw badRequest('עד 30 האשטגים בפוסט');
    if ((caption.match(/@[\w.]+/g) ?? []).length > 20) throw badRequest('עד 20 תיוגים בפוסט');
    if (!upload) return;
    if (type === 'IMAGE' && upload.content_type !== 'image/jpeg') throw badRequest('פוסט תמונה דורש קובץ JPEG');
    if (type === 'REELS' && upload.content_type !== 'video/mp4') throw badRequest('רילס דורש סרטון MP4');
    if (type === 'IMAGE' && upload.width && upload.height) {
      const ratio = upload.width / upload.height;
      if (ratio < 0.8 || ratio > 1.91) throw badRequest(`יחס התמונה ${upload.width}×${upload.height} לא נתמך לפוסט. מותר בין 4:5 (לאורך) ל-1.91:1 (לרוחב).`);
    }
  }

  create(account: AccountRow, userId: string, input: { mediaType: string; uploadId?: string; mediaUrl?: string; caption?: string; scheduledAt?: number | null }) {
    const now = this.ctx.now();
    const type = input.mediaType as PostType;
    const caption = (input.caption ?? '').trim();
    let mediaUrl: string;
    let upload: any;
    if (input.uploadId) {
      upload = this.ctx.db.get('SELECT * FROM uploads WHERE id = ? AND account_id = ?', input.uploadId, account.id);
      if (!upload) throw notFound('הקובץ');
      mediaUrl = this.publicUrl(upload.id);
    } else {
      mediaUrl = String(input.mediaUrl ?? '').trim();
      if (!/^https:\/\/\S+$/.test(mediaUrl)) throw badRequest('יש להעלות קובץ או להזין קישור ציבורי (https) לקובץ');
    }
    this.validate(type, caption, upload);
    const at = input.scheduledAt ? Number(input.scheduledAt) : now;
    if (!Number.isFinite(at) || at < now - MINUTE) throw badRequest('מועד הפרסום כבר עבר');
    if (at > now + 75 * DAY) throw badRequest('ניתן לתזמן עד 75 יום קדימה');
    const id = newId('pst');
    this.ctx.db.run(
      `INSERT INTO scheduled_posts (id, org_id, account_id, media_type, media_url, upload_id, caption, scheduled_at, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'scheduled', ?,?,?)`,
      id, account.org_id, account.id, type, mediaUrl, upload?.id ?? null, caption || null, Math.max(at, now), userId, now, now,
    );
    this.enqueue(account, id, Math.max(at, now));
    this.ctx.audit.record(account.org_id, 'post.scheduled', { userId, accountId: account.id, details: { postId: id, type, at } });
    return this.get(account.org_id, id);
  }

  private enqueue(account: AccountRow, postId: string, at: number) {
    this.ctx.queue.enqueue({ type: 'publish_post', orgId: account.org_id, accountId: account.id, payload: { postId }, runAt: at, priority: 5, maxAttempts: 6, dedupeKey: `publish:${postId}` });
  }

  get(orgId: string, id: string): PostRow {
    const p = this.ctx.db.get<PostRow>('SELECT * FROM scheduled_posts WHERE id = ? AND org_id = ?', id, orgId);
    if (!p) throw notFound('הפרסום');
    return p;
  }

  list(account: AccountRow) {
    const posts = this.ctx.db.all<PostRow>(
      `SELECT * FROM scheduled_posts WHERE account_id = ? ORDER BY CASE WHEN status IN ('scheduled','publishing') THEN 0 ELSE 1 END, scheduled_at DESC LIMIT 100`, account.id,
    );
    return { posts, used24h: this.used24h(account.id), limit24h: PUBLISH_LIMIT_24H, publicUrlProblem: this.publicUrlProblem() };
  }

  used24h(accountId: string) {
    return this.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM scheduled_posts WHERE account_id = ? AND status = 'published' AND published_at > ?`, accountId, this.ctx.now() - DAY)!.n;
  }

  reschedule(orgId: string, id: string, at: number, userId: string) {
    const p = this.get(orgId, id);
    if (p.status !== 'scheduled') throw conflict('ניתן לשנות מועד רק לפרסום מתוזמן');
    if (!Number.isFinite(at) || at < this.ctx.now() - MINUTE || at > this.ctx.now() + 75 * DAY) throw badRequest('מועד לא תקין');
    this.ctx.db.run(`UPDATE jobs SET run_at = ?, updated_at = ? WHERE dedupe_key = ? AND status = 'queued'`, at, this.ctx.now(), `publish:${id}`);
    this.ctx.db.run('UPDATE scheduled_posts SET scheduled_at = ?, updated_at = ? WHERE id = ?', at, this.ctx.now(), id);
    this.ctx.audit.record(orgId, 'post.rescheduled', { userId, accountId: p.account_id, details: { postId: id, at } });
  }

  cancel(orgId: string, id: string, userId: string) {
    const p = this.get(orgId, id);
    if (p.status !== 'scheduled' && p.status !== 'failed') throw conflict('לא ניתן לבטל פרסום במצב זה');
    this.ctx.db.run(`UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE dedupe_key = ? AND status = 'queued'`, this.ctx.now(), `publish:${id}`);
    this.ctx.db.run(`UPDATE scheduled_posts SET status = 'cancelled', updated_at = ? WHERE id = ?`, this.ctx.now(), id);
    this.ctx.audit.record(orgId, 'post.cancelled', { userId, accountId: p.account_id, details: { postId: id } });
  }

  retry(orgId: string, id: string, userId: string) {
    const p = this.get(orgId, id);
    if (p.status !== 'failed') throw conflict('ניתן לנסות שוב רק פרסום שנכשל');
    const account = this.ctx.accounts.get(orgId, p.account_id);
    const now = this.ctx.now();
    // A fresh container is created on retry (old ones may have expired).
    this.ctx.db.run(`UPDATE scheduled_posts SET status = 'scheduled', error = NULL, container_id = NULL, scheduled_at = ?, updated_at = ? WHERE id = ?`, now, now, id);
    this.enqueue(account, id, now);
    this.ctx.audit.record(orgId, 'post.retried', { userId, accountId: p.account_id, details: { postId: id } });
  }

  markFailed(postId: string, error: string) {
    this.ctx.db.run(`UPDATE scheduled_posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status IN ('scheduled','publishing')`, error.slice(0, 500), this.ctx.now(), postId);
  }

  private req(account: AccountRow, path: string, params: Record<string, string | number | undefined>, method: 'GET' | 'POST' = 'GET') {
    return this.ctx.graph.request<any>({ provider: account.provider, token: this.ctx.accounts.token(account), path, params, method, accountId: account.id });
  }

  /** Job handler. Safe to re-run: every step is persisted and checked before repeating. */
  async publish(account: AccountRow, postId: string) {
    const post = this.ctx.db.get<PostRow>('SELECT * FROM scheduled_posts WHERE id = ? AND account_id = ?', postId, account.id);
    if (!post) return { skipped: 'post deleted' };
    if (post.status === 'published' || post.status === 'cancelled') return { skipped: post.status };
    const now = this.ctx.now();
    this.ctx.db.run(`UPDATE scheduled_posts SET status = 'publishing', updated_at = ? WHERE id = ?`, now, postId);
    try {
      const limit = await this.req(account, `${account.ig_user_id}/content_publishing_limit`, { fields: 'quota_usage,config' }).then((r) => r.data.data?.[0]).catch(() => null);
      const total = limit?.config?.quota_total ?? PUBLISH_LIMIT_24H;
      if (limit && limit.quota_usage >= total) {
        this.ctx.db.run(`UPDATE scheduled_posts SET status = 'scheduled', error = ?, updated_at = ? WHERE id = ?`, 'מכסת הפרסום היומית של Meta מלאה — יפורסם אוטומטית כשתתפנה', now, postId);
        throw new RetryLater(now + HOUR, 'publishing quota reached');
      }

      let containerId = post.container_id;
      if (!containerId) {
        const params: Record<string, string> = {};
        if (post.media_type === 'IMAGE') params.image_url = post.media_url;
        else if (post.media_type === 'REELS') Object.assign(params, { media_type: 'REELS', video_url: post.media_url });
        else Object.assign(params, { media_type: 'STORIES', [/\.mp4($|\?)/i.test(post.media_url) || this.isVideoUpload(post) ? 'video_url' : 'image_url']: post.media_url });
        if (post.caption && post.media_type !== 'STORIES') params.caption = post.caption;
        containerId = String((await this.req(account, `${account.ig_user_id}/media`, params, 'POST')).data.id);
        this.ctx.db.run('UPDATE scheduled_posts SET container_id = ?, updated_at = ? WHERE id = ?', containerId, now, postId);
      }

      const status = (await this.req(account, containerId, { fields: 'status_code,status' })).data;
      if (status.status_code === 'IN_PROGRESS') {
        if (now - post.scheduled_at > 2 * HOUR) throw new Error('עיבוד הסרטון ב-Meta נמשך יותר משעתיים');
        throw new RetryLater(now + 30_000, 'media still processing at Meta');
      }
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        const msg = `Meta לא הצליחה לעבד את הקובץ (${status.status_code}${status.status ? `: ${status.status}` : ''})`;
        this.markFailed(postId, msg);
        return { failed: msg };
      }
      if (status.status_code === 'PUBLISHED') {
        this.ctx.db.run(`UPDATE scheduled_posts SET status = 'published', published_at = COALESCE(published_at, ?), error = NULL, updated_at = ? WHERE id = ?`, now, now, postId);
        return { alreadyPublished: true };
      }

      const mediaId = String((await this.req(account, `${account.ig_user_id}/media_publish`, { creation_id: containerId }, 'POST')).data.id);
      this.ctx.db.run(`UPDATE scheduled_posts SET status = 'published', ig_media_id = ?, published_at = ?, error = NULL, updated_at = ? WHERE id = ?`, mediaId, now, now, postId);
      const permalink = await this.req(account, mediaId, { fields: 'permalink' }).then((r) => r.data.permalink).catch(() => null);
      if (permalink) this.ctx.db.run('UPDATE scheduled_posts SET permalink = ? WHERE id = ?', permalink, postId);
      this.ctx.audit.record(account.org_id, 'post.published', { accountId: account.id, details: { postId, mediaId } });
      return { published: mediaId };
    } catch (err) {
      if (err instanceof MetaApiError && (err.kind === 'invalid_request' || err.kind === 'permission')) this.markFailed(postId, `${err.userMessage}: ${err.message}`);
      throw err;
    }
  }

  private isVideoUpload(post: PostRow) {
    if (!post.upload_id) return false;
    return this.getUpload(post.upload_id)?.content_type === 'video/mp4';
  }
}
