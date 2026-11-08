import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildApp } from '../src/app.ts';
import { Worker } from '../src/queue/worker.ts';
import { normalize, ruleMatches } from '../src/services/auto-replies.ts';
import { connectAccount, drain, seedOrg, testCtx } from './helpers.ts';

const jpeg = (w: number, h: number) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, ...Array(40).fill(0)]);
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64)]);

async function setup() {
  const t = testCtx();
  const { orgId, userId } = seedOrg(t.ctx);
  const acc = await connectAccount(t.ctx, orgId, userId);
  t.ctx.db.run(`UPDATE jobs SET status = 'cancelled'`);
  const worker = new Worker(t.ctx);
  return { ...t, orgId, userId, acc, worker, fresh: () => t.ctx.accounts.findById(acc.id)! };
}

test('keyword matching ignores case, punctuation and niqqud', () => {
  assert.equal(normalize('מְחִיר?!  Price!!'), 'מחיר price');
  const r = { match_type: 'keywords' as const, keywords: JSON.stringify(['מחיר', 'how much']) };
  assert.ok(ruleMatches(r, 'מה המחיר???'));
  assert.ok(ruleMatches(r, 'HOW MUCH is it'));
  assert.ok(!ruleMatches(r, 'יפה מאוד'));
  assert.ok(ruleMatches({ match_type: 'any', keywords: '[]' }, 'anything'));
});

test('publishing: image post is published through container → publish, with permalink', async () => {
  const { ctx, fake, userId, fresh, worker } = await setup();
  const up = ctx.publishing.saveUpload(fresh(), jpeg(1080, 1350), 'photo.jpg');
  assert.equal(up.width, 1080);
  assert.match(up.url, /^https:\/\/bot\.example\.com\/u\/[\w-]{20,}$/);
  const post = ctx.publishing.create(fresh(), userId, { mediaType: 'IMAGE', uploadId: up.id, caption: 'שלום #עולם' });
  await drain(ctx, worker);
  const p = ctx.publishing.get(post.org_id, post.id);
  assert.equal(p.status, 'published', p.error ?? '');
  assert.ok(p.ig_media_id && p.permalink);
  const c = [...fake.state.containers.values()][0];
  assert.equal(c.params.image_url, up.url);
  assert.equal(c.params.caption, 'שלום #עולם');
  // Re-running the job never publishes twice
  ctx.queue.enqueue({ type: 'publish_post', orgId: post.org_id, accountId: post.account_id, payload: { postId: post.id } });
  await drain(ctx, worker);
  assert.equal(fake.state.published.length, 1);
});

test('publishing: reels wait for video processing without burning retries; quota and errors handled', async () => {
  const { ctx, fake, clock, userId, fresh, worker } = await setup();
  const up = ctx.publishing.saveUpload(fresh(), mp4(), 'clip.mp4');
  const post = ctx.publishing.create(fresh(), userId, { mediaType: 'REELS', uploadId: up.id, caption: 'רילס' });
  await drain(ctx, worker);
  assert.equal(ctx.publishing.get(post.org_id, post.id).status, 'publishing');
  const job = ctx.db.get<{ attempts: number; status: string }>(`SELECT attempts, status FROM jobs WHERE dedupe_key = ?`, `publish:${post.id}`)!;
  assert.equal(job.status, 'queued');
  assert.equal(job.attempts, 0, 'processing wait does not consume attempts');
  [...fake.state.containers.values()][0].status = 'FINISHED';
  clock.now += 31_000;
  await drain(ctx, worker);
  assert.equal(ctx.publishing.get(post.org_id, post.id).status, 'published');
  assert.equal([...fake.state.containers.values()][0].params.media_type, 'REELS');

  // Quota full → waits, keeps the post scheduled with an explanation
  fake.state.publishQuota = 100;
  const p2 = ctx.publishing.create(fresh(), userId, { mediaType: 'IMAGE', mediaUrl: 'https://cdn.example.com/a.jpg' });
  await drain(ctx, worker);
  const q = ctx.publishing.get(p2.org_id, p2.id);
  assert.equal(q.status, 'scheduled');
  assert.match(q.error!, /מכסת/);

  // Meta processing error → failed with reason; retry creates a fresh container
  fake.state.publishQuota = 0;
  clock.now += 2 * 3600_000;
  await drain(ctx, worker);
  assert.equal(ctx.publishing.get(p2.org_id, p2.id).status, 'published');
  const p3 = ctx.publishing.create(fresh(), userId, { mediaType: 'IMAGE', mediaUrl: 'https://cdn.example.com/b.jpg' });
  fake.inject(/\/\d+$/, 200, { id: 'x', status_code: 'ERROR', status: 'Error: unsupported' }, 1);
  await drain(ctx, worker);
  assert.equal(ctx.publishing.get(p3.org_id, p3.id).status, 'failed');
  ctx.publishing.retry(p3.org_id, p3.id, userId);
  await drain(ctx, worker);
  assert.equal(ctx.publishing.get(p3.org_id, p3.id).status, 'published');
});

test('publishing: validation, scheduling in the future, cancel', async () => {
  const { ctx, clock, userId, fresh, worker, fake } = await setup();
  assert.throws(() => ctx.publishing.saveUpload(fresh(), Buffer.from('\x89PNG\r\n\x1a\n0000'), 'a.png'), /JPEG/);
  const wide = ctx.publishing.saveUpload(fresh(), jpeg(1080, 400), 'wide.jpg');
  assert.throws(() => ctx.publishing.create(fresh(), userId, { mediaType: 'IMAGE', uploadId: wide.id }), /יחס/);
  assert.throws(() => ctx.publishing.create(fresh(), userId, { mediaType: 'REELS', uploadId: wide.id }), /MP4/);
  assert.throws(() => ctx.publishing.create(fresh(), userId, { mediaType: 'IMAGE', mediaUrl: 'http://x.com/a.jpg' }), /https/);
  assert.throws(() => ctx.publishing.create(fresh(), userId, { mediaType: 'IMAGE', mediaUrl: 'https://x.com/a.jpg', caption: Array(31).fill('#t').join(' ') }), /30/);
  assert.throws(() => ctx.publishing.create(fresh(), userId, { mediaType: 'IMAGE', mediaUrl: 'https://x.com/a.jpg', scheduledAt: clock.now - 3600_000 }), /עבר/);

  const later = ctx.publishing.create(fresh(), userId, { mediaType: 'IMAGE', mediaUrl: 'https://x.com/a.jpg', scheduledAt: clock.now + 3600_000 });
  await drain(ctx, worker);
  assert.equal(ctx.publishing.get(later.org_id, later.id).status, 'scheduled', 'not before its time');
  ctx.publishing.reschedule(later.org_id, later.id, clock.now + 7200_000, userId);
  clock.now += 3700_000;
  await drain(ctx, worker);
  assert.equal(ctx.publishing.get(later.org_id, later.id).status, 'scheduled', 'rescheduled moves the job');
  ctx.publishing.cancel(later.org_id, later.id, userId);
  clock.now += 7200_000;
  await drain(ctx, worker);
  assert.equal(ctx.publishing.get(later.org_id, later.id).status, 'cancelled');
  assert.equal(fake.state.published.length, 0);
});

test('webhooks: verification, signature check, comment rule → public + private reply exactly once', async () => {
  const { ctx, fake, userId, fresh, worker } = await setup();
  const app = await buildApp(ctx);
  const ok = await app.inject({ method: 'GET', url: '/meta/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345' });
  assert.equal(ok.body, '12345');
  assert.equal((await app.inject({ method: 'GET', url: '/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1' })).statusCode, 403);

  ctx.autoReplies.createRule(fresh(), userId, { template: 'price_dm' });
  await drain(ctx, worker);
  assert.equal(fake.state.subscriptions[0], 'comments,messages', 'account subscribed to webhooks on first rule');

  const send = (payload: unknown, secret = 'ig-secret') => {
    const body = JSON.stringify(payload);
    const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    return app.inject({ method: 'POST', url: '/meta/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
  };
  const event = (id: string, text: string, username = 'dana.cohen') => ({
    object: 'instagram',
    entry: [{ id: fake.state.igUserId, time: 1, changes: [{ field: 'comments', value: { id, text, from: { id: `9${id}`, username }, media: { id: '17900000000000001' } } }] }],
  });
  assert.equal((await send(event('501', 'מה המחיר?'), 'wrong-secret')).statusCode, 401);
  assert.equal((await send(event('501', 'מה המחיר?'))).json().queued, 1);
  assert.equal((await send(event('501', 'מה המחיר?'))).json().queued, 0, 'duplicate delivery deduped');
  await send(event('502', 'וואו יפה'));
  await send(event('503', 'מחיר?', 'niv.studio'));
  await drain(ctx, worker);
  assert.equal(fake.state.replies.length, 1, 'only the matching, non-self comment got a reply');
  assert.equal(fake.state.replies[0].commentId, '501');
  assert.match(fake.state.replies[0].message, /פרטים|@dana\.cohen/);
  assert.deepEqual(fake.state.messages[0].recipient, { comment_id: '501' });
  // Redelivery after processing still does not reply twice
  await send(event('501', 'מה המחיר?'));
  await drain(ctx, worker);
  assert.equal(fake.state.replies.length, 1);
  const h = ctx.autoReplies.history(fresh());
  assert.equal(h.sent24h, 2);
});

test('DM rules: welcome once per week per person, echoes ignored, hourly cap', async () => {
  const { ctx, fake, userId, fresh, worker, clock } = await setup();
  const app = await buildApp(ctx);
  ctx.autoReplies.createRule(fresh(), userId, { template: 'dm_welcome' });
  const send = (mid: string, sender: string, text: string, echo = false) => {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: fake.state.igUserId, time: 1, messaging: [{ sender: { id: sender }, recipient: { id: fake.state.igUserId }, timestamp: 1, message: { mid, text, is_echo: echo || undefined } }] }] });
    return app.inject({ method: 'POST', url: '/meta/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'ig-secret').update(body).digest('hex') } });
  };
  await send('m1', '111', 'היי');
  await send('m2', '111', 'יש מישהו?');
  await send('m3', '222', 'echo', true);
  await drain(ctx, worker);
  assert.equal(fake.state.messages.length, 1);
  assert.deepEqual(fake.state.messages[0].recipient, { id: '111' });

  ctx.accounts.updateSettings(fresh(), { auto_reply_hourly_limit: 1 }, userId);
  await send('m4', '333', 'שלום');
  await drain(ctx, worker);
  assert.equal(fake.state.messages.length, 1, 'hourly cap reached');
  assert.ok(ctx.db.get(`SELECT 1 FROM safety_events WHERE code = 'autoreply_limit'`));
  clock.now += 8 * 86400_000;
  await send('m5', '111', 'חזרתי');
  await drain(ctx, worker);
  assert.equal(fake.state.messages.length, 2, 'after a week the person is welcomed again');
});

test('comment polling fallback replies only to comments after the rule was enabled', async () => {
  const { ctx, fake, userId, fresh, worker, clock } = await setup();
  ctx.autoReplies.createRule(fresh(), userId, { template: 'thanks' });
  const iso = (t: number) => new Date(t).toISOString().replace('.000Z', '+0000');
  fake.state.comments.push(
    { mediaId: '17900000000000001', id: '701', text: 'ישן', username: 'old.fan', timestamp: iso(clock.now - 3600_000) },
    { mediaId: '17900000000000001', id: '702', text: 'מהמם!', username: 'new.fan', timestamp: iso(clock.now + 60_000) },
  );
  clock.now += 120_000;
  const r = await ctx.autoReplies.pollComments(fresh());
  assert.equal(r.replied, 1);
  assert.deepEqual(fake.state.replies.map((x) => x.commentId), ['702']);
  assert.ok(!fake.state.replies[0].message.includes('{username}'));
  await ctx.autoReplies.pollComments(fresh());
  assert.equal(fake.state.replies.length, 1);
  void worker;
});

test('demo account: scheduled post is never sent to Meta and says so', async () => {
  const { ctx, fake } = testCtx();
  const { orgId, userId } = seedOrg(ctx);
  const demo = ctx.demo.create(orgId, userId);
  const p = ctx.publishing.create(demo, userId, { mediaType: 'IMAGE', mediaUrl: 'https://x.com/a.jpg' });
  await drain(ctx, new Worker(ctx));
  const row = ctx.publishing.get(orgId, p.id);
  assert.equal(row.status, 'failed');
  assert.match(row.error!, /הדגמה/);
  assert.equal(fake.state.calls.length, 0);
});

test('autopilot: a new account answers "מחיר" with a private message without anyone switching anything on', async () => {
  const t = testCtx();
  const { orgId, userId } = seedOrg(t.ctx);
  const acc = await connectAccount(t.ctx, orgId, userId);
  const st = t.ctx.autopilot.status(acc);
  const by = Object.fromEntries(st.features.map((f: any) => [f.key, f]));
  assert.equal(by.price_reply.on, true);
  assert.equal(by.dm_welcome.on, true);
  assert.ok(!by.price_reply.text.includes('['), 'default message is ready to send (no placeholders)');
  assert.deepEqual(st.notSupported.map((x: any) => x.key), ['follow', 'unfollow', 'story_like']);

  const res = await t.ctx.autoReplies.handleComment(acc, { id: '8001', text: 'כמה עולה?', username: 'client.one', fromId: '77' });
  assert.equal((res as any).private, true);
  assert.equal(t.fake.state.messages[0].message.text, by.price_reply.text);

  // One switch + one text box
  t.ctx.autopilot.set(acc, 'price_reply', { text: 'המחיר 199₪, משלוח חינם 🚚' }, userId);
  await t.ctx.autoReplies.handleComment(acc, { id: '8002', text: 'מחיר?', username: 'client.two', fromId: '78' });
  assert.equal(t.fake.state.messages[1].message.text, 'המחיר 199₪, משלוח חינם 🚚');
  t.ctx.autopilot.set(acc, 'price_reply', { on: false }, userId);
  const r3 = await t.ctx.autoReplies.handleComment(acc, { id: '8003', text: 'מחיר?', username: 'client.three', fromId: '79' });
  assert.equal((r3 as any).skipped, 'no matching rule');
  assert.throws(() => t.ctx.autopilot.set(acc, 'follow', { on: true }, userId), /לא ניתן/);
});
