import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildApp } from '../src/app.ts';
import { followersJson, followingJson, makeZip, testCtx } from './helpers.ts';

const H = { 'x-requested-with': 'niv-bot', 'content-type': 'application/json' };

async function setup(meta = true) {
  const t = testCtx({ meta });
  const app = await buildApp(t.ctx);
  const call = async (method: string, url: string, body?: unknown, cookie?: string, headers: Record<string, string> = H) => {
    const r = await app.inject({ method: method as any, url, payload: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), headers: { ...(body !== undefined || method !== 'GET' ? headers : {}), ...(cookie ? { cookie } : {}) } });
    return { status: r.statusCode, json: () => r.json(), body: r.body, headers: r.headers };
  };
  const register = async (email: string, org: string) => {
    const r = await call('POST', '/api/auth/register', { email, password: 'super-secret-pass', name: 'Niv', orgName: org });
    assert.equal(r.status, 200, r.body);
    return String(r.headers['set-cookie']).split(';')[0];
  };
  return { ...t, app, call, register };
}

test('auth: register/login/logout, cookie flags, CSRF header, unauthenticated access', async () => {
  const { call, register, app } = await setup();
  const cookie = await register('owner@niv.io', 'Niv Agency');
  assert.equal((await call('GET', '/api/auth/me', undefined, cookie)).json().user.email, 'owner@niv.io');
  assert.equal((await call('GET', '/api/accounts')).status, 401);
  // Missing CSRF header is rejected for state-changing requests
  assert.equal((await call('POST', '/api/accounts/pause-all', {}, cookie, { 'content-type': 'application/json' })).status, 403);
  assert.equal((await call('POST', '/api/auth/login', { email: 'owner@niv.io', password: 'wrong-password' })).status, 401);
  const login = await call('POST', '/api/auth/login', { email: 'OWNER@niv.io', password: 'super-secret-pass' });
  assert.equal(login.status, 200);
  assert.match(String(login.headers['set-cookie']), /HttpOnly; SameSite=Lax/);
  await call('POST', '/api/auth/logout', {}, cookie);
  assert.equal((await call('GET', '/api/accounts', undefined, cookie)).status, 401);
  // Security headers
  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(String(page.headers['content-security-policy']), /default-src 'self'/);
});

test('login brute-force protection', async () => {
  const { call, register } = await setup();
  await register('bf@niv.io', 'BF');
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await call('POST', '/api/auth/login', { email: 'bf@niv.io', password: 'nope-nope' })).status;
  assert.equal(last, 429);
});

test('full product flow over HTTP with tenant isolation', async () => {
  const { call, register, ctx } = await setup();
  const a = await register('a@niv.io', 'Org A');
  const b = await register('b@niv.io', 'Org B');

  const status = (await call('GET', '/api/meta/status', undefined, a)).json();
  assert.equal(status.providers.instagram_login.configured, true);
  assert.ok(status.capabilities.find((c: any) => c.key === 'follow' && c.support === 'not_supported'));

  const conn = await call('POST', '/api/accounts/connect-token', { provider: 'instagram_login', token: 'test-token-xxxxxxxxxxxxxxxxxxxx' }, a);
  assert.equal(conn.status, 200, conn.body);
  const acc = conn.json().accounts[0];
  assert.equal(acc.access_token_enc, undefined, 'token never leaves the server');

  // Org B cannot see or touch Org A's account
  assert.equal((await call('GET', `/api/accounts/${acc.id}`, undefined, b)).status, 404);
  assert.equal((await call('POST', `/api/accounts/${acc.id}/pause`, {}, b)).status, 404);
  assert.deepEqual((await call('GET', '/api/accounts', undefined, b)).json(), []);

  // Run the background engine over the queued initial sync
  const { Worker } = await import('../src/queue/worker.ts');
  const { drain } = await import('./helpers.ts');
  await drain(ctx, new Worker(ctx));
  const an = (await call('GET', `/api/accounts/${acc.id}/analytics?days=30`, undefined, a)).json();
  assert.equal(an.summary.followers, 1520);
  assert.equal(an.series.length, 30);
  assert.ok(an.weekly.length > 5);
  const csv = await call('GET', `/api/accounts/${acc.id}/reports/daily.csv`, undefined, a);
  assert.match(csv.body, /day,followers_count,net_change/);

  // Targets + follow task
  const add = await call('POST', `/api/accounts/${acc.id}/targets`, { usernames: 'lead.one\nlead.two', followWanted: true, segment: 'leads' }, a);
  assert.equal(add.json().added, 2);
  assert.equal((await call('GET', `/api/accounts/${acc.id}/targets?filter=to_follow`, undefined, a)).json().total, 2);
  const plan = (await call('POST', `/api/accounts/${acc.id}/tasks/plan`, {}, a)).json();
  assert.equal(plan.planned.follow, 2);
  const next = (await call('GET', `/api/accounts/${acc.id}/tasks/next?type=follow`, undefined, a)).json();
  assert.ok(next.task);
  assert.equal((await call('POST', `/api/tasks/${next.task.id}/complete`, { outcome: 'done' }, b)).status, 404, 'other org cannot complete');
  const done = await call('POST', `/api/tasks/${next.task.id}/complete`, { outcome: 'done' }, a);
  assert.equal(done.status, 200, done.body);
  const blocked = await call('POST', `/api/tasks/${done.json().task.id}/complete`, { outcome: 'done' }, a);
  assert.equal(blocked.status, 409, 'pacing gate enforced over HTTP');

  // Export upload (raw ZIP body)
  const zip = makeZip({ 'followers_1.json': followersJson([['lead.one', 1]]), 'following.json': followingJson([['lead.one', 1], ['ghost', 1]]) });
  const imp = await call('POST', `/api/accounts/${acc.id}/relationship-import`, zip, a, { 'x-requested-with': 'niv-bot', 'content-type': 'application/zip', 'x-filename': 'export.zip' });
  assert.equal(imp.status, 200, imp.body);
  assert.equal(imp.json().nonFollowers, 1);

  // Safety & automation controls
  assert.equal((await call('POST', `/api/accounts/${acc.id}/pause`, { hours: 2 }, a)).status, 200);
  assert.equal((await call('GET', `/api/accounts/${acc.id}/safety`, undefined, a)).json().account.status, 'paused');
  assert.equal((await call('POST', `/api/accounts/${acc.id}/resume`, {}, a)).status, 200);
  const run = (await call('POST', `/api/accounts/${acc.id}/jobs`, { type: 'sync_profile' }, a)).json();
  assert.ok(run.id);
  assert.equal((await call('POST', `/api/accounts/${acc.id}/jobs`, { type: 'sync_profile' }, a)).json().duplicate, true);
  assert.equal((await call('POST', `/api/accounts/${acc.id}/jobs`, { type: 'sync_competitors' }, a)).status, 400, 'FB-only job rejected for IG-login account');
  assert.equal((await call('POST', `/api/jobs/${run.id}/cancel`, {}, a)).status, 200);
  assert.equal((await call('PATCH', `/api/accounts/${acc.id}/schedules/sync_media`, { enabled: false }, a)).status, 200);
  const auto = (await call('GET', `/api/accounts/${acc.id}/automation`, undefined, a)).json();
  assert.equal(auto.schedules.find((s: any) => s.job_type === 'sync_media').enabled, 0);
  assert.ok(!auto.schedules.some((s: any) => s.job_type === 'sync_competitors'));

  const activity = (await call('GET', `/api/accounts/${acc.id}/activity`, undefined, a)).json();
  assert.ok(activity.some((x: any) => x.action === 'manual.follow.done'));
  assert.equal((await call('GET', '/api/activity', undefined, b)).json().length, 1, 'org B sees only its own audit log');

  // Delete (owner) erases all data
  assert.equal((await call('DELETE', `/api/accounts/${acc.id}`, undefined, a)).status, 200);
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM targets')!.n, 0);
});

test('OAuth: start redirects with state, callback exchanges code and connects', async () => {
  const { call, register } = await setup();
  const a = await register('o@niv.io', 'OAuth Org');
  const start = await call('GET', '/api/oauth/instagram_login/start', undefined, a);
  assert.equal(start.status, 302);
  const loc = new URL(String(start.headers.location));
  assert.equal(loc.host, 'www.instagram.com');
  assert.ok(loc.searchParams.get('scope')!.startsWith('instagram_business_basic,instagram_business_manage_insights,'));
  const state = loc.searchParams.get('state')!;
  const cb = await call('GET', `/api/oauth/instagram_login/callback?code=abc&state=${state}`);
  assert.equal(cb.status, 302);
  assert.match(decodeURIComponent(String(cb.headers.location)), /connected=niv.studio/);
  const replay = await call('GET', `/api/oauth/instagram_login/callback?code=abc&state=${state}`);
  assert.match(decodeURIComponent(String(replay.headers.location)), /error=/, 'state is single-use');

  const fb = await call('GET', '/api/oauth/facebook_login/start', undefined, a);
  const fbState = new URL(String(fb.headers.location)).searchParams.get('state');
  const fbCb = await call('GET', `/api/oauth/facebook_login/callback?code=xyz&state=${fbState}`);
  assert.match(decodeURIComponent(String(fbCb.headers.location)), /connected=niv.studio/);
  const accs = (await call('GET', '/api/accounts', undefined, a)).json();
  assert.equal(accs.length, 1, 'same IG account re-connected via a different login, not duplicated');
  assert.equal(accs[0].provider, 'facebook_login');
});

test('OAuth disabled without Meta app credentials; competitors need Facebook Login', async () => {
  const { call, register } = await setup(false);
  const a = await register('n@niv.io', 'No Meta');
  assert.equal((await call('GET', '/api/oauth/instagram_login/start', undefined, a)).status, 400);
  const conn = await call('POST', '/api/accounts/connect-token', { provider: 'instagram_login', token: 'test-token-xxxxxxxxxxxxxxxxxxxx' }, a);
  assert.equal(conn.status, 200, 'token connect works without app secret');
  const id = conn.json().accounts[0].id;
  assert.equal((await call('POST', `/api/accounts/${id}/competitors`, { username: 'competitor.one' }, a)).status, 400);
  const bad = await call('POST', '/api/accounts/connect-token', { provider: 'instagram_login', token: 'revoked-token-xxxxxxxxxxxxxxxx' }, a);
  assert.ok(bad.status >= 400);
});

test('Facebook Login: business discovery powers competitor tracking and audience enrichment', async () => {
  const { call, register, ctx } = await setup();
  const a = await register('fb@niv.io', 'FB Org');
  const conn = await call('POST', '/api/accounts/connect-token', { provider: 'facebook_login', token: 'fb-user-token-xxxxxxxxxxxxxxxxxx' }, a);
  assert.equal(conn.status, 200, conn.body);
  const id = conn.json().accounts[0].id;
  await call('POST', `/api/accounts/${id}/competitors`, { username: 'competitor.one' }, a);
  await call('POST', `/api/accounts/${id}/competitors`, { username: 'personal.acct' }, a);
  await call('POST', `/api/accounts/${id}/targets`, { usernames: 'target.biz\nprivate.person', followWanted: true }, a);
  ctx.queue.enqueue({ type: 'enrich_targets', orgId: ctx.accounts.findById(id)!.org_id, accountId: id });
  const { Worker } = await import('../src/queue/worker.ts');
  const { drain } = await import('./helpers.ts');
  await drain(ctx, new Worker(ctx));
  const comps = (await call('GET', `/api/accounts/${id}/competitors`, undefined, a)).json();
  assert.equal(comps.find((c: any) => c.username === 'competitor.one').followers, 9000);
  assert.ok(comps.find((c: any) => c.username === 'personal.acct').last_error);
  const t = (await call('GET', `/api/accounts/${id}/targets`, undefined, a)).json().items;
  assert.equal(t.find((x: any) => x.username === 'target.biz').followers_count, 4000);
  assert.equal(t.find((x: any) => x.username === 'private.person').enrich_status, 'unavailable');
});

test('Meta deauthorize + data deletion callbacks verify signature and erase data', async () => {
  const { call, register, app, ctx } = await setup();
  const a = await register('d@niv.io', 'Del Org');
  await call('POST', '/api/accounts/connect-token', { provider: 'instagram_login', token: 'test-token-xxxxxxxxxxxxxxxxxxxx' }, a);
  const payload = Buffer.from(JSON.stringify({ user_id: '17841400000000001', algorithm: 'HMAC-SHA256' })).toString('base64url');
  const sig = createHmac('sha256', 'ig-secret').update(payload).digest('base64url');
  const forged = await app.inject({ method: 'POST', url: '/meta/data-deletion', payload: `signed_request=bad.${payload}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(forged.statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: '/meta/data-deletion', payload: `signed_request=${sig}.${payload}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.json().confirmation_code);
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ig_accounts')!.n, 0);
});

test('demo workspace: one click, clearly flagged, rich sample data, never calls Meta', async () => {
  const { call, register, ctx, fake } = await setup();
  const a = await register('demo@niv.io', 'Demo Org');
  const r1 = (await call('POST', '/api/demo', {}, a)).json();
  const r2 = (await call('POST', '/api/demo', {}, a)).json();
  assert.equal(r1.id, r2.id, 'idempotent');
  const acc = (await call('GET', `/api/accounts/${r1.id}`, undefined, a)).json();
  assert.equal(acc.account.is_demo, 1);
  const an = (await call('GET', `/api/accounts/${r1.id}/analytics?days=90`, undefined, a)).json();
  assert.ok(an.summary.change7d > 0 && an.summary.change30d > 0);
  assert.ok(an.series.every((d: any) => typeof d.followers_count === 'number'));
  const sum = (await call('GET', `/api/accounts/${r1.id}/tasks/summary`, undefined, a)).json();
  assert.ok(sum.follow.byStatus.pending > 0 && sum.unfollow.byStatus.pending > 0 && sum.story_like.byStatus.pending > 0);
  assert.equal((await call('POST', `/api/accounts/${r1.id}/jobs`, { type: 'sync_profile' }, a)).status, 400);
  const before = fake.state.calls.length;
  ctx.queue.enqueue({ type: 'sync_profile', orgId: acc.account.org_id, accountId: r1.id });
  const { Worker } = await import('../src/queue/worker.ts');
  const { drain } = await import('./helpers.ts');
  await drain(ctx, new Worker(ctx));
  assert.equal(fake.state.calls.length, before, 'no Meta call for demo accounts');
  const cmp = (await call('GET', '/api/analytics/compare', undefined, a)).json();
  assert.equal(cmp[0].isDemo, true);
});
