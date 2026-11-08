import { createReadStream, existsSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.ts';
import { badRequest } from '../../lib/errors.ts';
import { TEMPLATES } from '../../services/auto-replies.ts';
import type { AccountRow } from '../../services/accounts.ts';

/** Verifies Meta's X-Hub-Signature-256 against either configured app secret. */
export function verifyMetaSignature(raw: string, header: string | undefined, secrets: string[]): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  return secrets.filter(Boolean).some((s) => {
    const expected = createHmac('sha256', s).update(raw).digest();
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export function engageRoutes(app: FastifyInstance, ctx: Ctx) {
  const acc = (req: any) => ctx.accounts.get(req.auth.orgId, req.params.id);

  // ── Media uploads (served publicly at an unguessable URL so Meta can fetch them) ──
  app.post('/api/accounts/:id/uploads', { bodyLimit: 110 * 1024 * 1024 }, async (req: any) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('לא התקבל קובץ');
    return ctx.publishing.saveUpload(acc(req), req.body, decodeURIComponent(String(req.headers['x-filename'] ?? 'upload')));
  });

  app.get('/u/:uploadId', async (req: any, reply) => {
    const id = String(req.params.uploadId).replace(/[^A-Za-z0-9_-]/g, '');
    const up = ctx.publishing.getUpload(id);
    const file = join(ctx.config.uploadsDir, id);
    if (!up || !existsSync(file)) return reply.code(404).send({ error: 'not_found' });
    reply.header('content-type', up.content_type).header('content-length', up.size).header('cache-control', 'public, max-age=86400');
    return reply.send(createReadStream(file));
  });

  // ── Scheduled publishing ──
  app.get('/api/accounts/:id/posts', async (req: any) => ctx.publishing.list(acc(req)));
  app.post('/api/accounts/:id/posts', async (req: any) => ctx.publishing.create(acc(req), req.auth.userId, req.body ?? {}));
  app.patch('/api/posts/:postId', async (req: any) => {
    ctx.publishing.reschedule(req.auth.orgId, req.params.postId, Number(req.body?.scheduledAt), req.auth.userId);
    return { ok: true };
  });
  app.post('/api/posts/:postId/cancel', async (req: any) => {
    ctx.publishing.cancel(req.auth.orgId, req.params.postId, req.auth.userId);
    return { ok: true };
  });
  app.post('/api/posts/:postId/retry', async (req: any) => {
    ctx.publishing.retry(req.auth.orgId, req.params.postId, req.auth.userId);
    return { ok: true };
  });

  // ── Auto-reply rules ──
  app.get('/api/reply-templates', async () => TEMPLATES);
  app.get('/api/accounts/:id/reply-rules', async (req: any) => {
    const a = acc(req);
    return { rules: ctx.autoReplies.rules(a), status: ctx.autoReplies.status(a), limit: ctx.accounts.settings(a.id).auto_reply_hourly_limit };
  });
  app.post('/api/accounts/:id/reply-rules', async (req: any) => ({ id: ctx.autoReplies.createRule(acc(req), req.auth.userId, req.body ?? {}) }));
  app.patch('/api/reply-rules/:ruleId', async (req: any) => {
    ctx.autoReplies.updateRule(req.auth.orgId, req.params.ruleId, req.auth.userId, req.body ?? {});
    return { ok: true };
  });
  app.delete('/api/reply-rules/:ruleId', async (req: any) => {
    ctx.autoReplies.deleteRule(req.auth.orgId, req.params.ruleId, req.auth.userId);
    return { ok: true };
  });
  app.get('/api/accounts/:id/auto-replies', async (req: any) => ctx.autoReplies.history(acc(req), Number(req.query.limit ?? 100)));

  // ── Meta Webhooks: real-time comments & messages ──
  app.get('/meta/webhook', async (req: any, reply) => {
    const q = req.query;
    const token = ctx.config.meta.webhookVerifyToken;
    if (q['hub.mode'] === 'subscribe' && token && q['hub.verify_token'] === token) return reply.type('text/plain').send(String(q['hub.challenge'] ?? ''));
    return reply.code(403).send('forbidden');
  });

  app.post('/meta/webhook', async (req: any, reply) => {
    const raw = String(req.rawBody ?? '');
    if (!verifyMetaSignature(raw, req.headers['x-hub-signature-256'], [ctx.config.meta.igAppSecret, ctx.config.meta.fbAppSecret])) {
      req.log.warn('webhook with invalid signature rejected');
      return reply.code(401).send({ error: 'invalid signature' });
    }
    const body = req.body ?? {};
    let queued = 0;
    for (const entry of body.entry ?? []) {
      const accounts = ctx.db.all<AccountRow>(
        `SELECT * FROM ig_accounts WHERE (ig_user_id = ? OR app_scoped_user_id = ?) AND status != 'disconnected' AND is_demo = 0`, String(entry.id), String(entry.id),
      );
      for (const a of accounts) {
        ctx.db.run('UPDATE ig_accounts SET last_webhook_at = ? WHERE id = ?', ctx.now(), a.id);
        for (const ch of entry.changes ?? []) {
          if (ch.field !== 'comments' || !ch.value?.id) continue;
          const v = ch.value;
          const comment = { id: String(v.id), text: String(v.text ?? ''), username: v.from?.username, fromId: v.from?.id ? String(v.from.id) : undefined, mediaId: v.media?.id ? String(v.media.id) : undefined };
          if (ctx.queue.enqueue({ type: 'process_comment', orgId: a.org_id, accountId: a.id, priority: 3, payload: { comment }, dedupeKey: `c:${a.id}:${comment.id}` })) queued++;
        }
        for (const m of entry.messaging ?? []) {
          if (!m.message?.mid || m.message.is_echo || !m.message.text) continue;
          const message = { mid: String(m.message.mid), senderId: String(m.sender?.id ?? ''), text: String(m.message.text) };
          if (ctx.queue.enqueue({ type: 'process_dm', orgId: a.org_id, accountId: a.id, priority: 3, payload: { message }, dedupeKey: `m:${a.id}:${message.mid}` })) queued++;
        }
      }
    }
    // Meta expects a fast 200; processing happens in the durable queue.
    return { ok: true, queued };
  });
}
