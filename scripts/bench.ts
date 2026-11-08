/**
 * Performance check: real HTTP server + SQLite with a 90-day demo account,
 * concurrent requests against the heaviest dashboard endpoints.
 * Run: node scripts/bench.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createContext } from '../src/context.ts';
import { buildApp } from '../src/app.ts';

const tmp = mkdtempSync(join(tmpdir(), 'nivbot-bench-'));
const ctx = createContext(loadConfig({ DATABASE_PATH: join(tmp, 'bench.db'), LOG_LEVEL: 'silent', NODE_ENV: 'test' }));
const app = await buildApp(ctx);
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as any).port}`;

const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'niv-bot' }, body: JSON.stringify({ email: 'b@b.io', password: 'bench-password-1', name: 'B', orgName: 'B' }) });
const cookie = reg.headers.get('set-cookie')!.split(';')[0];
const demo = await (await fetch(`${base}/api/demo`, { method: 'POST', headers: { cookie, 'x-requested-with': 'niv-bot' } })).json();

async function bench(name: string, path: string, seconds = 3, concurrency = 20) {
  const lat: number[] = [];
  const end = Date.now() + seconds * 1000;
  let errors = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (Date.now() < end) {
      const t = performance.now();
      const r = await fetch(base + path, { headers: { cookie } });
      await r.arrayBuffer();
      if (!r.ok) errors++;
      lat.push(performance.now() - t);
    }
  }));
  lat.sort((a, b) => a - b);
  const p = (q: number) => lat[Math.floor(lat.length * q)].toFixed(1);
  console.log(`${name.padEnd(34)} ${String(Math.round(lat.length / seconds)).padStart(6)} req/s   p50 ${p(0.5)}ms   p95 ${p(0.95)}ms   errors ${errors}`);
}

console.log('endpoint                               throughput   latency (20 concurrent clients)');
await bench('accounts list (overview)', '/api/accounts');
await bench('growth analytics (90 days)', `/api/accounts/${demo.id}/analytics?days=90`);
await bench('capabilities status', `/api/accounts/${demo.id}/capabilities`);
await bench('targets (filtered page)', `/api/accounts/${demo.id}/targets?filter=following`);
await bench('likes engine status', `/api/accounts/${demo.id}/engine/likes`);
await app.close();
ctx.db.close();
rmSync(tmp, { recursive: true, force: true });
