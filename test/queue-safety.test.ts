import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker, Scheduler } from '../src/queue/worker.ts';
import { HOUR, MINUTE } from '../src/lib/time.ts';
import { connectAccount, drain, seedOrg, testCtx } from './helpers.ts';

test('queue: dedupe, per-account serialisation, retries, exhaustion, defer, lease recovery', () => {
  const { ctx, clock } = testCtx();
  const q = ctx.queue;
  const a = q.enqueue({ type: 'x', accountId: 'acc1', dedupeKey: 'k1' });
  assert.ok(a);
  assert.equal(q.enqueue({ type: 'x', accountId: 'acc1', dedupeKey: 'k1' }), null, 'duplicate ignored while queued');
  q.enqueue({ type: 'y', accountId: 'acc1' });
  q.enqueue({ type: 'z', accountId: 'acc2' });

  const j1 = q.claim('w', 60_000)!;
  const j2 = q.claim('w', 60_000)!;
  assert.equal(j1.account_id, 'acc1');
  assert.equal(j2.account_id, 'acc2', 'second acc1 job must wait while first runs');
  assert.equal(q.claim('w', 60_000), undefined);

  // Retry with backoff
  assert.equal(q.fail(j1.id, 'boom'), 'retry');
  assert.equal(q.claim('w', 60_000)?.type, 'y', 'retried job is scheduled in the future');
  clock.now += 2 * MINUTE;
  const again = q.claim('w', 60_000);
  assert.equal(again, undefined, 'acc1 still busy with job y');

  // Exhaustion
  const id = q.enqueue({ type: 'once', maxAttempts: 1 })!;
  const job = q.claim('w', 60_000)!;
  assert.equal(job.id, id);
  assert.equal(q.fail(job.id, 'fatal'), 'failed');

  // Defer keeps attempts
  const d = q.enqueue({ type: 'defer-me' })!;
  const dj = q.claim('w', 60_000)!;
  assert.equal(dj.id, d);
  q.defer(d, clock.now + HOUR, 'paused');
  assert.equal(ctx.db.get<{ attempts: number }>('SELECT attempts FROM jobs WHERE id = ?', d)!.attempts, 0);

  // Lease recovery
  const l = q.enqueue({ type: 'lease' })!;
  q.claim('w', 1_000);
  clock.now += 5_000;
  assert.ok(q.recoverExpired() >= 1);
  assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', l)!.status, 'queued');
});

test('worker syncs real profile/insights/media/stories data through the full pipeline', async () => {
  const { ctx, fake } = testCtx();
  const { orgId, userId } = seedOrg(ctx);
  const acc = await connectAccount(ctx, orgId, userId);
  assert.equal(acc.username, 'niv.studio');
  assert.ok(acc.token_expires_at! > ctx.now(), 'short token exchanged for long-lived (60d)');
  const worker = new Worker(ctx);
  assert.equal(await drain(ctx, worker), 4, 'initial sync jobs: profile, insights, media, stories');
  const jobs = ctx.db.all<{ type: string; status: string; last_error: string }>('SELECT type, status, last_error FROM jobs');
  assert.ok(jobs.every((j) => j.status === 'succeeded'), JSON.stringify(jobs));

  const a = ctx.accounts.findById(acc.id)!;
  assert.equal(a.followers_count, 1520);
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM follower_snapshots')!.n, 1);
  const metrics = ctx.db.all<{ metric: string }>('SELECT DISTINCT metric FROM daily_metrics').map((r) => r.metric);
  for (const m of ['followers_count', 'new_followers', 'reach', 'views', 'total_interactions', 'follows', 'unfollows']) assert.ok(metrics.includes(m), `missing ${m}`);
  assert.equal(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM media WHERE media_product_type = 'STORY'`)!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM media WHERE media_product_type = 'FEED'`)!.n, 3);
  // Access token never stored in plain text
  assert.ok(!a.access_token_enc.includes('long-lived-token'));
  assert.ok(fake.state.calls.some((c) => c.includes('/access_token')));
});

test('growth analytics: daily/weekly changes come only from real snapshots', async () => {
  const { ctx, fake, clock } = testCtx();
  const { orgId, userId } = seedOrg(ctx);
  const acc = await connectAccount(ctx, orgId, userId);
  const worker = new Worker(ctx);
  await drain(ctx, worker);
  let s = ctx.analytics.summary(ctx.accounts.findById(acc.id)!);
  assert.equal(s.followers, 1520);
  assert.equal(s.change1d, null, 'no history yet → no fabricated change');

  clock.now += 24 * HOUR + MINUTE;
  fake.state.followers = 1555;
  ctx.queue.enqueue({ type: 'sync_profile', orgId, accountId: acc.id });
  await drain(ctx, worker);
  s = ctx.analytics.summary(ctx.accounts.findById(acc.id)!);
  assert.equal(s.change1d, 35);
  assert.equal(s.change7d, null);
  const series = ctx.analytics.series(ctx.accounts.findById(acc.id)!, 7);
  assert.equal(series.at(-1)!.net_change, 35);
  const weekly = ctx.analytics.weekly(ctx.accounts.findById(acc.id)!);
  assert.equal(weekly.find((r) => r.metric === 'net_change')!.current, 35);
});

test('unsupported insight metric is detected, remembered and the rest still syncs', async () => {
  const { ctx, fake } = testCtx();
  const { orgId, userId } = seedOrg(ctx);
  const acc = await connectAccount(ctx, orgId, userId);
  fake.state.unsupportedMetrics.add('profile_links_taps');
  fake.state.unsupportedMetrics.add('follower_count');
  const r = await ctx.analytics.syncInsights(ctx.accounts.findById(acc.id)!, 2);
  assert.ok(r.stored.reach >= 1);
  assert.equal(r.stored.profile_links_taps, undefined);
  const unsupported = JSON.parse(ctx.accounts.findById(acc.id)!.unsupported_metrics);
  assert.deepEqual(unsupported.sort(), ['new_followers', 'profile_links_taps']);
  const before = fake.state.calls.length;
  await ctx.analytics.syncInsights(ctx.accounts.findById(acc.id)!, 1);
  assert.ok(fake.state.calls.length - before <= 2, 'unsupported metrics are not retried every run');
});

test('safety: invalid token → needs_reauth, jobs cancelled, no retries', async () => {
  const { ctx, fake } = testCtx();
  const { orgId, userId } = seedOrg(ctx);
  const acc = await connectAccount(ctx, orgId, userId);
  fake.inject(/./, 400, { error: { message: 'Error validating access token', code: 190, error_subcode: 463 } }, 1);
  const worker = new Worker(ctx);
  await drain(ctx, worker);
  const a = ctx.accounts.findById(acc.id)!;
  assert.equal(a.status, 'needs_reauth');
  assert.equal(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'`)!.n, 0);
  assert.equal(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM safety_events WHERE code = 'token_invalid'`)!.n, 1);
  // Scheduler does not enqueue for accounts needing re-auth
  ctx.db.run('UPDATE schedules SET next_run_at = 0');
  assert.equal(new Scheduler(ctx).tick(), 0);
});

test('safety: rate limit pauses the account and defers jobs until access returns, then auto-resumes', async () => {
  const { ctx, fake, clock } = testCtx();
  const { orgId, userId } = seedOrg(ctx);
  const acc = await connectAccount(ctx, orgId, userId);
  fake.inject(/./, 400, { error: { message: 'Application request limit reached', code: 4 } }, 1, {
    'x-business-use-case-usage': JSON.stringify({ x: [{ call_count: 100, estimated_time_to_regain_access: 30 }] }),
  });
  const worker = new Worker(ctx);
  await drain(ctx, worker);
  let a = ctx.accounts.findById(acc.id)!;
  assert.equal(a.status, 'paused');
  assert.ok(a.paused_until! >= clock.now + 30 * MINUTE - 1);
  assert.equal(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'`)!.n, 4, 'nothing lost, all deferred');
  clock.now = a.paused_until! + 1;
  await drain(ctx, worker);
  a = ctx.accounts.findById(acc.id)!;
  assert.equal(a.status, 'active');
  assert.equal(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'succeeded'`)!.n, 4);
});

test('safety: high usage header throttles proactively; transient errors trip circuit breaker', async () => {
  const { ctx, fake } = testCtx();
  const { orgId, userId } = seedOrg(ctx);
  const acc = await connectAccount(ctx, orgId, userId);
  fake.state.usageHeader = JSON.stringify({ call_count: 95, total_cputime: 10, total_time: 10 });
  await ctx.analytics.syncProfile(ctx.accounts.findById(acc.id)!);
  assert.equal(ctx.accounts.findById(acc.id)!.status, 'paused');
  assert.ok(ctx.db.get(`SELECT 1 FROM safety_events WHERE code = 'usage_throttle'`));

  fake.state.usageHeader = null;
  ctx.safety.resume(ctx.accounts.findById(acc.id)!, userId);
  ctx.db.run(`UPDATE jobs SET status = 'cancelled'`);
  fake.inject(/./, 500, { error: { message: 'An unexpected error has occurred', code: 2, is_transient: true } }, 10);
  const worker = new Worker(ctx);
  for (let i = 0; i < 5; i++) {
    ctx.queue.enqueue({ type: 'sync_profile', orgId, accountId: acc.id, maxAttempts: 1 });
    await drain(ctx, worker, 1);
  }
  const a = ctx.accounts.findById(acc.id)!;
  assert.equal(a.status, 'paused');
  assert.match(a.pause_reason!, /מפסק זרם/);
});

test('safety: permission error drops the job and records the missing permission', async () => {
  const { ctx, fake } = testCtx();
  const { orgId, userId } = seedOrg(ctx);
  const acc = await connectAccount(ctx, orgId, userId);
  ctx.db.run(`UPDATE jobs SET status = 'cancelled'`);
  fake.inject(/media/, 403, { error: { message: '(#10) Application does not have permission for this action', code: 10 } }, 1);
  ctx.queue.enqueue({ type: 'sync_media', orgId, accountId: acc.id });
  await drain(ctx, new Worker(ctx));
  const j = ctx.db.get<{ status: string; attempts: number }>(`SELECT status, attempts FROM jobs WHERE type = 'sync_media' AND status != 'cancelled'`)!;
  assert.equal(j.status, 'failed');
  assert.equal(j.attempts, 1);
  assert.equal(ctx.accounts.findById(acc.id)!.status, 'active', 'permission issues do not pause the whole account');
  assert.ok(ctx.db.get(`SELECT 1 FROM safety_events WHERE code = 'permission_missing'`));
});

test('token refresh: only when due, stores new expiry', async () => {
  const { ctx, clock } = testCtx();
  const { orgId, userId } = seedOrg(ctx);
  const acc = await connectAccount(ctx, orgId, userId);
  let r = await ctx.accounts.refreshTokenIfNeeded(ctx.accounts.findById(acc.id)!);
  assert.equal(r.refreshed, false, 'fresh 60-day token is not refreshed');
  clock.now += 45 * 24 * HOUR;
  r = await ctx.accounts.refreshTokenIfNeeded(ctx.accounts.findById(acc.id)!);
  assert.equal(r.refreshed, true);
  assert.equal(ctx.accounts.token(ctx.accounts.findById(acc.id)!), 'refreshed-token-xxxxxxxxxxxxxxx');
});
