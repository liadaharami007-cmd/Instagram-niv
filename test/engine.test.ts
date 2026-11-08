import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { Worker } from '../src/queue/worker.ts';
import { drain, seedOrg, testCtx } from './helpers.ts';

/** Facebook-Login account (the only login type with Meta's official Likes API). */
async function setup() {
  const t = testCtx();
  // The fake Graph timestamps use the real clock; align the test clock with it (12:00 Israel).
  t.clock.now = Date.now();
  const { orgId, userId } = seedOrg(t.ctx);
  const [acc] = await t.ctx.accounts.connectWithToken(orgId, userId, 'facebook_login', 'fb-user-token-xxxxxxxxxxxxxxxxxx');
  t.ctx.db.run(`UPDATE jobs SET status = 'cancelled'`);
  t.ctx.accounts.updateSettings(acc, { active_hour_start: 0, active_hour_end: 24 }, userId);
  t.ctx.targets.add(acc, userId, 'target.biz\ncompetitor.one\nprivate.person', { autoLike: true });
  return { ...t, orgId, userId, acc, worker: new Worker(t.ctx), fresh: () => t.ctx.accounts.findById(acc.id)! };
}

test('likes engine: finds fresh posts via Business Discovery and likes them with the official API', async () => {
  const { ctx, fake, clock, userId, fresh, worker } = await setup();
  assert.ok(fresh().user_token_enc, 'facebook user token stored (encrypted) for the Likes API');
  ctx.engagement.start(fresh(), userId);
  await drain(ctx, worker); // runs auto_like_plan
  let st = ctx.engagement.status(fresh());
  assert.equal(st.queued, 2, 'one fresh post per public business target');
  assert.equal(st.targets.unavailable, 1, 'private/personal account flagged, not liked');
  const runAts = st.actions.map((a: any) => a.run_at).sort();
  assert.ok(runAts[1] - runAts[0] >= 3600_000 / 10 - 1, 'likes are spaced across the hour');

  clock.now += 2 * 3600_000;
  await drain(ctx, worker);
  st = ctx.engagement.status(fresh());
  assert.equal(st.doneToday, 2);
  assert.equal(fake.state.likes.length, 2);
  assert.ok(fake.state.likes.every((l) => l.token.startsWith('fb-user-token')), 'User token used, not the Page token');
  assert.ok(fake.state.likes.every((l) => !l.mediaId.endsWith('1')), 'old (20-day) reels are skipped by the freshness window');

  // Running the planner again never likes the same post twice
  ctx.queue.enqueue({ type: 'auto_like_plan', orgId: fresh().org_id, accountId: fresh().id });
  await drain(ctx, worker);
  clock.now += 2 * 3600_000;
  await drain(ctx, worker);
  assert.equal(fake.state.likes.length, 2);
  void userId;
});

test('likes engine: budgets, success only on {success:true}, stop cancels queued work', async () => {
  const { ctx, fake, clock, userId, fresh, worker } = await setup();
  ctx.accounts.updateSettings(fresh(), { likes_per_hour: 1 }, userId);
  ctx.engagement.start(fresh(), userId);
  await drain(ctx, worker);
  assert.equal(ctx.engagement.status(fresh()).queued, 1, 'hourly budget respected');

  fake.inject(/likes$/, 200, { success: false }, 1);
  clock.now += 2 * 3600_000;
  await drain(ctx, worker);
  const s = ctx.engagement.status(fresh());
  assert.equal(s.doneToday, 0, 'success:false is never counted as a like');
  assert.equal(s.actions[0].status, 'failed');

  ctx.queue.enqueue({ type: 'auto_like_plan', orgId: fresh().org_id, accountId: fresh().id });
  await drain(ctx, worker);
  assert.equal(ctx.engagement.status(fresh()).queued, 1);
  ctx.engagement.stop(fresh(), 'stop', userId);
  const after = ctx.engagement.status(fresh());
  assert.equal(after.queued, 0);
  assert.equal(after.running, false);
  clock.now += 2 * 3600_000;
  await drain(ctx, worker);
  assert.equal(fake.state.likes.length, 0, 'nothing runs after stop');
});

test('likes engine: missing permission stops the engine; rate limit pauses the account without losing work', async () => {
  const { ctx, fake, clock, userId, fresh, worker } = await setup();
  ctx.engagement.start(fresh(), userId);
  await drain(ctx, worker);
  fake.inject(/likes$/, 400, { error: { message: 'Application request limit reached', code: 4 } }, 1);
  clock.now += 2 * 3600_000;
  await drain(ctx, worker, 1);
  await drain(ctx, worker, 1);
  assert.equal(fresh().status, 'paused');
  assert.ok(ctx.engagement.status(fresh()).queued >= 1, 'queued likes kept for after the pause');

  ctx.safety.resume(fresh(), userId);
  fake.inject(/likes$/, 403, { error: { message: '(#10) Application does not have permission for this action', code: 10 } }, 5);
  await drain(ctx, worker);
  const st = ctx.engagement.status(fresh());
  assert.equal(st.running, false, 'engine stopped on missing instagram_manage_engagement');
  assert.ok(ctx.db.get(`SELECT 1 FROM safety_events WHERE code = 'likes_engine_stopped'`));
});

test('likes engine refuses Instagram-Login accounts; capability report never claims unsupported actions', async () => {
  const t = testCtx();
  const app = await buildApp(t.ctx);
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'c@x.io', password: 'password-123456', name: 'C', orgName: 'C' }, headers: { 'x-requested-with': 'niv-bot' } });
  const cookie = String(reg.headers['set-cookie']).split(';')[0];
  const H = { 'x-requested-with': 'niv-bot', cookie };
  const conn = await app.inject({ method: 'POST', url: '/api/accounts/connect-token', payload: { provider: 'instagram_login', token: 'test-token-xxxxxxxxxxxxxxxxxxxx' }, headers: H });
  const id = conn.json().accounts[0].id;
  const start = await app.inject({ method: 'POST', url: `/api/accounts/${id}/engine/likes/start`, headers: H });
  assert.equal(start.statusCode, 400);
  assert.match(start.json().message, /Facebook Login/);
  const caps = (await app.inject({ method: 'GET', url: `/api/accounts/${id}/capabilities`, headers: { cookie } })).json();
  const by = Object.fromEntries(caps.map((c: any) => [c.key, c]));
  for (const k of ['follow', 'unfollow', 'story_like']) assert.equal(by[k].state, 'not_supported');
  assert.equal(by.likes.state, 'needs_other_login');
  assert.equal(by.profile.state, 'not_run_yet');
  const { drain: d } = await import('./helpers.ts');
  await d(t.ctx, new Worker(t.ctx));
  const caps2 = (await app.inject({ method: 'GET', url: `/api/accounts/${id}/capabilities`, headers: { cookie } })).json();
  assert.equal(caps2.find((c: any) => c.key === 'profile').state, 'verified');
});
