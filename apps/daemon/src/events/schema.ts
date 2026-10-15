/** SQLite schema: the append-only event log plus projections derived from it (spec §5.4). */
export const SCHEMA_VERSION = 1;

export const eventsTable = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`;

export const projectionTables = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  prompt TEXT NOT NULL,
  budget REAL NOT NULL,
  cost_total REAL NOT NULL DEFAULT 0,
  adapter TEXT NOT NULL,
  profile TEXT NOT NULL,
  allow_commands TEXT NOT NULL,
  setup_commands TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  work_item TEXT,
  pr_url TEXT,
  verify TEXT NOT NULL DEFAULT '[]',
  protected_paths TEXT NOT NULL DEFAULT '[]',
  flow TEXT,
  autonomy_level INTEGER,
  routing TEXT,
  work_item_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  profile TEXT NOT NULL,
  adapter TEXT NOT NULL,
  model TEXT,
  model_id TEXT,
  routing TEXT,
  sandbox_id TEXT,
  sandbox_path TEXT,
  branch TEXT,
  resume_token TEXT,
  cost REAL NOT NULL DEFAULT 0,
  summary TEXT,
  error TEXT,
  not_before TEXT,
  rate_limit_waits INTEGER NOT NULL DEFAULT 0,
  instruction_interrupts INTEGER NOT NULL DEFAULT 0,
  last_activity TEXT,
  iteration INTEGER NOT NULL DEFAULT 1,
  stage TEXT,
  uses TEXT,
  inputs TEXT,
  outputs TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_run ON tasks(run_id);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  decision_reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_task ON approvals(task_id);
CREATE TABLE IF NOT EXISTS skipped_nodes (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (run_id, node_id)
);
CREATE TABLE IF NOT EXISTS run_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  text TEXT NOT NULL,
  delivery TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_task_id TEXT,
  delivered_attempt INTEGER,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS run_messages_run ON run_messages(run_id, created_at);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  paired_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  push INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  added_at TEXT NOT NULL,
  removed_at TEXT,
  sync_cursor TEXT,
  synced_at TEXT
);
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  labels TEXT NOT NULL,
  author TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  triage TEXT,
  triage_model TEXT,
  triage_version INTEGER,
  triage_failures INTEGER NOT NULL DEFAULT 0,
  triaged_at TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_items_project ON work_items(project_id);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export const dropProjections = `
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS skipped_nodes;
DROP TABLE IF EXISTS run_messages;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS work_items;
`;

/**
 * Device credentials (ADR 0020): refresh-token hashes and push subscriptions. They are not
 * projections, so no event carries them and rebuilding projections leaves them alone.
 */
export const credentialTables = `
CREATE TABLE IF NOT EXISTS device_credentials (
  device_id TEXT PRIMARY KEY,
  refresh_hash TEXT NOT NULL UNIQUE,
  refresh_expires_at TEXT NOT NULL,
  rotated_at TEXT,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS device_refresh_used (
  hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  used_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  device_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  created_at TEXT NOT NULL
);
`;
