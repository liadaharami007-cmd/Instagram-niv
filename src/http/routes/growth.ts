import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.ts';
import { badRequest } from '../../lib/errors.ts';
import { MANUAL_TYPES } from '../../services/manual-tasks.ts';
import { parseInstagramExport } from '../../services/relationship-import.ts';
import type { ManualType } from '../../services/safety.ts';
import { normalizeUsername } from '../../services/targets.ts';

const asType = (t: unknown): ManualType => {
  if (!MANUAL_TYPES.includes(t as ManualType)) throw badRequest('סוג פעולה לא תקין');
  return t as ManualType;
};
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 1000) : []);

export function growthRoutes(app: FastifyInstance, ctx: Ctx) {
  const acc = (req: any) => ctx.accounts.get(req.auth.orgId, req.params.id);

  // ── Targets (audience) ──
  app.get('/api/accounts/:id/targets', async (req: any) => {
    const q = req.query;
    return ctx.targets.list(acc(req), { filter: q.filter, q: q.q, segment: q.segment || undefined, page: Number(q.page ?? 1), pageSize: Number(q.pageSize ?? 50) });
  });

  app.get('/api/accounts/:id/targets/counts', async (req: any) => ctx.targets.counts(acc(req)));

  app.post('/api/accounts/:id/targets', async (req: any) => {
    const b = req.body ?? {};
    if (typeof b.usernames !== 'string' || !b.usernames.trim()) throw badRequest('יש להזין לפחות שם משתמש אחד');
    return ctx.targets.add(acc(req), req.auth.userId, b.usernames, {
      segment: typeof b.segment === 'string' ? b.segment.trim() || undefined : undefined,
      followWanted: !!b.followWanted,
      engageStories: !!b.engageStories,
      whitelisted: !!b.whitelisted,
      source: b.source === 'csv' ? 'csv' : 'manual',
    });
  });

  app.patch('/api/targets', async (req: any) => ({ updated: ctx.targets.update(req.auth.orgId, ids(req.body?.ids), req.body?.patch ?? {}, req.auth.userId) }));
  app.post('/api/targets/delete', async (req: any) => ({ deleted: ctx.targets.remove(req.auth.orgId, ids(req.body?.ids), req.auth.userId) }));

  // ── Manual task workflows (Follow / Unfollow / Story likes) ──
  app.get('/api/accounts/:id/tasks', async (req: any) => {
    const q = req.query;
    return ctx.tasks.list(acc(req), { type: q.type ? asType(q.type) : undefined, status: q.status || undefined, day: q.day || undefined });
  });
  app.get('/api/accounts/:id/tasks/summary', async (req: any) => ctx.tasks.summary(acc(req)));
  app.get('/api/accounts/:id/tasks/history', async (req: any) => ctx.tasks.history(acc(req), Number(req.query.days ?? 30)));
  app.get('/api/accounts/:id/tasks/next', async (req: any) => ctx.tasks.next(acc(req), asType(req.query.type)));
  app.post('/api/accounts/:id/tasks/plan', async (req: any) => {
    const a = acc(req);
    const r = ctx.tasks.plan(a);
    ctx.audit.record(a.org_id, 'manual.planned', { userId: req.auth.userId, accountId: a.id, details: r });
    return r;
  });
  app.post('/api/tasks/:taskId/complete', async (req: any) => {
    const b = req.body ?? {};
    return ctx.tasks.complete(req.auth.orgId, req.params.taskId, String(b.outcome ?? ''), req.auth.userId, typeof b.note === 'string' ? b.note : undefined, b.force === true);
  });
  app.post('/api/accounts/:id/tasks/log', async (req: any) => ctx.tasks.logAdHoc(acc(req), asType(req.body?.type), String(req.body?.username ?? ''), req.auth.userId, normalizeUsername));

  // ── Official Instagram data export (followers / following) ──
  app.post('/api/accounts/:id/relationship-import', { bodyLimit: 200 * 1024 * 1024 }, async (req: any) => {
    const a = acc(req);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('לא התקבל קובץ');
    const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'upload'));
    return ctx.relationships.apply(a, req.auth.userId, parseInstagramExport(req.body, filename));
  });
  app.get('/api/accounts/:id/relationship-imports', async (req: any) => ctx.relationships.list(acc(req)));
}
