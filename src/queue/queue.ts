import type { Ctx } from '../context.ts';
import type { Row } from '../db/index.ts';
import { HOUR } from '../lib/time.ts';

export interface Job {
  id: number;
  org_id: string | null;
  account_id: string | null;
  type: string;
  payload: Record<string, any>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempts: number;
  max_attempts: number;
  run_at: number;
  last_error: string | null;
}

export interface EnqueueOptions {
  type: string;
  orgId?: string | null;
  accountId?: string | null;
  payload?: Record<string, unknown>;
  runAt?: number;
  priority?: number;
  maxAttempts?: number;
  /** While a job with this key is queued/running, identical enqueues are ignored. */
  dedupeKey?: string;
}

/** Exponential backoff with ±20% jitter: 30s, 60s, 120s ... capped at 1h. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(attempt - 1, 0), HOUR);
  return Math.round(base * (0.8 + random() * 0.4));
}

const toJob = (r: Row): Job => ({ ...r, payload: JSON.parse(r.payload) }) as Job;

/**
 * Durable job queue on top of the application database.
 * - Leases (locked_until) make crashed workers' jobs recoverable.
 * - At most one running job per Instagram account (serialises API usage per account).
 * - Partial unique index provides idempotent enqueue via dedupe keys.
 */
export class JobQueue {
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  enqueue(o: EnqueueOptions): number | null {
    const now = this.ctx.now();
    try {
      const r = this.ctx.db.run(
        `INSERT INTO jobs (org_id, account_id, type, payload, status, priority, max_attempts, run_at, dedupe_key, created_at, updated_at)
         VALUES (?,?,?,?, 'queued', ?,?,?,?,?,?)`,
        o.orgId ?? null,
        o.accountId ?? null,
        o.type,
        JSON.stringify(o.payload ?? {}),
        o.priority ?? 100,
        o.maxAttempts ?? 5,
        o.runAt ?? now,
        o.dedupeKey ?? null,
        now,
        now,
      );
      return r.lastInsertRowid;
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) return null;
      throw err;
    }
  }

  claim(workerId: string, leaseMs: number): Job | undefined {
    const now = this.ctx.now();
    return this.ctx.db.tx(() => {
      const row = this.ctx.db.get(
        `SELECT * FROM jobs j
          WHERE j.status = 'queued' AND j.run_at <= ?
            AND (j.account_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM jobs r WHERE r.status = 'running' AND r.account_id = j.account_id))
          ORDER BY j.priority ASC, j.run_at ASC, j.id ASC
          LIMIT 1`,
        now,
      );
      if (!row) return undefined;
      this.ctx.db.run(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = ?, locked_until = ?, updated_at = ? WHERE id = ?`,
        workerId,
        now + leaseMs,
        now,
        row.id,
      );
      return toJob({ ...row, status: 'running', attempts: row.attempts + 1 });
    });
  }

  complete(id: number, result?: unknown): void {
    const now = this.ctx.now();
    this.ctx.db.run(
      `UPDATE jobs SET status = 'succeeded', result = ?, last_error = NULL, locked_by = NULL, locked_until = NULL, updated_at = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
      result === undefined ? null : JSON.stringify(result),
      now,
      now,
      id,
    );
  }

  /** Records a failure. Retries with backoff unless permanent or attempts are exhausted. */
  fail(id: number, error: string, opts: { permanent?: boolean; retryAt?: number } = {}): 'retry' | 'failed' {
    const now = this.ctx.now();
    const job = this.ctx.db.get<{ attempts: number; max_attempts: number }>('SELECT attempts, max_attempts FROM jobs WHERE id = ?', id);
    if (!job) return 'failed';
    if (!opts.permanent && job.attempts < job.max_attempts) {
      this.ctx.db.run(
        `UPDATE jobs SET status = 'queued', last_error = ?, run_at = ?, locked_by = NULL, locked_until = NULL, updated_at = ? WHERE id = ?`,
        error.slice(0, 2000),
        opts.retryAt ?? now + backoffMs(job.attempts),
        now,
        id,
      );
      return 'retry';
    }
    this.ctx.db.run(
      `UPDATE jobs SET status = 'failed', last_error = ?, locked_by = NULL, locked_until = NULL, updated_at = ?, finished_at = ? WHERE id = ?`,
      error.slice(0, 2000),
      now,
      now,
      id,
    );
    return 'failed';
  }

  /** Re-queues without consuming an attempt (used when the account is throttled/paused). */
  defer(id: number, runAt: number, reason: string): void {
    this.ctx.db.run(
      `UPDATE jobs SET status = 'queued', attempts = MAX(attempts - 1, 0), run_at = ?, last_error = ?, locked_by = NULL, locked_until = NULL, updated_at = ? WHERE id = ?`,
      runAt,
      reason,
      this.ctx.now(),
      id,
    );
  }

  cancel(id: number, orgId?: string): boolean {
    const r = this.ctx.db.run(
      `UPDATE jobs SET status = 'cancelled', updated_at = ?, finished_at = ? WHERE id = ? AND status = 'queued' AND (? IS NULL OR org_id = ?)`,
      this.ctx.now(),
      this.ctx.now(),
      id,
      orgId ?? null,
      orgId ?? null,
    );
    return r.changes > 0;
  }

  cancelForAccount(accountId: string, reason: string): number {
    const now = this.ctx.now();
    return this.ctx.db.run(
      `UPDATE jobs SET status = 'cancelled', last_error = ?, updated_at = ?, finished_at = ? WHERE account_id = ? AND status = 'queued'`,
      reason,
      now,
      now,
      accountId,
    ).changes;
  }

  /** Moves queued jobs of an account to a later time (account paused/throttled). */
  deferAccount(accountId: string, runAt: number): number {
    return this.ctx.db.run(`UPDATE jobs SET run_at = MAX(run_at, ?), updated_at = ? WHERE account_id = ? AND status = 'queued'`, runAt, this.ctx.now(), accountId).changes;
  }

  /** Jobs whose worker died mid-run (lease expired) go back to the queue or fail. */
  recoverExpired(): number {
    const now = this.ctx.now();
    const expired = this.ctx.db.all<{ id: number }>(`SELECT id FROM jobs WHERE status = 'running' AND locked_until < ?`, now);
    for (const j of expired) this.fail(j.id, 'Worker lease expired (process restarted or timed out)');
    return expired.length;
  }

  retry(id: number, orgId: string): boolean {
    const now = this.ctx.now();
    return (
      this.ctx.db.run(
        `UPDATE jobs SET status = 'queued', attempts = 0, run_at = ?, updated_at = ?, finished_at = NULL WHERE id = ? AND org_id = ? AND status IN ('failed','cancelled')`,
        now,
        now,
        id,
        orgId,
      ).changes > 0
    );
  }

  list(orgId: string, accountId: string, limit = 50): Job[] {
    return this.ctx.db
      .all('SELECT * FROM jobs WHERE org_id = ? AND account_id = ? ORDER BY id DESC LIMIT ?', orgId, accountId, limit)
      .map(toJob);
  }

  stats() {
    const rows = this.ctx.db.all<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued','running') OR finished_at > ? GROUP BY status`,
      this.ctx.now() - 24 * HOUR,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  purgeFinished(olderThanMs: number): number {
    return this.ctx.db.run(`DELETE FROM jobs WHERE status IN ('succeeded','failed','cancelled') AND finished_at < ?`, this.ctx.now() - olderThanMs).changes;
  }
}
