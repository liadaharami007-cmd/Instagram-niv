import pino, { type Logger } from 'pino';
import type { Config } from './config.ts';
import { openDb, type Db } from './db/index.ts';
import { GraphClient, type FetchLike } from './meta/graph-client.ts';
import { MetaOAuth } from './meta/oauth.ts';
import { SafetyService } from './services/safety.ts';
import { AccountsService } from './services/accounts.ts';
import { AnalyticsService } from './services/analytics.ts';
import { TargetsService } from './services/targets.ts';
import { ManualTasksService } from './services/manual-tasks.ts';
import { RelationshipImportService } from './services/relationship-import.ts';
import { AuditService } from './services/audit.ts';
import { JobQueue } from './queue/queue.ts';
import { DemoService } from './services/demo.ts';
import { PublishingService } from './services/publishing.ts';
import { AutoReplyService } from './services/auto-replies.ts';
import { EngagementService } from './services/engagement.ts';

/** Composition root: every service receives the same shared context. */
export interface Ctx {
  config: Config;
  db: Db;
  log: Logger;
  now: () => number;
  graph: GraphClient;
  oauth: MetaOAuth;
  queue: JobQueue;
  audit: AuditService;
  safety: SafetyService;
  accounts: AccountsService;
  analytics: AnalyticsService;
  targets: TargetsService;
  tasks: ManualTasksService;
  relationships: RelationshipImportService;
  demo: DemoService;
  publishing: PublishingService;
  autoReplies: AutoReplyService;
  engagement: EngagementService;
}

export function createContext(config: Config, opts: { fetchImpl?: FetchLike; now?: () => number; db?: Db } = {}): Ctx {
  const db = opts.db ?? openDb(config.databasePath);
  const log = pino({ level: config.logLevel, base: { app: 'niv-bot' }, redact: ['*.access_token', '*.token', 'token'] });
  const ctx = { config, db, log, now: opts.now ?? Date.now } as Ctx;
  ctx.graph = new GraphClient(config, db, opts.fetchImpl);
  ctx.oauth = new MetaOAuth(config, ctx.graph, opts.fetchImpl, ctx.now);
  ctx.queue = new JobQueue(ctx);
  ctx.audit = new AuditService(ctx);
  ctx.safety = new SafetyService(ctx);
  ctx.accounts = new AccountsService(ctx);
  ctx.analytics = new AnalyticsService(ctx);
  ctx.targets = new TargetsService(ctx);
  ctx.tasks = new ManualTasksService(ctx);
  ctx.relationships = new RelationshipImportService(ctx);
  ctx.demo = new DemoService(ctx);
  ctx.publishing = new PublishingService(ctx);
  ctx.autoReplies = new AutoReplyService(ctx);
  ctx.engagement = new EngagementService(ctx);
  ctx.graph.onUsage = (accountId, usage) => ctx.safety.onUsage(accountId, usage);
  return ctx;
}
