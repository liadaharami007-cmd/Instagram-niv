import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Loads KEY=VALUE pairs from .env (if present) without overriding real env vars. */
function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  publicBaseUrl: string;
  databasePath: string;
  /** 32-byte key (base64) used for AES-256-GCM encryption of access tokens. */
  encryptionKey: Buffer;
  role: 'all' | 'web' | 'worker';
  logLevel: string;
  allowRegistration: boolean;
  meta: {
    graphVersion: string;
    /** Instagram API with Instagram Login (graph.instagram.com) */
    igAppId: string;
    igAppSecret: string;
    /** Instagram API with Facebook Login (graph.facebook.com) */
    fbAppId: string;
    fbAppSecret: string;
    /** Overridable only for automated tests (points to a local fake Graph server). */
    instagramGraphBase: string;
    facebookGraphBase: string;
    instagramOAuthBase: string;
    instagramApiBase: string;
    facebookOAuthBase: string;
  };
  worker: { concurrency: number; pollMs: number; leaseMs: number };
}

export function loadConfig(overrides: Partial<Record<string, string>> = {}): Config {
  loadDotEnv();
  const e = { ...process.env, ...overrides } as Record<string, string | undefined>;
  const env = (e.NODE_ENV === 'production' || e.NODE_ENV === 'test' ? e.NODE_ENV : 'development') as Config['env'];

  let encryptionKey: Buffer;
  if (e.APP_ENCRYPTION_KEY) {
    encryptionKey = Buffer.from(e.APP_ENCRYPTION_KEY, 'base64');
    if (encryptionKey.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded (npm run keygen)');
  } else if (env === 'production') {
    throw new Error('APP_ENCRYPTION_KEY is required in production (generate one with: npm run keygen)');
  } else {
    // Deterministic development-only key. Never used in production (guarded above).
    encryptionKey = Buffer.alloc(32, 7);
  }

  const port = Number(e.PORT ?? 3000);
  const graphVersion = e.META_GRAPH_VERSION ?? 'v23.0';
  if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error('META_GRAPH_VERSION must look like v23.0');

  return {
    env,
    port,
    host: e.HOST ?? '0.0.0.0',
    publicBaseUrl: (e.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    databasePath: e.DATABASE_PATH ?? resolve(process.cwd(), 'data', 'niv-bot.db'),
    encryptionKey,
    role: (['web', 'worker'].includes(e.APP_ROLE ?? '') ? e.APP_ROLE : 'all') as Config['role'],
    logLevel: e.LOG_LEVEL ?? (env === 'test' ? 'silent' : 'info'),
    allowRegistration: (e.ALLOW_REGISTRATION ?? 'true') !== 'false',
    meta: {
      graphVersion,
      igAppId: e.INSTAGRAM_APP_ID ?? '',
      igAppSecret: e.INSTAGRAM_APP_SECRET ?? '',
      fbAppId: e.FACEBOOK_APP_ID ?? '',
      fbAppSecret: e.FACEBOOK_APP_SECRET ?? '',
      instagramGraphBase: e.TEST_INSTAGRAM_GRAPH_BASE ?? 'https://graph.instagram.com',
      facebookGraphBase: e.TEST_FACEBOOK_GRAPH_BASE ?? 'https://graph.facebook.com',
      instagramOAuthBase: e.TEST_INSTAGRAM_OAUTH_BASE ?? 'https://www.instagram.com',
      instagramApiBase: e.TEST_INSTAGRAM_API_BASE ?? 'https://api.instagram.com',
      facebookOAuthBase: e.TEST_FACEBOOK_OAUTH_BASE ?? 'https://www.facebook.com',
    },
    worker: {
      concurrency: Math.max(1, Number(e.WORKER_CONCURRENCY ?? 3)),
      pollMs: Math.max(100, Number(e.WORKER_POLL_MS ?? 1000)),
      leaseMs: Math.max(10_000, Number(e.WORKER_LEASE_MS ?? 5 * 60_000)),
    },
  };
}
