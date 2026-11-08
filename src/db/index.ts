import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations } from './migrations.ts';

export type Row = Record<string, any>;
export type Param = SQLInputValue;

/**
 * Thin, typed wrapper around node:sqlite. Keeps prepared statements cached and
 * exposes an explicit transaction helper. All tenant scoping happens in services.
 */
export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  private txDepth = 0;
  /** Runs fn atomically. Nested calls use savepoints. */
  tx<T>(fn: () => T): T {
    const sp = `sp_${this.txDepth}`;
    this.raw.exec(this.txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const out = fn();
      this.txDepth--;
      this.raw.exec(this.txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (err) {
      this.txDepth--;
      this.raw.exec(this.txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  migrate(): number {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    const applied = new Set(this.all<{ id: number }>('SELECT id FROM schema_migrations').map((r) => r.id));
    let count = 0;
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      this.tx(() => {
        this.raw.exec(m.sql);
        this.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, Date.now());
      });
      count++;
    }
    return count;
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

export function openDb(path: string): Db {
  const db = new Db(path);
  db.migrate();
  return db;
}
