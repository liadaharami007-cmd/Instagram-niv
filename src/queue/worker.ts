import { existsSync, readdirSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Ctx } from '../context.ts';
import { MetaApiError } from '../meta/errors.ts';
import { API_JOB_TYPES, type AccountRow } from '../services/accounts.ts';
import { DAY } from '../lib/time.ts';
import { RetryLater, type Job } from './queue.ts';

export type Handler = (job: Job, account: AccountRow | undefined, ctx: Ctx) => Promise<unknown>;

/** Job handlers. Each one does real work against Meta or the local database. */
export const handlers: Record<string, Handler> = {
  sync_profile: (_j, a, ctx) => ctx.analytics.syncProfile(a!),
  sync_insights: (j, a, ctx) => ctx.analytics.syncInsights(a!, Number(j.payload.days ?? 3)),
  sync_media: (_j, a, ctx) => ctx.analytics.syncMedia(a!),
  sync_stories: (_j, a, ctx) => ctx.analytics.syncStories(a!),
  sync_competitors: (_j, a, ctx) => ctx.analytics.syncCompetitors(a!),
  enrich_targets: (_j, a, ctx) => ctx.analytics.enrichTargets(a!),
  refresh_token: (_j, a, ctx) => ctx.accounts.refreshTokenIfNeeded(a!),
  plan_manual_tasks: async (_j, a, ctx) => ctx.tasks.plan(a!),
  publish_post: (j, a, ctx) => ctx.publishing.publish(a!, String(j.payload.postId)),
  poll_comments: (_j, a, ctx) => ctx.autoReplies.pollComments(a!),
  process_comment: (j, a, ctx) => ctx.autoReplies.handleComment(a!, j.payload.comment),
  process_dm: (j, a, ctx) => ctx.autoReplies.handleMessage(a!, j.payload.message),
  subscribe_webhooks: (_j, a, ctx) => ctx.autoReplies.subscribe(a!),
  auto_like_plan: (_j, a, ctx) => ctx.engagement.plan(a!),
  like_media: (j, a, ctx) => ctx.engagement.like(a!, Number(j.payload.actionId)),
};

/** Runs when a job fails for good, so domain records never stay stuck "in progress". */
const onFinalFailure: Record<string, (job: Job, ctx: Ctx, error: string) => void> = {
  publish_post: (job, ctx, error) => ctx.publishing.markFailed(String(job.payload.postId), error),
  like_media: (job, ctx, error) => ctx.engagement.finish(Number(job.payload.actionId), 'failed', error),
};

export const JOB_LABELS: Record<string, string> = {
  sync_profile: 'סנכרון פרופיל ועוקבים',
  sync_insights: 'סנכרון נתוני Insights',
  sync_media: 'סנכרון פוסטים וביצועים',
  sync_stories: 'שמירת סטוריז ונתוניהם',
  sync_competitors: 'מעקב מתחרים',
  enrich_targets: 'העשרת קהל יעד (Business Discovery)',
  refresh_token: 'חידוש טוקן גישה',
  plan_manual_tasks: 'תכנון משימות ידניות יומיות',
  publish_post: 'פרסום פוסט מתוזמן',
  poll_comments: 'בדיקת תגובות חדשות למענה אוטומטי',
  process_comment: 'מענה אוטומטי לתגובה',
  process_dm: 'מענה אוטומטי להודעה',
  subscribe_webhooks: 'הרשמה לעדכונים בזמן אמת (Webhooks)',
  auto_like_plan: 'מנוע לייקים: איתור פוסטים חדשים של קהל היעד',
  like_media: 'לייק לפוסט (API רשמי)',
};

export class Worker {
  private readonly ctx: Ctx;
  readonly id = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  private running = false;
  private inFlight = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  lastTickAt = 0;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const recovered = this.ctx.queue.recoverExpired();
    if (recovered) this.ctx.log.warn({ recovered }, 'recovered jobs with expired leases');
    this.loop();
  }

  private loop = () => {
    if (!this.running) return;
    this.lastTickAt = this.ctx.now();
    try {
      while (this.inFlight.size < this.ctx.config.worker.concurrency) {
        const job = this.ctx.queue.claim(this.id, this.ctx.config.worker.leaseMs);
        if (!job) break;
        const p = this.execute(job).finally(() => this.inFlight.delete(p));
        this.inFlight.add(p);
      }
    } catch (err) {
      this.ctx.log.error({ err }, 'worker loop error');
    }
    this.timer = setTimeout(this.loop, this.ctx.config.worker.pollMs);
  };

  /** Processes a single job end-to-end. Exposed for tests and the "run now" path. */
  async execute(job: Job): Promise<void> {
    const { ctx } = this;
    const log = ctx.log.child({ jobId: job.id, type: job.type, accountId: job.account_id });
    const handler = handlers[job.type];
    if (!handler) {
      ctx.queue.fail(job.id, `Unknown job type ${job.type}`, { permanent: true });
      return;
    }
    const account = job.account_id ? ctx.accounts.findById(job.account_id) : undefined;
    if (job.account_id && !account) {
      ctx.queue.fail(job.id, 'Account no longer exists', { permanent: true });
      return;
    }
    if (account?.is_demo && API_JOB_TYPES.has(job.type)) {
      // Demo accounts have no Meta connection: never call the API for them.
      if (job.type === 'publish_post') ctx.publishing.markFailed(String(job.payload.postId), 'חשבון הדגמה — הפרסום לא נשלח לאינסטגרם');
      ctx.queue.complete(job.id, { skipped: 'demo account' });
      return;
    }
    if (account && API_JOB_TYPES.has(job.type)) {
      const gate = ctx.safety.checkApi(account);
      if (!gate.ok) {
        if (gate.blocked) ctx.queue.fail(job.id, gate.reason ?? 'blocked', { permanent: true });
        else ctx.queue.defer(job.id, gate.retryAt ?? ctx.now() + 60_000, gate.reason ?? 'deferred');
        return;
      }
    }
    const started = Date.now();
    try {
      const result = await handler(job, account ? ctx.accounts.findById(account.id) : undefined, ctx);
      if (account && API_JOB_TYPES.has(job.type)) ctx.safety.apiSucceeded(account.id);
      ctx.queue.complete(job.id, result);
      log.info({ ms: Date.now() - started }, 'job succeeded');
    } catch (err) {
      if (err instanceof RetryLater) {
        ctx.queue.defer(job.id, err.retryAt, err.message);
        return;
      }
      if (err instanceof MetaApiError && account) {
        const decision = ctx.safety.apiFailed(ctx.accounts.findById(account.id)!, err);
        const msg = `${err.userMessage} — ${err.message}${err.code ? ` (code ${err.code}${err.subcode ? `/${err.subcode}` : ''})` : ''}`;
        if (decision.action === 'defer') ctx.queue.defer(job.id, decision.retryAt!, msg);
        else if (ctx.queue.fail(job.id, msg, { permanent: decision.action === 'drop' }) === 'failed') onFinalFailure[job.type]?.(job, ctx, msg);
        log.warn({ kind: err.kind, code: err.code, decision: decision.action }, 'meta api error');
      } else {
        const outcome = ctx.queue.fail(job.id, (err as Error).message ?? String(err));
        if (outcome === 'failed') onFinalFailure[job.type]?.(job, ctx, (err as Error).message ?? String(err));
        log.error({ err, outcome }, 'job failed');
      }
    }
  }

  async stop(timeoutMs = 15_000) {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  get busy() {
    return this.inFlight.size;
  }
}

/** Turns due schedules into queued jobs, and runs periodic housekeeping. */
export class Scheduler {
  private readonly ctx: Ctx;
  private timer?: NodeJS.Timeout;
  private lastHousekeeping = 0;
  lastTickAt = 0;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  start(intervalMs = 15_000) {
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  tick(): number {
    const { ctx } = this;
    const now = ctx.now();
    this.lastTickAt = now;
    let enqueued = 0;
    try {
      const due = ctx.db.all<{ account_id: string; org_id: string; job_type: string; interval_sec: number }>(
        `SELECT s.account_id, s.org_id, s.job_type, s.interval_sec FROM schedules s JOIN ig_accounts a ON a.id = s.account_id
          WHERE s.enabled = 1 AND s.next_run_at <= ? AND a.status NOT IN ('disconnected','needs_reauth')`,
        now,
      );
      for (const s of due) {
        const id = ctx.queue.enqueue({ type: s.job_type, orgId: s.org_id, accountId: s.account_id, dedupeKey: `${s.job_type}:${s.account_id}` });
        if (id) enqueued++;
        // ±5% jitter spreads load across accounts and avoids synchronized bursts toward Meta.
        const next = now + Math.round(s.interval_sec * 1000 * (0.95 + Math.random() * 0.1));
        ctx.db.run('UPDATE schedules SET next_run_at = ?, last_enqueued_at = ? WHERE account_id = ? AND job_type = ?', next, now, s.account_id, s.job_type);
      }
      if (now - this.lastHousekeeping > 6 * 3600_000) {
        this.lastHousekeeping = now;
        const jobs = ctx.queue.purgeFinished(30 * DAY);
        const calls = ctx.db.run('DELETE FROM api_calls WHERE created_at < ?', now - 30 * DAY).changes;
        const sessions = ctx.db.run('DELETE FROM sessions WHERE expires_at < ?', now).changes;
        ctx.db.run('DELETE FROM oauth_states WHERE expires_at < ?', now);
        removeOrphanUploads(ctx);
        ctx.log.info({ jobs, calls, sessions }, 'housekeeping done');
      }
    } catch (err) {
      ctx.log.error({ err }, 'scheduler tick failed');
    }
    return enqueued;
  }
}

/** Deletes uploaded files whose account (and therefore DB row) was removed. */
function removeOrphanUploads(ctx: Ctx) {
  const dir = ctx.config.uploadsDir;
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (!ctx.db.get('SELECT 1 FROM uploads WHERE id = ?', f)) rmSync(join(dir, f), { force: true });
}
