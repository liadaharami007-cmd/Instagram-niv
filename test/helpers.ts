import { deflateRawSync } from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createContext, type Ctx } from '../src/context.ts';
import { openDb } from '../src/db/index.ts';
import { createFakeGraph } from './fake-graph.ts';

export function testCtx(opts: { now?: number; meta?: boolean } = {}) {
  const clock = { now: opts.now ?? Date.parse('2026-03-10T10:00:00Z') };
  const fake = createFakeGraph();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    UPLOADS_DIR: mkdtempSync(join(tmpdir(), 'nivbot-up-')),
    PUBLIC_BASE_URL: 'https://bot.example.com',
    META_WEBHOOK_VERIFY_TOKEN: 'verify-me',
    ...(opts.meta === false ? {} : { INSTAGRAM_APP_ID: 'ig-app', INSTAGRAM_APP_SECRET: 'ig-secret', FACEBOOK_APP_ID: 'fb-app', FACEBOOK_APP_SECRET: 'fb-secret' }),
  });
  const ctx: Ctx = createContext(config, { fetchImpl: fake.fetch, now: () => clock.now, db: openDb(':memory:') });
  return { ctx, fake, clock };
}

/** Creates an org + user directly (bypassing HTTP) for service-level tests. */
export function seedOrg(ctx: Ctx, suffix = '1') {
  const now = ctx.now();
  const orgId = `org_${suffix}`;
  const userId = `usr_${suffix}`;
  ctx.db.run('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)', orgId, `Org ${suffix}`, now);
  ctx.db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)', userId, `u${suffix}@x.io`, 'User', 'x', now);
  ctx.db.run(`INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?,?, 'owner', ?)`, orgId, userId, now);
  return { orgId, userId };
}

export async function connectAccount(ctx: Ctx, orgId: string, userId: string) {
  const [a] = await ctx.accounts.connectWithToken(orgId, userId, 'instagram_login', 'test-token-xxxxxxxxxxxxxxxxxxxx');
  return a;
}

/** Builds a real ZIP archive (deflate) — used to test the Instagram export importer. */
export function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export const followersJson = (users: [string, number][]) =>
  JSON.stringify(users.map(([u, ts]) => ({ title: '', media_list_data: [], string_list_data: [{ href: `https://www.instagram.com/${u}`, value: u, timestamp: ts }] })));

/** Newer export format: username in "title", href with /_u/ prefix, no "value". */
export const followingJson = (users: [string, number][]) =>
  JSON.stringify({ relationships_following: users.map(([u, ts]) => ({ title: u, string_list_data: [{ href: `https://www.instagram.com/_u/${u}`, timestamp: ts }] })) });

/** Runs every due job synchronously through the real worker pipeline. */
export async function drain(ctx: Ctx, worker: { execute: (j: any) => Promise<void> }, max = 50) {
  let n = 0;
  for (; n < max; n++) {
    const job = ctx.queue.claim('test', 60_000);
    if (!job) break;
    await worker.execute(job);
  }
  return n;
}
