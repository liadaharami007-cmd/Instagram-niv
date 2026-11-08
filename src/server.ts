import { loadConfig } from './config.ts';
import { createContext } from './context.ts';
import { buildApp } from './app.ts';
import { Scheduler, Worker } from './queue/worker.ts';
import type { Runtime } from './http/routes/system.ts';

const config = loadConfig();
const ctx = createContext(config);
const runtime: Runtime = { startedAt: Date.now() };

// APP_ROLE: "all" (default) = HTTP + automation engine; "web" = HTTP only; "worker" = engine only.
ctx.accounts.ensureAllSchedules();
if (config.role !== 'web') {
  runtime.worker = new Worker(ctx);
  runtime.scheduler = new Scheduler(ctx);
  runtime.worker.start();
  runtime.scheduler.start();
  ctx.log.info({ workerId: runtime.worker.id, concurrency: config.worker.concurrency }, 'automation engine started');
}

const app = config.role !== 'worker' ? await buildApp(ctx, runtime) : null;
if (app) {
  await app.listen({ port: config.port, host: config.host });
  const missing = [!ctx.oauth.isConfigured('instagram_login') && 'Instagram Login', !ctx.oauth.isConfigured('facebook_login') && 'Facebook Login'].filter(Boolean);
  if (missing.length) ctx.log.warn(`Meta OAuth not configured for: ${missing.join(', ')} — token connect still available. See README.`);
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  ctx.log.info({ signal }, 'shutting down');
  runtime.scheduler?.stop();
  await app?.close();
  await runtime.worker?.stop();
  ctx.db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => ctx.log.error({ err }, 'unhandled rejection'));
