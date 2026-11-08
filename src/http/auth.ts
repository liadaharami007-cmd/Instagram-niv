import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.ts';
import { hashPassword, newId, randomToken, sha256, verifyPassword } from '../lib/crypto.ts';
import { AppError, badRequest, forbidden } from '../lib/errors.ts';
import { DAY, MINUTE } from '../lib/time.ts';

export interface AuthInfo {
  userId: string;
  orgId: string;
  role: 'owner' | 'admin' | 'member';
  name: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthInfo;
  }
}

const COOKIE = 'nb_sid';
const PUBLIC_API = new Set(['/api/auth/register', '/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/system/health']);
const SESSION_TTL = 30 * DAY;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Simple fixed-window limiter for credential endpoints (per IP + identifier). */
class AttemptLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  check(key: string, now: number) {
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
      return;
    }
    if (++h.n > this.max) throw new AppError(429, 'too_many_attempts', 'יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.');
  }
}

export const str = (body: any, key: string, min = 1, max = 200): string => {
  const v = body?.[key];
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw badRequest(`השדה ${key} חסר או לא תקין`);
  return v.trim();
};

export function requireRole(req: FastifyRequest, roles: AuthInfo['role'][]) {
  if (!req.auth || !roles.includes(req.auth.role)) throw forbidden();
}

export function registerAuth(app: FastifyInstance, ctx: Ctx) {
  const limiter = new AttemptLimiter(10, 15 * MINUTE);
  const secure = ctx.config.env === 'production';

  const createSession = (reply: FastifyReply, req: FastifyRequest, userId: string, orgId: string) => {
    const token = randomToken();
    const now = ctx.now();
    ctx.db.run(
      'INSERT INTO sessions (id_hash, user_id, org_id, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)',
      sha256(token), userId, orgId, now, now + SESSION_TTL, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 200),
    );
    reply.header('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure ? '; Secure' : ''}`);
  };

  // Resolve the session on every request; enforce auth + CSRF header on the JSON API.
  app.addHook('onRequest', async (req) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const row = ctx.db.get<AuthInfo & { expires_at: number }>(
        `SELECT s.user_id AS userId, s.org_id AS orgId, s.expires_at, m.role, u.name, u.email
           FROM sessions s JOIN users u ON u.id = s.user_id JOIN memberships m ON m.user_id = s.user_id AND m.org_id = s.org_id
          WHERE s.id_hash = ?`,
        sha256(token),
      );
      if (row && row.expires_at > ctx.now()) {
        const { expires_at: _e, ...auth } = row;
        req.auth = auth;
      }
    }
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'niv-bot') throw forbidden('בקשה חסרה כותרת אבטחה');
    const isPublic = PUBLIC_API.has(url) || /^\/api\/oauth\/[a-z_]+\/callback$/.test(url);
    if (!isPublic && !req.auth) throw new AppError(401, 'unauthorized', 'יש להתחבר מחדש');
  });

  app.post('/api/auth/register', async (req, reply) => {
    const body = req.body as any;
    const users = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
    if (!ctx.config.allowRegistration && users > 0) throw forbidden('ההרשמה סגורה. פנה למנהל המערכת.');
    limiter.check(`reg:${req.ip}`, ctx.now());
    const email = str(body, 'email', 3, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('כתובת אימייל לא תקינה');
    const password = str(body, 'password', 10, 200);
    const name = str(body, 'name', 1, 80);
    const orgName = str(body, 'orgName', 1, 80);
    if (ctx.db.get('SELECT 1 FROM users WHERE email = ?', email)) throw badRequest('האימייל כבר רשום');
    const hash = await hashPassword(password);
    const userId = newId('usr');
    const orgId = newId('org');
    const now = ctx.now();
    ctx.db.tx(() => {
      ctx.db.run('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)', orgId, orgName, now);
      ctx.db.run('INSERT INTO users (id, email, name, password_hash, created_at, last_login_at) VALUES (?,?,?,?,?,?)', userId, email, name, hash, now, now);
      ctx.db.run(`INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?,?, 'owner', ?)`, orgId, userId, now);
    });
    ctx.audit.record(orgId, 'org.created', { userId });
    createSession(reply, req, userId, orgId);
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = req.body as any;
    const email = str(body, 'email', 3, 200).toLowerCase();
    limiter.check(`login:${req.ip}:${email}`, ctx.now());
    const password = str(body, 'password', 1, 200);
    const user = ctx.db.get<{ id: string; password_hash: string }>('SELECT id, password_hash FROM users WHERE email = ?', email);
    // Always run a hash comparison to keep timing uniform for unknown emails.
    const ok = await verifyPassword(password, user?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86));
    if (!user || !ok) throw new AppError(401, 'invalid_credentials', 'אימייל או סיסמה שגויים');
    const m = ctx.db.get<{ org_id: string }>('SELECT org_id FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1', user.id);
    if (!m) throw forbidden('המשתמש אינו משויך לארגון');
    ctx.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', ctx.now(), user.id);
    createSession(reply, req, user.id, m.org_id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) ctx.db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(token));
    reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.auth) return { user: null, registrationOpen: ctx.config.allowRegistration || ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n === 0 };
    const org = ctx.db.get('SELECT id, name, plan FROM organizations WHERE id = ?', req.auth.orgId);
    return { user: { id: req.auth.userId, name: req.auth.name, email: req.auth.email, role: req.auth.role }, org };
  });

  app.get('/api/org/members', async (req) => {
    return ctx.db.all(
      `SELECT u.id, u.name, u.email, m.role, u.last_login_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created_at`,
      req.auth!.orgId,
    );
  });

  app.post('/api/org/members', async (req) => {
    requireRole(req, ['owner', 'admin']);
    const body = req.body as any;
    const email = str(body, 'email', 3, 200).toLowerCase();
    const role = body?.role === 'admin' ? 'admin' : 'member';
    if (ctx.db.get('SELECT 1 FROM users WHERE email = ?', email)) throw badRequest('האימייל כבר רשום במערכת');
    const hash = await hashPassword(str(body, 'password', 10, 200));
    const id = newId('usr');
    const now = ctx.now();
    ctx.db.tx(() => {
      ctx.db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)', id, email, str(body, 'name', 1, 80), hash, now);
      ctx.db.run('INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)', req.auth!.orgId, id, role, now);
    });
    ctx.audit.record(req.auth!.orgId, 'org.member_added', { userId: req.auth!.userId, details: { email, role } });
    return { id };
  });

  app.post('/api/auth/password', async (req) => {
    const body = req.body as any;
    const user = ctx.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', req.auth!.userId)!;
    if (!(await verifyPassword(str(body, 'current', 1, 200), user.password_hash))) throw badRequest('הסיסמה הנוכחית שגויה');
    ctx.db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(str(body, 'next', 10, 200)), req.auth!.userId);
    const keep = sha256(parseCookies(req.headers.cookie)[COOKIE] ?? '');
    ctx.db.run('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?', req.auth!.userId, keep);
    return { ok: true };
  });
}
