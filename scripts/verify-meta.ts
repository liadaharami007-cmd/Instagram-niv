/**
 * Live verification against the REAL Meta Graph API (no fakes).
 *
 *   node scripts/verify-meta.ts
 *     → contract checks that need no credentials (hosts, version, error format, classification).
 *
 *   META_TEST_IG_TOKEN=... node scripts/verify-meta.ts         (Instagram-Login token)
 *   META_TEST_FB_TOKEN=... node scripts/verify-meta.ts         (Facebook-Login user token)
 *     → connects the account into a throw-away in-memory DB and runs every read-only automation
 *       through the real worker. Optional write test: META_TEST_LIKE_MEDIA_ID=<public post id>.
 */
import { loadConfig } from '../src/config.ts';
import { createContext } from '../src/context.ts';
import { openDb } from '../src/db/index.ts';
import { MetaApiError } from '../src/meta/errors.ts';
import { Worker } from '../src/queue/worker.ts';

const config = loadConfig({ DATABASE_PATH: ':memory:', LOG_LEVEL: 'silent', NODE_ENV: 'test', INSTAGRAM_APP_ID: process.env.INSTAGRAM_APP_ID ?? 'verify', INSTAGRAM_APP_SECRET: process.env.INSTAGRAM_APP_SECRET ?? 'verify' });
const ctx = createContext(config, { db: openDb(':memory:') });
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${check} — ${detail}`);
};

async function expectError(check: string, fn: () => Promise<unknown>, kind: string) {
  try {
    await fn();
    record(check, false, 'expected an error, got success');
  } catch (e) {
    if (e instanceof MetaApiError) record(check, e.kind === kind, `HTTP ${e.httpStatus}, code ${e.code}, kind=${e.kind}: ${e.message}`);
    else record(check, false, `unexpected error: ${(e as Error).message}`);
  }
}

console.log(`Graph API version: ${config.meta.graphVersion}\n── Contract checks (no credentials) ──`);
await expectError('graph.instagram.com reachable, invalid token → token_invalid', () => ctx.graph.request({ provider: 'instagram_login', token: 'invalid-token-for-verification', path: 'me', params: { fields: 'user_id' } }), 'token_invalid');
await expectError('graph.facebook.com reachable, invalid token → token_invalid', () => ctx.graph.request({ provider: 'facebook_login', token: 'invalid-token-for-verification', path: 'me' }), 'token_invalid');
await expectError('Likes endpoint (POST /{ig-user-id}/likes) answers in Graph error format', () => ctx.graph.request({ provider: 'facebook_login', token: 'invalid-token-for-verification', method: 'POST', path: '17841400000000000/likes', params: { media_id: '1' } }), 'token_invalid');
try {
  await ctx.oauth.exchangeCode('instagram_login', 'invalid-code');
  record('Instagram OAuth code exchange error parsed', false, 'unexpected success');
} catch (e) {
  record('Instagram OAuth code exchange error parsed (api.instagram.com)', e instanceof MetaApiError && e.kind !== 'transient', e instanceof MetaApiError ? `kind=${e.kind}: ${e.message}` : String(e));
}

async function liveAccount(provider: 'instagram_login' | 'facebook_login', token: string) {
  console.log(`\n── Live account checks (${provider}) ──`);
  const orgId = 'org_verify';
  ctx.db.run(`INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, 'verify', ?)`, orgId, Date.now());
  ctx.db.run(`INSERT OR IGNORE INTO users (id, email, name, password_hash, created_at) VALUES ('usr_verify', 'v@v', 'v', 'x', ?)`, Date.now());
  let account;
  try {
    [account] = await ctx.accounts.connectWithToken(orgId, 'usr_verify', provider, token);
    record('connect account with token', true, `@${account.username} (ig_user_id ${account.ig_user_id})`);
  } catch (e) {
    record('connect account with token', false, (e as Error).message);
    return;
  }
  if (provider === 'facebook_login') {
    ctx.queue.enqueue({ type: 'sync_competitors', orgId, accountId: account.id });
    ctx.db.run(`INSERT INTO competitors (account_id, username, created_at) VALUES (?, ?, ?)`, account.id, process.env.META_TEST_BD_USERNAME ?? 'instagram', Date.now());
  }
  const worker = new Worker(ctx);
  for (let i = 0; i < 20; i++) {
    const job = ctx.queue.claim('verify', 120_000);
    if (!job) break;
    await worker.execute(job);
  }
  for (const j of ctx.db.all<{ type: string; status: string; last_error: string | null; result: string | null }>('SELECT type, status, last_error, result FROM jobs WHERE account_id = ?', account.id)) {
    record(`job ${j.type}`, j.status === 'succeeded', j.status === 'succeeded' ? (j.result ?? '').slice(0, 160) : `${j.status}: ${j.last_error}`);
  }
  const a = ctx.accounts.findById(account.id)!;
  record('followers_count stored from real API', typeof a.followers_count === 'number', `followers=${a.followers_count}`);
  const metrics = ctx.db.all<{ metric: string }>('SELECT DISTINCT metric FROM daily_metrics WHERE account_id = ?', a.id).map((r) => r.metric);
  record('insights metrics stored', metrics.length > 1, metrics.join(', ') || 'none');
  if (JSON.parse(a.unsupported_metrics).length) record('metrics Meta reported as unsupported (info)', true, a.unsupported_metrics);
  const likeMedia = process.env.META_TEST_LIKE_MEDIA_ID;
  if (provider === 'facebook_login' && likeMedia) {
    const r = ctx.db.run(`INSERT INTO engagement_actions (org_id, account_id, target_username, media_id, action, status, run_at, created_at) VALUES (?,?, 'verify', ?, 'like', 'queued', ?, ?)`, orgId, a.id, likeMedia, Date.now(), Date.now());
    try {
      const out = await ctx.engagement.like(a, r.lastInsertRowid);
      record('Likes API: real like on META_TEST_LIKE_MEDIA_ID', out.status === 'done', JSON.stringify(out));
    } catch (e) {
      record('Likes API: real like on META_TEST_LIKE_MEDIA_ID', false, (e as Error).message);
    }
  }
}

if (process.env.META_TEST_IG_TOKEN) await liveAccount('instagram_login', process.env.META_TEST_IG_TOKEN);
if (process.env.META_TEST_FB_TOKEN) await liveAccount('facebook_login', process.env.META_TEST_FB_TOKEN);
if (!process.env.META_TEST_IG_TOKEN && !process.env.META_TEST_FB_TOKEN) console.log('\n(no META_TEST_IG_TOKEN / META_TEST_FB_TOKEN set — live account checks skipped)');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
