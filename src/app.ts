import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import type { Ctx } from './context.ts';
import { AppError } from './lib/errors.ts';
import { registerAuth } from './http/auth.ts';
import { accountRoutes } from './http/routes/accounts.ts';
import { growthRoutes } from './http/routes/growth.ts';
import { systemRoutes, type Runtime } from './http/routes/system.ts';

export async function buildApp(ctx: Ctx, runtime: Runtime = { startedAt: Date.now() }): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: ctx.config.env === 'test',
  });

  // JSON parser that tolerates an empty body (e.g. DELETE/POST without payload).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(String(body)));
    } catch {
      done(Object.assign(new Error('גוף הבקשה אינו JSON תקין'), { statusCode: 400 }), undefined);
    }
  });
  // Binary uploads (Instagram export ZIP / JSON) arrive as raw bodies.
  app.addContentTypeParser(['application/zip', 'application/octet-stream', 'application/x-zip-compressed'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  // Meta callbacks post application/x-www-form-urlencoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'content-security-policy',
      "default-src 'self'; img-src 'self' data: https://*.cdninstagram.com https://*.fbcdn.net; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (ctx.config.env === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err.validation) return reply.code(400).send({ error: 'bad_request', message: 'קלט לא תקין', details: err.validation });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code ?? 'bad_request', message: err.message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'שגיאת שרת. הפעולה לא בוצעה.' });
  });

  registerAuth(app, ctx);
  accountRoutes(app, ctx);
  growthRoutes(app, ctx);
  systemRoutes(app, ctx, runtime);

  await app.register(fastifyStatic, { root: resolve(import.meta.dirname, '..', 'public'), index: 'index.html', maxAge: ctx.config.env === 'production' ? '1h' : 0 });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'נתיב לא קיים' });
    return reply.sendFile('index.html');
  });
  return app;
}
