import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.ts';
import { parseSignedRequest, randomToken } from '../../lib/crypto.ts';
import type { Scheduler, Worker } from '../../queue/worker.ts';

export interface Runtime {
  worker?: Worker;
  scheduler?: Scheduler;
  startedAt: number;
}

export function systemRoutes(app: FastifyInstance, ctx: Ctx, runtime: Runtime) {
  /** Liveness + readiness for uptime monitors / container orchestrators. */
  app.get('/api/system/health', async (_req, reply) => {
    let db = true;
    try {
      ctx.db.get('SELECT 1');
    } catch {
      db = false;
    }
    const now = ctx.now();
    const workerOk = !runtime.worker || now - runtime.worker.lastTickAt < 60_000;
    const ok = db && workerOk;
    reply.code(ok ? 200 : 503);
    return { ok, db, worker: runtime.worker ? { ok: workerOk, busy: runtime.worker.busy } : 'external', uptimeSec: Math.round((now - runtime.startedAt) / 1000) };
  });

  app.get('/api/system/status', async (req: any) => {
    const orgId = req.auth.orgId;
    const queue = ctx.db.all<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM jobs WHERE org_id = ? AND (status IN ('queued','running') OR finished_at > ?) GROUP BY status`,
      orgId, ctx.now() - 86_400_000,
    );
    const api = ctx.db.get<{ total: number; errors: number; avg_ms: number }>(
      `SELECT COUNT(*) AS total, SUM(error_kind IS NOT NULL) AS errors, AVG(duration_ms) AS avg_ms FROM api_calls
        WHERE created_at > ? AND account_id IN (SELECT id FROM ig_accounts WHERE org_id = ?)`,
      ctx.now() - 86_400_000, orgId,
    );
    return {
      queue: Object.fromEntries(queue.map((r) => [r.status, r.n])),
      api24h: { total: api?.total ?? 0, errors: api?.errors ?? 0, avgMs: Math.round(api?.avg_ms ?? 0) },
      worker: runtime.worker ? { lastTickAt: runtime.worker.lastTickAt, busy: runtime.worker.busy } : null,
      scheduler: runtime.scheduler ? { lastTickAt: runtime.scheduler.lastTickAt } : null,
    };
  });

  // ── Meta platform callbacks (required for App Review) ──
  const signedUser = (body: any): string | null => {
    const sr = body?.signed_request;
    if (typeof sr !== 'string') return null;
    for (const secret of [ctx.config.meta.igAppSecret, ctx.config.meta.fbAppSecret]) {
      const data = secret ? parseSignedRequest(sr, secret) : null;
      if (data?.user_id) return String(data.user_id);
    }
    return null;
  };
  const accountsForMetaUser = (uid: string) =>
    ctx.db.all<{ id: string }>('SELECT id FROM ig_accounts WHERE ig_user_id = ? OR app_scoped_user_id = ?', uid, uid).map((r) => ctx.accounts.findById(r.id)!);

  app.post('/meta/deauthorize', async (req, reply) => {
    const uid = signedUser(req.body);
    if (!uid) return reply.code(400).send({ error: 'invalid signed_request' });
    for (const a of accountsForMetaUser(uid)) {
      ctx.db.run(`UPDATE ig_accounts SET status = 'disconnected', access_token_enc = '', updated_at = ? WHERE id = ?`, ctx.now(), a.id);
      ctx.queue.cancelForAccount(a.id, 'deauthorized by user in Meta');
      ctx.safety.event(a.org_id, a.id, 'critical', 'deauthorized', 'המשתמש ביטל את הרשאות האפליקציה ב-Meta. החשבון נותק.');
    }
    return { ok: true };
  });

  app.post('/meta/data-deletion', async (req, reply) => {
    const uid = signedUser(req.body);
    if (!uid) return reply.code(400).send({ error: 'invalid signed_request' });
    for (const a of accountsForMetaUser(uid)) ctx.accounts.remove(a, null, 'meta_data_deletion_request');
    const code = randomToken(12);
    return { url: `${ctx.config.publicBaseUrl}/meta/data-deletion/status?code=${code}`, confirmation_code: code };
  });

  app.get('/meta/data-deletion/status', async (req: any, reply) => {
    reply.type('text/html; charset=utf-8');
    const code = String(req.query.code ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    return `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>מחיקת נתונים</title><body style="font-family:sans-serif;padding:2rem">
      <h1>בקשת מחיקת נתונים</h1><p>כל הנתונים של החשבון נמחקו לצמיתות מהמערכת.</p><p>קוד אישור: <code>${code}</code></p></body></html>`;
  });
}
