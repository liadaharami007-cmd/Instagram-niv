import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, HOUR } from '../src/lib/time.ts';
import { parseInstagramExport } from '../src/services/relationship-import.ts';
import { connectAccount, followersJson, followingJson, makeZip, seedOrg, testCtx } from './helpers.ts';

// 2026-03-10T10:00Z = 12:00 in Israel — inside default active hours (09–22).
async function setup() {
  const t = testCtx();
  const { orgId, userId } = seedOrg(t.ctx);
  const acc = await connectAccount(t.ctx, orgId, userId);
  t.ctx.db.run(`UPDATE jobs SET status = 'cancelled'`);
  return { ...t, orgId, userId, acc, fresh: () => t.ctx.accounts.findById(acc.id)! };
}

test('follow workflow: plan within daily limit, pacing gate, confirmation updates relationship', async () => {
  const { ctx, clock, orgId, userId, fresh } = await setup();
  ctx.accounts.updateSettings(fresh(), { daily_follow_limit: 3, min_action_gap_sec: 60 }, userId);
  const r = ctx.targets.add(fresh(), userId, '@one\ntwo,fitness\nhttps://instagram.com/three/\nfour\nbad user!', { followWanted: true });
  assert.equal(r.added, 4);
  assert.equal(r.invalid.length, 1);

  const plan = ctx.tasks.plan(fresh());
  assert.equal(plan.planned.follow, 3, 'never more than the daily limit');
  assert.equal(ctx.tasks.plan(fresh()).planned.follow ?? 0, 0, 'planning is idempotent');

  const { task: t0, gate } = ctx.tasks.next(fresh(), 'follow');
  const task = t0!;
  assert.ok(gate.allowed);
  assert.equal(task.link, `https://www.instagram.com/${task.username}/`);
  ctx.tasks.complete(orgId, task.id, 'done', userId);
  const t = ctx.db.get<{ i_follow: number; followed_at: number }>('SELECT i_follow, followed_at FROM targets WHERE id = ?', task.target_id)!;
  assert.equal(t.i_follow, 1);
  assert.equal(t.followed_at, clock.now);

  // Minimum gap between actions is enforced on confirmation
  const next = ctx.tasks.next(fresh(), 'follow');
  assert.equal(next.gate.allowed, false);
  assert.throws(() => ctx.tasks.complete(orgId, next.task!.id, 'done', userId), /המתנה בין פעולות/);
  // Skips are always allowed and do not touch the relationship
  ctx.tasks.complete(orgId, next.task!.id, 'skipped', userId);
  assert.throws(() => ctx.tasks.complete(orgId, next.task!.id, 'done', userId), /כבר טופלה/);

  clock.now += 61_000;
  const third = ctx.tasks.next(fresh(), 'follow');
  ctx.tasks.complete(orgId, third.task!.id, 'done', userId);
  clock.now += 61_000;
  assert.equal(ctx.tasks.next(fresh(), 'follow').task, null, 'daily list exhausted');
  const gate2 = ctx.safety.manualGate(fresh(), ctx.accounts.settings(fresh().id), 'follow');
  assert.equal(gate2.doneToday, 2);

  // Next day: old pending expire, new plan includes the remaining target only (skipped retried after 3 days)
  clock.now += DAY;
  const p2 = ctx.tasks.plan(fresh());
  assert.equal(p2.planned.follow, 1);
});

test('unfollow workflow requires real follower data; rules respect whitelist and follow-back', async () => {
  const { ctx, clock, orgId, userId, fresh } = await setup();
  ctx.accounts.updateSettings(fresh(), { unfollow_after_days: 7 }, userId);
  assert.equal(ctx.tasks.plan(fresh()).skipped.unfollow, 'needs_relationship_import');

  const old = Math.floor((clock.now - 30 * DAY) / 1000);
  const recent = Math.floor((clock.now - 2 * DAY) / 1000);
  const zip = makeZip({
    'followers_1.json': followersJson([['mutual.friend', old], ['fan.only', old]]),
    'following.json': followingJson([['mutual.friend', old], ['no.followback', old], ['vip.brand', old], ['new.follow', recent]]),
  });
  const res = ctx.relationships.apply(fresh(), userId, parseInstagramExport(zip, 'x.zip'));
  assert.equal(res.followers, 2);
  assert.equal(res.following, 4);
  assert.equal(res.nonFollowers, 3);
  assert.equal(res.lostFollowers, null, 'no comparison on first import');

  const vip = ctx.db.get<{ id: string }>(`SELECT id FROM targets WHERE username = 'vip.brand'`)!;
  ctx.targets.update(orgId, [vip.id], { whitelisted: true }, userId);

  const plan = ctx.tasks.plan(fresh());
  assert.equal(plan.planned.unfollow, 1);
  const tasks = ctx.tasks.list(fresh(), { type: 'unfollow' });
  assert.deepEqual(tasks.map((t: any) => t.username), ['no.followback'], 'not mutual, not whitelisted, not followed recently');

  ctx.tasks.complete(orgId, tasks[0].id, 'done', userId);
  const t = ctx.db.get<{ i_follow: number; unfollowed_at: number }>(`SELECT i_follow, unfollowed_at FROM targets WHERE username = 'no.followback'`)!;
  assert.equal(t.i_follow, 0);
  assert.ok(t.unfollowed_at);

  // Second import detects who stopped following
  clock.now += HOUR;
  const r2 = ctx.relationships.apply(fresh(), userId, parseInstagramExport(Buffer.from(followersJson([['mutual.friend', old], ['brand.new', recent]])), 'followers_1.json'));
  assert.equal(r2.lostFollowers, 1);
  assert.deepEqual(r2.lostUsernames, ['fan.only']);
  assert.equal(r2.newFollowers, 1);

  // Unfollowed accounts are never re-planned for follow
  const nf = ctx.db.get<{ id: string }>(`SELECT id FROM targets WHERE username = 'no.followback'`)!;
  ctx.targets.update(orgId, [nf.id], { follow_wanted: true }, userId);
  clock.now += DAY;
  ctx.tasks.plan(fresh());
  assert.equal(ctx.tasks.list(fresh(), { type: 'follow' }).filter((x: any) => x.username === 'no.followback').length, 0);
});

test('story-like workflow: interval between likes per account, no_story outcome', async () => {
  const { ctx, clock, orgId, userId, fresh } = await setup();
  ctx.accounts.updateSettings(fresh(), { story_like_interval_days: 2, min_action_gap_sec: 10 }, userId);
  ctx.targets.add(fresh(), userId, 'story.a\nstory.b', { engageStories: true });
  ctx.tasks.plan(fresh());
  let list = ctx.tasks.list(fresh(), { type: 'story_like' });
  assert.equal(list.length, 2);
  assert.equal(list[0].link, `https://www.instagram.com/stories/${list[0].username}/`);
  ctx.tasks.complete(orgId, list[0].id, 'done', userId);
  ctx.tasks.complete(orgId, list[1].id, 'no_story', userId);

  clock.now += DAY;
  ctx.tasks.plan(fresh());
  list = ctx.tasks.list(fresh(), { type: 'story_like' });
  assert.equal(list.length, 0, 'liked one waits 2 days; no_story one waits the 3-day retry window');
  clock.now += 3 * DAY;
  ctx.tasks.plan(fresh());
  assert.equal(ctx.tasks.list(fresh(), { type: 'story_like' }).length, 2);
});

test('safety gates for manual work: active hours, hourly cap, action-block cooldown, pause', async () => {
  const { ctx, clock, orgId, userId, fresh } = await setup();
  const s = () => ctx.accounts.settings(fresh().id);
  ctx.accounts.updateSettings(fresh(), { hourly_action_limit: 2, min_action_gap_sec: 10 }, userId);
  ctx.targets.add(fresh(), userId, 'a1\na2\na3', { followWanted: true });
  ctx.tasks.plan(fresh());
  for (let i = 0; i < 2; i++) {
    const n = ctx.tasks.next(fresh(), 'follow');
    ctx.tasks.complete(orgId, n.task!.id, 'done', userId);
    clock.now += 15_000;
  }
  const g = ctx.safety.manualGate(fresh(), s(), 'follow');
  assert.equal(g.allowed, false);
  assert.match(g.reason!, /שעתית/);

  // Forced confirmation (the action already happened in Instagram) is recorded with a warning
  const n = ctx.tasks.next(fresh(), 'follow');
  ctx.tasks.complete(orgId, n.task!.id, 'done', userId, undefined, true);
  assert.ok(ctx.db.get(`SELECT 1 FROM safety_events WHERE code = 'limit_override'`));

  // Outside active hours (23:30 Israel)
  clock.now = Date.parse('2026-03-10T21:30:00Z');
  const night = ctx.safety.manualGate(fresh(), s(), 'unfollow');
  assert.equal(night.allowed, false);
  assert.equal(new Date(night.nextAllowedAt!).toISOString(), '2026-03-11T07:00:00.000Z');

  // Action block reported → everything frozen, pending cancelled, planning skipped
  clock.now = Date.parse('2026-03-11T10:00:00Z');
  ctx.targets.add(fresh(), userId, 'b1', { followWanted: true });
  ctx.tasks.plan(fresh());
  ctx.safety.reportActionBlock(fresh(), s(), userId, 'Try again later');
  assert.equal(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM manual_tasks WHERE status = 'pending'`)!.n, 0);
  assert.equal(ctx.safety.manualGate(fresh(), s(), 'story_like').allowed, false);
  assert.equal(ctx.tasks.plan(fresh()).skipped.follow, 'cooldown');
  clock.now += 49 * HOUR;
  assert.equal(ctx.safety.manualGate(fresh(), s(), 'follow').allowed, true);

  // Manual pause blocks manual work too
  ctx.safety.pause(fresh(), null, 'test', userId);
  assert.equal(ctx.safety.manualGate(fresh(), s(), 'follow').allowed, false);
});

test('settings validation enforces hard safety ceilings', async () => {
  const { ctx, userId, fresh } = await setup();
  assert.throws(() => ctx.accounts.updateSettings(fresh(), { daily_follow_limit: 500 }, userId), /בין 0 ל-100/);
  assert.throws(() => ctx.accounts.updateSettings(fresh(), { min_action_gap_sec: 1 }, userId));
  assert.throws(() => ctx.accounts.updateSettings(fresh(), { timezone: 'Mars/Base' }, userId));
  assert.throws(() => ctx.accounts.updateSettings(fresh(), { hack: 1 }, userId));
  assert.throws(() => ctx.accounts.updateSettings(fresh(), { active_hour_start: 20, active_hour_end: 8 }, userId));
  assert.equal(ctx.accounts.updateSettings(fresh(), { daily_follow_limit: 40, timezone: 'Europe/London' }, userId).daily_follow_limit, 40);
});
