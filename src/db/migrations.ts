/**
 * Ordered, append-only schema migrations. Never edit a shipped migration — add a new one.
 * Every tenant-owned row carries org_id so queries can always be scoped to one organization.
 */
export const migrations: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'standard',
  created_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE ig_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('instagram_login','facebook_login')),
  ig_user_id TEXT NOT NULL,
  app_scoped_user_id TEXT,
  username TEXT NOT NULL,
  name TEXT,
  account_type TEXT,
  profile_picture_url TEXT,
  fb_page_id TEXT,
  access_token_enc TEXT NOT NULL,
  token_expires_at INTEGER,
  token_refreshed_at INTEGER,
  granted_scopes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','needs_reauth','restricted','disconnected')),
  paused_until INTEGER,
  pause_reason TEXT,
  manual_cooldown_until INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  unsupported_metrics TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  followers_count INTEGER,
  follows_count INTEGER,
  media_count INTEGER,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (org_id, ig_user_id)
);

CREATE TABLE account_settings (
  account_id TEXT PRIMARY KEY REFERENCES ig_accounts(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
  daily_follow_limit INTEGER NOT NULL DEFAULT 25,
  daily_unfollow_limit INTEGER NOT NULL DEFAULT 25,
  daily_story_like_limit INTEGER NOT NULL DEFAULT 40,
  hourly_action_limit INTEGER NOT NULL DEFAULT 15,
  min_action_gap_sec INTEGER NOT NULL DEFAULT 40,
  unfollow_after_days INTEGER NOT NULL DEFAULT 7,
  unfollow_only_non_followers INTEGER NOT NULL DEFAULT 1,
  story_like_interval_days INTEGER NOT NULL DEFAULT 2,
  active_hour_start INTEGER NOT NULL DEFAULT 9,
  active_hour_end INTEGER NOT NULL DEFAULT 22,
  block_cooldown_hours INTEGER NOT NULL DEFAULT 48
);

CREATE TABLE follower_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  taken_at INTEGER NOT NULL,
  followers_count INTEGER NOT NULL,
  follows_count INTEGER,
  media_count INTEGER
);
CREATE INDEX follower_snapshots_account ON follower_snapshots(account_id, taken_at);

CREATE TABLE daily_metrics (
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, day, metric)
);

CREATE TABLE media (
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  media_type TEXT,
  media_product_type TEXT,
  caption TEXT,
  permalink TEXT,
  thumbnail_url TEXT,
  posted_at INTEGER,
  like_count INTEGER,
  comments_count INTEGER,
  insights TEXT NOT NULL DEFAULT '{}',
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX media_account_time ON media(account_id, posted_at);

CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  segment TEXT NOT NULL DEFAULT 'general',
  source TEXT NOT NULL,
  notes TEXT,
  i_follow INTEGER NOT NULL DEFAULT 0,
  follows_me INTEGER NOT NULL DEFAULT 0,
  followed_at INTEGER,
  follows_me_since INTEGER,
  unfollowed_at INTEGER,
  whitelisted INTEGER NOT NULL DEFAULT 0,
  follow_wanted INTEGER NOT NULL DEFAULT 0,
  engage_stories INTEGER NOT NULL DEFAULT 0,
  last_story_like_at INTEGER,
  followers_count INTEGER,
  follows_count INTEGER,
  media_count INTEGER,
  display_name TEXT,
  biography TEXT,
  enrich_status TEXT,
  enriched_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (account_id, username)
);
CREATE INDEX targets_account_flags ON targets(account_id, i_follow, follows_me);

CREATE TABLE manual_tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('follow','unfollow','story_like')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped','failed','no_story','not_found','expired','cancelled')),
  reason TEXT NOT NULL,
  planned_day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  completed_by TEXT,
  note TEXT,
  UNIQUE (account_id, type, target_id, planned_day)
);
CREATE INDEX manual_tasks_queue ON manual_tasks(account_id, type, status, planned_day);
CREATE INDEX manual_tasks_completed ON manual_tasks(account_id, completed_at);

CREATE TABLE relationship_imports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  imported_at INTEGER NOT NULL,
  imported_by TEXT,
  followers_total INTEGER,
  following_total INTEGER,
  new_followers INTEGER,
  lost_followers INTEGER,
  lost_usernames TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE competitors (
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_error TEXT,
  PRIMARY KEY (account_id, username)
);

CREATE TABLE competitor_snapshots (
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  day TEXT NOT NULL,
  followers_count INTEGER,
  media_count INTEGER,
  taken_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, username, day)
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT,
  account_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  priority INTEGER NOT NULL DEFAULT 100,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_at INTEGER NOT NULL,
  locked_by TEXT,
  locked_until INTEGER,
  last_error TEXT,
  result TEXT,
  dedupe_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX jobs_claim ON jobs(status, run_at, priority);
CREATE INDEX jobs_account ON jobs(account_id, created_at);
CREATE UNIQUE INDEX jobs_dedupe_active ON jobs(dedupe_key) WHERE status IN ('queued','running') AND dedupe_key IS NOT NULL;

CREATE TABLE schedules (
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  interval_sec INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NOT NULL,
  last_enqueued_at INTEGER,
  PRIMARY KEY (account_id, job_type)
);

CREATE TABLE safety_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  account_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('info','warning','critical')),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX safety_events_account ON safety_events(account_id, created_at);

CREATE TABLE api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER,
  error_code INTEGER,
  error_kind TEXT,
  duration_ms INTEGER NOT NULL,
  usage_pct REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX api_calls_account ON api_calls(account_id, created_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  user_id TEXT,
  account_id TEXT,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_log_org ON audit_log(org_id, created_at);
CREATE INDEX audit_log_account ON audit_log(account_id, created_at);
`,
  },
  {
    id: 2,
    name: 'demo_accounts',
    sql: `ALTER TABLE ig_accounts ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    id: 3,
    name: 'publishing_and_auto_replies',
    sql: `
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE scheduled_posts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK (media_type IN ('IMAGE','REELS','STORIES')),
  media_url TEXT NOT NULL,
  upload_id TEXT,
  caption TEXT,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled','publishing','published','failed','cancelled')),
  container_id TEXT,
  ig_media_id TEXT,
  permalink TEXT,
  error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX scheduled_posts_account ON scheduled_posts(account_id, scheduled_at);

CREATE TABLE reply_rules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('comment','dm')),
  match_type TEXT NOT NULL CHECK (match_type IN ('any','keywords')),
  keywords TEXT NOT NULL DEFAULT '[]',
  public_replies TEXT NOT NULL DEFAULT '[]',
  dm_text TEXT,
  media_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  hits INTEGER NOT NULL DEFAULT 0,
  enabled_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX reply_rules_account ON reply_rules(account_id, channel, enabled);

CREATE TABLE auto_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  rule_id TEXT,
  channel TEXT NOT NULL,
  source_id TEXT NOT NULL,
  from_id TEXT,
  from_username TEXT,
  incoming_text TEXT,
  action TEXT NOT NULL CHECK (action IN ('public_reply','private_reply','dm_reply')),
  reply_text TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, source_id, action)
);
CREATE INDEX auto_replies_account ON auto_replies(account_id, created_at);

ALTER TABLE account_settings ADD COLUMN auto_reply_hourly_limit INTEGER NOT NULL DEFAULT 30;
ALTER TABLE ig_accounts ADD COLUMN comments_polled_at INTEGER;
ALTER TABLE ig_accounts ADD COLUMN webhook_subscribed_at INTEGER;
ALTER TABLE ig_accounts ADD COLUMN last_webhook_at INTEGER;
`,
  },
  {
    id: 4,
    name: 'official_like_engine',
    sql: `
ALTER TABLE ig_accounts ADD COLUMN user_token_enc TEXT;
ALTER TABLE ig_accounts ADD COLUMN user_token_expires_at INTEGER;
ALTER TABLE account_settings ADD COLUMN daily_like_limit INTEGER NOT NULL DEFAULT 40;
ALTER TABLE account_settings ADD COLUMN likes_per_hour INTEGER NOT NULL DEFAULT 10;
ALTER TABLE account_settings ADD COLUMN like_media_max_age_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE targets ADD COLUMN auto_like INTEGER NOT NULL DEFAULT 0;
ALTER TABLE targets ADD COLUMN last_auto_like_check_at INTEGER;

CREATE TABLE engagement_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  target_username TEXT NOT NULL,
  media_id TEXT NOT NULL,
  media_type TEXT,
  permalink TEXT,
  action TEXT NOT NULL CHECK (action IN ('like')),
  status TEXT NOT NULL CHECK (status IN ('queued','done','failed','cancelled')),
  error TEXT,
  run_at INTEGER NOT NULL,
  executed_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, media_id, action)
);
CREATE INDEX engagement_actions_account ON engagement_actions(account_id, created_at);
CREATE INDEX engagement_actions_done ON engagement_actions(account_id, status, executed_at);
`,
  },
  {
    id: 5,
    name: 'autopilot',
    sql: `
ALTER TABLE reply_rules ADD COLUMN system_key TEXT;
CREATE UNIQUE INDEX reply_rules_system_key ON reply_rules(account_id, system_key) WHERE system_key IS NOT NULL;
`,
  },
];
