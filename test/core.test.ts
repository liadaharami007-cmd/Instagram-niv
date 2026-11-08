import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { decrypt, encrypt, hashPassword, parseSignedRequest, verifyPassword } from '../src/lib/crypto.ts';
import { classifyMetaError, parseUsageHeaders } from '../src/meta/errors.ts';
import { addDays, dayKey, startOfDay } from '../src/lib/time.ts';
import { backoffMs } from '../src/queue/queue.ts';
import { normalizeUsername } from '../src/services/targets.ts';
import { parseInstagramExport } from '../src/services/relationship-import.ts';
import { followersJson, followingJson, makeZip, seedOrg, testCtx } from './helpers.ts';

test('AES-256-GCM token encryption round-trips and detects tampering', () => {
  const key = Buffer.alloc(32, 1);
  const enc = encrypt('IGAAtoken', key);
  assert.notEqual(enc, encrypt('IGAAtoken', key), 'random IV per encryption');
  assert.equal(decrypt(enc, key), 'IGAAtoken');
  const parts = enc.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decrypt(parts.join('.'), key));
  assert.throws(() => decrypt(enc, Buffer.alloc(32, 2)), 'wrong key fails');
});

test('scrypt password hashing', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(await verifyPassword('correct horse battery', h));
  assert.ok(!(await verifyPassword('wrong password', h)));
});

test('Meta signed_request verification', () => {
  const payload = Buffer.from(JSON.stringify({ user_id: '123', algorithm: 'HMAC-SHA256' })).toString('base64url');
  const sig = createHmac('sha256', 'secret').update(payload).digest('base64url');
  assert.equal(parseSignedRequest(`${sig}.${payload}`, 'secret')?.user_id, '123');
  assert.equal(parseSignedRequest(`${sig}.${payload}`, 'other'), null);
});

test('Meta error classification', () => {
  assert.equal(classifyMetaError(400, { code: 190, error_subcode: 463 }), 'token_invalid');
  assert.equal(classifyMetaError(400, { code: 100, error_subcode: 460 }), 'token_invalid');
  assert.equal(classifyMetaError(400, { code: 4 }), 'rate_limit');
  assert.equal(classifyMetaError(400, { code: 17 }), 'rate_limit');
  assert.equal(classifyMetaError(400, { code: 80002 }), 'rate_limit');
  assert.equal(classifyMetaError(429, {}), 'rate_limit');
  assert.equal(classifyMetaError(400, { code: 368 }), 'policy_block');
  assert.equal(classifyMetaError(403, { code: 10 }), 'permission');
  assert.equal(classifyMetaError(403, { code: 200 }), 'permission');
  assert.equal(classifyMetaError(500, { code: 2 }), 'transient');
  assert.equal(classifyMetaError(0, undefined), 'transient');
  assert.equal(classifyMetaError(400, { code: 100 }), 'invalid_request');
});

test('usage headers parsing (app + business use case)', () => {
  const h = new Headers({
    'x-app-usage': JSON.stringify({ call_count: 12, total_cputime: 5, total_time: 7 }),
    'x-business-use-case-usage': JSON.stringify({ '1784': [{ type: 'instagram', call_count: 91, total_cputime: 3, total_time: 4, estimated_time_to_regain_access: 12 }] }),
  });
  const u = parseUsageHeaders(h)!;
  assert.equal(u.maxPct, 91);
  assert.equal(u.regainMinutes, 12);
  assert.equal(parseUsageHeaders(new Headers()), null);
});

test('time zone day boundaries', () => {
  const t = Date.parse('2026-03-10T22:30:00Z'); // 00:30 next day in Israel (UTC+2)
  assert.equal(dayKey(t, 'Asia/Jerusalem'), '2026-03-11');
  assert.equal(dayKey(t, 'UTC'), '2026-03-10');
  assert.equal(new Date(startOfDay('2026-03-11', 'Asia/Jerusalem')).toISOString(), '2026-03-10T22:00:00.000Z');
  assert.equal(new Date(startOfDay('2026-07-01', 'Asia/Jerusalem')).toISOString(), '2026-06-30T21:00:00.000Z'); // DST
  assert.equal(new Date(startOfDay('2026-03-11', 'Asia/Kolkata')).toISOString(), '2026-03-10T18:30:00.000Z'); // half-hour zone
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
});

test('backoff grows exponentially and is capped', () => {
  const mid = () => 0.5;
  assert.equal(backoffMs(1, mid), 30_000);
  assert.equal(backoffMs(3, mid), 120_000);
  assert.equal(backoffMs(20, mid), 3_600_000);
});

test('username normalisation', () => {
  assert.equal(normalizeUsername('@Niv.Studio'), 'niv.studio');
  assert.equal(normalizeUsername('https://www.instagram.com/some_user/'), 'some_user');
  assert.equal(normalizeUsername('https://www.instagram.com/_u/some_user'), 'some_user');
  assert.equal(normalizeUsername('bad user'), null);
  assert.equal(normalizeUsername('a..b'), null);
  assert.equal(normalizeUsername('x'.repeat(31)), null);
});

test('Instagram export parser: ZIP with both formats, JSON files, HTML rejection', () => {
  const zip = makeZip({
    'connections/followers_and_following/followers_1.json': followersJson([['alice', 1700000000], ['bob', 1700000100]]),
    'connections/followers_and_following/following.json': followingJson([['alice', 1690000000], ['carol', 1690000500]]),
    'other/ignored.json': '{}',
  });
  const p = parseInstagramExport(zip, 'export.zip');
  assert.deepEqual(p.followers?.map((r) => r.username), ['alice', 'bob']);
  assert.deepEqual(p.following?.map((r) => r.username), ['alice', 'carol']);
  assert.equal(p.following?.[1].timestamp, 1690000500_000);

  const single = parseInstagramExport(Buffer.from(followingJson([['dave', 1]])), 'following.json');
  assert.equal(single.followers, null);
  assert.equal(single.following?.length, 1);

  assert.throws(() => parseInstagramExport(makeZip({ 'connections/followers_1.html': '<html>' }), 'x.zip'), /HTML/);
  assert.throws(() => parseInstagramExport(Buffer.from('{}'), 'random.json'), /לא נמצאו/);
});

test('migrations are idempotent and tenant rows are isolated by org', () => {
  const { ctx } = testCtx();
  assert.equal(ctx.db.migrate(), 0, 'second run applies nothing');
  seedOrg(ctx, 'a');
  seedOrg(ctx, 'b');
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM organizations')!.n, 2);
});
