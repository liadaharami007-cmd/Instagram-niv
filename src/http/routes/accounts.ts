import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.ts';
import { randomToken } from '../../lib/crypto.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import { HOUR, DAY } from '../../lib/time.ts';
import { CAPABILITIES } from '../../meta/capabilities.ts';
import { MetaApiError } from '../../meta/errors.ts';
import type { Provider } from '../../meta/graph-client.ts';
import { SCOPES } from '../../meta/oauth.ts';
import { HARD_LIMITS } from '../../services/safety.ts';
import { normalizeUsername } from '../../services/targets.ts';
import { handlers, JOB_LABELS } from '../../queue/worker.ts';
import { requireRole } from '../auth.ts';

const PROVIDERS: Provider[] = ['instagram_login', 'facebook_login'];
const asProvider = (p: unknown): Provider => {
  if (!PROVIDERS.includes(p as Provider)) throw badRequest('סוג חיבור לא תקין');
  return p as Provider;
};

export function accountRoutes(app: FastifyInstance, ctx: Ctx) {
  const acc = (req: any) => ctx.accounts.get(req.auth.orgId, req.params.id);
  const admin = (req: any) => requireRole(req, ['owner', 'admin']);

  app.get('/api/meta/status', async () => ({
    graphVersion: ctx.config.meta.graphVersion,
    providers: Object.fromEntries(PROVIDERS.map((p) => [p, { configured: ctx.oauth.isConfigured(p), scopes: SCOPES[p], redirectUri: ctx.oauth.redirectUri(p) }])),
    capabilities: CAPABILITIES,
    hardLimits: HARD_LIMITS,
  }));

  // ── OAuth connect ──
  app.get('/api/oauth/:provider/start', async (req: any, reply) => {
    admin(req);
    const provider = asProvider(req.params.provider);
    if (!ctx.oauth.isConfigured(provider)) throw badRequest('חיבור זה עדיין לא הוגדר: חסרים מזהה וסוד אפליקציית Meta בקובץ ההגדרות');
    const state = randomToken(24);
    ctx.db.run('INSERT INTO oauth_states (state, org_id, user_id, provider, expires_at) VALUES (?,?,?,?,?)', state, req.auth.orgId, req.auth.userId, provider, ctx.now() + 15 * 60_000);
    return reply.redirect(ctx.oauth.authorizeUrl(provider, state));
  });

  app.get('/api/oauth/:provider/callback', async (req: any, reply) => {
    const provider = asProvider(req.params.provider);
    const q = req.query as Record<string, string>;
    const back = (params: Record<string, string>) => reply.redirect(`/#/accounts?${new URLSearchParams(params)}`);
    const st = q.state ? ctx.db.get<{ org_id: string; user_id: string; provider: string; expires_at: number }>('SELECT * FROM oauth_states WHERE state = ?', q.state) : undefined;
    if (q.state) ctx.db.run('DELETE FROM oauth_states WHERE state = ?', q.state);
    if (!st || st.provider !== provider || st.expires_at < ctx.now()) return back({ error: 'פג תוקף בקשת החיבור. נסה שוב.' });
    if (q.error || !q.code) return back({ error: q.error_description || q.error_reason || 'החיבור בוטל' });
    try {
      const profiles = await ctx.oauth.exchangeCode(provider, q.code.replace(/#_$/, ''));
      if (!profiles.length) return back({ error: 'לא נמצאו חשבונות Instagram מקצועיים בחיבור זה' });
      const saved = ctx.accounts.saveConnected(st.org_id, st.user_id, provider, profiles);
      return back({ connected: saved.map((a) => a.username).join(',') });
    } catch (err) {
      ctx.log.warn({ err }, 'oauth callback failed');
      return back({ error: err instanceof MetaApiError ? `Meta: ${err.message}` : 'החיבור נכשל' });
    }
  });

  app.post('/api/accounts/connect-token', async (req: any) => {
    admin(req);
    const body = req.body ?? {};
    const saved = await ctx.accounts.connectWithToken(req.auth.orgId, req.auth.userId, asProvider(body.provider), String(body.token ?? ''));
    return { accounts: saved.map((a) => ctx.accounts.toPublic(a)) };
  });

  // ── Demo workspace (clearly flagged sample data, never touches Meta) ──
  app.post('/api/demo', async (req: any) => {
    admin(req);
    return { id: ctx.demo.create(req.auth.orgId, req.auth.userId).id };
  });

  // ── What actually works for this account (from real job outcomes, never assumed) ──
  app.get('/api/accounts/:id/capabilities', async (req: any) => {
    const a = acc(req);
    const last = (types: string[], status: string) =>
      types.length
        ? ctx.db.get<{ t: number; e: string | null; type: string }>(
            `SELECT COALESCE(finished_at, updated_at) AS t, last_error AS e, type FROM jobs WHERE account_id = ? AND status = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`,
            a.id, status, ...types,
          )
        : undefined;
    const likes = ctx.db.get<{ ok: number | null; bad: number | null; err: string | null }>(
      `SELECT MAX(CASE WHEN status = 'done' THEN executed_at END) AS ok, MAX(CASE WHEN status = 'failed' THEN executed_at END) AS bad,
              (SELECT error FROM engagement_actions WHERE account_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 1) AS err
         FROM engagement_actions WHERE account_id = ?`, a.id, a.id,
    );
    return CAPABILITIES.map((c) => {
      let state: string;
      let lastSuccessAt: number | null = null;
      let lastFailure: { at: number; error: string | null } | null = null;
      if (c.support === 'not_supported') state = 'not_supported';
      else if (!c.providers.includes(a.provider)) state = 'needs_other_login';
      else if (a.is_demo) state = 'demo';
      else if (c.key === 'safety') state = 'active';
      else {
        const ok = c.key === 'likes' ? (likes?.ok ? { t: likes.ok } : undefined) : last(c.jobTypes, 'succeeded');
        const bad = c.key === 'likes' ? (likes?.bad ? { t: likes.bad, e: likes.err } : undefined) : last(c.jobTypes, 'failed');
        lastSuccessAt = ok?.t ?? null;
        lastFailure = bad ? { at: bad.t, error: bad.e ?? null } : null;
        state = ok && (!bad || ok.t >= bad.t) ? 'verified' : bad ? 'failing' : 'not_run_yet';
      }
      return { ...c, state, lastSuccessAt, lastFailure };
    });
  });

  // ── Autopilot: one screen, one switch per feature ──
  app.get('/api/accounts/:id/autopilot', async (req: any) => ctx.autopilot.status(acc(req)));
  app.patch('/api/accounts/:id/autopilot/:feature', async (req: any) => {
    admin(req);
    ctx.autopilot.set(acc(req), req.params.feature, req.body ?? {}, req.auth.userId);
    return ctx.autopilot.status(acc(req));
  });

  // ── Official Likes engine (start / stop / monitor) ──
  app.get('/api/accounts/:id/engine/likes', async (req: any) => ctx.engagement.status(acc(req)));
  app.post('/api/accounts/:id/engine/likes/start', async (req: any) => {
    admin(req);
    ctx.engagement.start(acc(req), req.auth.userId);
    return { ok: true };
  });
  app.post('/api/accounts/:id/engine/likes/stop', async (req: any) => {
    ctx.engagement.stop(acc(req), 'נעצר ידנית', req.auth.userId);
    return { ok: true };
  });

  // ── Accounts ──
  app.get('/api/accounts', async (req: any) =>
    ctx.accounts.list(req.auth.orgId).map((a) => ({ ...ctx.accounts.toPublic(a), summary: ctx.analytics.summary(a), tasks: ctx.tasks.summary(a) })),
  );

  app.get('/api/accounts/:id', async (req: any) => {
    const a = acc(req);
    return { account: ctx.accounts.toPublic(a), settings: ctx.accounts.settings(a.id), summary: ctx.analytics.summary(a) };
  });

  app.patch('/api/accounts/:id/settings', async (req: any) => {
    admin(req);
    return ctx.accounts.updateSettings(acc(req), req.body ?? {}, req.auth.userId);
  });

  app.delete('/api/accounts/:id', async (req: any) => {
    requireRole(req, ['owner']);
    ctx.accounts.remove(acc(req), req.auth.userId);
    return { ok: true };
  });

  app.post('/api/accounts/:id/pause', async (req: any) => {
    const hours = req.body?.hours ? Number(req.body.hours) : null;
    if (hours !== null && (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30)) throw badRequest('משך השהיה לא תקין');
    ctx.safety.pause(acc(req), hours ? ctx.now() + hours * HOUR : null, 'הושהה ידנית', req.auth.userId);
    return { ok: true };
  });

  app.post('/api/accounts/:id/resume', async (req: any) => {
    ctx.safety.resume(acc(req), req.auth.userId);
    return { ok: true };
  });

  app.post('/api/accounts/pause-all', async (req: any) => {
    for (const a of ctx.accounts.list(req.auth.orgId)) if (a.status === 'active') ctx.safety.pause(a, null, 'עצירה כללית', req.auth.userId);
    return { ok: true };
  });

  app.post('/api/accounts/resume-all', async (req: any) => {
    for (const a of ctx.accounts.list(req.auth.orgId)) if (a.status === 'paused') ctx.safety.resume(a, req.auth.userId);
    return { ok: true };
  });

  // ── Analytics ──
  app.get('/api/accounts/:id/analytics', async (req: any) => {
    const a = acc(req);
    const days = Number(req.query.days ?? 30);
    return {
      summary: ctx.analytics.summary(a),
      series: ctx.analytics.series(a, days),
      weekly: ctx.analytics.weekly(a),
      unsupported: JSON.parse(a.unsupported_metrics),
      lastSyncedAt: a.last_synced_at,
    };
  });

  app.get('/api/accounts/:id/media', async (req: any) => ctx.analytics.topMedia(acc(req), req.query.type === 'story' ? 'story' : 'feed', Number(req.query.limit ?? 24)));

  app.get('/api/accounts/:id/reports/daily.csv', async (req: any, reply) => {
    const a = acc(req);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${a.username}-daily.csv"`);
    return ctx.analytics.csv(a, Number(req.query.days ?? 90));
  });

  app.get('/api/analytics/compare', async (req: any) => ctx.analytics.compare(req.auth.orgId));

  app.get('/api/accounts/:id/competitors', async (req: any) => ctx.analytics.competitors(acc(req)));
  app.post('/api/accounts/:id/competitors', async (req: any) => {
    const u = normalizeUsername(String(req.body?.username ?? ''));
    if (!u) throw badRequest('שם משתמש לא תקין');
    ctx.analytics.addCompetitor(acc(req), u);
    return { ok: true };
  });
  app.delete('/api/accounts/:id/competitors/:username', async (req: any) => {
    const a = acc(req);
    ctx.db.run('DELETE FROM competitors WHERE account_id = ? AND username = ?', a.id, req.params.username);
    ctx.db.run('DELETE FROM competitor_snapshots WHERE account_id = ? AND username = ?', a.id, req.params.username);
    return { ok: true };
  });

  // ── Safety ──
  app.get('/api/accounts/:id/safety', async (req: any) => {
    const a = acc(req);
    const s = ctx.accounts.settings(a.id);
    return {
      account: ctx.accounts.toPublic(a),
      settings: s,
      gates: { follow: ctx.safety.manualGate(a, s, 'follow'), unfollow: ctx.safety.manualGate(a, s, 'unfollow'), story_like: ctx.safety.manualGate(a, s, 'story_like') },
      api24h: ctx.safety.apiStats(a.id, DAY),
      events: ctx.safety.events(a.org_id, a.id, 50),
      tokenExpiresInDays: a.token_expires_at ? Math.floor((a.token_expires_at - ctx.now()) / DAY) : null,
    };
  });

  app.post('/api/accounts/:id/report-block', async (req: any) => {
    const a = acc(req);
    const until = ctx.safety.reportActionBlock(a, ctx.accounts.settings(a.id), req.auth.userId, req.body?.note);
    return { until };
  });

  app.post('/api/accounts/:id/clear-cooldown', async (req: any) => {
    admin(req);
    ctx.safety.clearCooldown(acc(req), req.auth.userId);
    return { ok: true };
  });

  // ── Automation (schedules + job queue) ──
  app.get('/api/accounts/:id/automation', async (req: any) => {
    const a = acc(req);
    return {
      schedules: ctx.accounts.schedules(a.id).map((s: any) => ({ ...s, label: JOB_LABELS[s.job_type] ?? s.job_type })),
      jobs: ctx.queue.list(a.org_id, a.id, 60).map((j) => ({ ...j, label: JOB_LABELS[j.type] ?? j.type })),
    };
  });

  app.patch('/api/accounts/:id/schedules/:type', async (req: any) => {
    admin(req);
    ctx.accounts.updateSchedule(acc(req), req.params.type, req.body ?? {}, req.auth.userId);
    return { ok: true };
  });

  app.post('/api/accounts/:id/jobs', async (req: any) => {
    const a = acc(req);
    const type = String(req.body?.type ?? '');
    if (!handlers[type]) throw badRequest('סוג משימה לא מוכר');
    if (!ctx.accounts.schedules(a.id).some((s: any) => s.job_type === type)) throw badRequest('משימה זו אינה זמינה לסוג החיבור של החשבון');
    const id = ctx.queue.enqueue({ type, orgId: a.org_id, accountId: a.id, priority: 5, payload: req.body?.payload ?? {}, dedupeKey: `${type}:${a.id}` });
    ctx.audit.record(a.org_id, 'automation.run_now', { userId: req.auth.userId, accountId: a.id, details: { type } });
    return { id, duplicate: id === null };
  });

  app.post('/api/jobs/:jobId/cancel', async (req: any) => {
    if (!ctx.queue.cancel(Number(req.params.jobId), req.auth.orgId)) throw notFound('משימה ממתינה');
    return { ok: true };
  });

  app.post('/api/jobs/:jobId/retry', async (req: any) => {
    if (!ctx.queue.retry(Number(req.params.jobId), req.auth.orgId)) throw notFound('משימה שנכשלה');
    return { ok: true };
  });

  // ── Activity ──
  app.get('/api/accounts/:id/activity', async (req: any) => ctx.audit.list(req.auth.orgId, { accountId: acc(req).id, limit: Number(req.query.limit ?? 100), before: req.query.before ? Number(req.query.before) : undefined }));
  app.get('/api/activity', async (req: any) => ctx.audit.list(req.auth.orgId, { limit: Number(req.query.limit ?? 100), before: req.query.before ? Number(req.query.before) : undefined }));
}
