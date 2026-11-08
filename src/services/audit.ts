import type { Ctx } from '../context.ts';

export class AuditService {
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  record(orgId: string, action: string, opts: { userId?: string | null; accountId?: string | null; details?: unknown } = {}): void {
    this.ctx.db.run(
      'INSERT INTO audit_log (org_id, user_id, account_id, action, details, created_at) VALUES (?,?,?,?,?,?)',
      orgId,
      opts.userId ?? null,
      opts.accountId ?? null,
      action,
      JSON.stringify(opts.details ?? {}),
      this.ctx.now(),
    );
  }

  list(orgId: string, opts: { accountId?: string; limit?: number; before?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = this.ctx.db.all(
      `SELECT a.id, a.action, a.details, a.created_at, a.account_id, u.name AS user_name, g.username AS account_username
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN ig_accounts g ON g.id = a.account_id
        WHERE a.org_id = ? AND (? IS NULL OR a.account_id = ?) AND (? IS NULL OR a.id < ?)
        ORDER BY a.id DESC LIMIT ?`,
      orgId,
      opts.accountId ?? null,
      opts.accountId ?? null,
      opts.before ?? null,
      opts.before ?? null,
      limit,
    );
    return rows.map((r) => ({ ...r, details: JSON.parse(r.details) }));
  }
}
