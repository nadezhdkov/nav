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
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  prompt TEXT NOT NULL,
  budget REAL NOT NULL,
  cost_total REAL NOT NULL DEFAULT 0,
  plan_cost REAL NOT NULL DEFAULT 0,
  adapter TEXT NOT NULL,
  profile TEXT NOT NULL,
  allow_commands TEXT NOT NULL,
  setup_commands TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  work_item TEXT,
  pr_url TEXT,
  verify TEXT NOT NULL DEFAULT '[]',
  protected_paths TEXT NOT NULL DEFAULT '[]',
  isolation TEXT,
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
  plan_cost REAL NOT NULL DEFAULT 0,
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
  team TEXT,
  prefer TEXT,
  compete TEXT,
  parallel TEXT,
  choices TEXT,
  subagents TEXT,
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
  choices TEXT,
  choice TEXT,
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
CREATE TABLE IF NOT EXISTS principles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  text TEXT NOT NULL,
  run_id TEXT,
  added_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE INDEX IF NOT EXISTS principles_project ON principles(project_id, added_at);
CREATE TABLE IF NOT EXISTS principle_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  text TEXT NOT NULL,
  reason TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS principle_proposals_project ON principle_proposals(project_id, status, proposed_at);
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
-- One row per model call or Inbox triage (ADR 0023): the Cost Ledger that budgets and metrics read.
CREATE TABLE IF NOT EXISTS usage (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  model TEXT NOT NULL,
  billing TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  cost REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS usage_run ON usage(run_id);
-- One row per finished agent attempt, with the model it ran on and its share of usage: the
-- observed metrics of spec §6.4.1 (ADR 0023).
CREATE TABLE IF NOT EXISTS attempts (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  adapter TEXT NOT NULL,
  model TEXT,
  model_id TEXT,
  status TEXT NOT NULL,
  error_kind TEXT,
  duration_ms INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  cost REAL NOT NULL,
  plan_cost REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_ts ON attempts(ts);
-- Budget limits the user set (budget.set events); target '' is the global month.
CREATE TABLE IF NOT EXISTS budget_overrides (
  scope TEXT NOT NULL,
  target TEXT NOT NULL,
  usd REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, target)
);
-- Studio Flows (ADR 0033): one row per Flow with its current draft, and its published versions.
CREATE TABLE IF NOT EXISTS studio_flows (
  name TEXT PRIMARY KEY,
  draft_yaml TEXT,
  draft_revision INTEGER,
  draft_saved_at TEXT,
  based_on INTEGER,
  published_version INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS flow_versions (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  yaml TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  actor TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (name, version)
);
-- Pull requests Navarch opened and what became of them (ADR 0037). commit_sha is Navarch's last push
-- to the branch; state is open, merged, closed or gone.
CREATE TABLE IF NOT EXISTS pull_requests (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_sha TEXT,
  opened_at TEXT NOT NULL,
  state TEXT NOT NULL,
  closed_at TEXT,
  commits_after INTEGER,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS pull_requests_opened ON pull_requests(opened_at);
-- CI failures noticed on open pull requests by polling (ADR 0041). One row per head commit.
CREATE TABLE IF NOT EXISTS ci_failures (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  url TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  checks TEXT NOT NULL,
  status TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  run_id TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  resolved_reason TEXT
);
CREATE INDEX IF NOT EXISTS ci_failures_pr ON ci_failures(repo, number);
-- budget.threshold events already recorded, so each is notified once per period.
CREATE TABLE IF NOT EXISTS budget_alerts (
  scope TEXT NOT NULL,
  target TEXT NOT NULL,
  period TEXT NOT NULL,
  ratio REAL NOT NULL,
  PRIMARY KEY (scope, target, period, ratio)
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
DROP TABLE IF EXISTS principles;
DROP TABLE IF EXISTS principle_proposals;
DROP TABLE IF EXISTS work_items;
DROP TABLE IF EXISTS usage;
DROP TABLE IF EXISTS attempts;
DROP TABLE IF EXISTS budget_overrides;
DROP TABLE IF EXISTS budget_alerts;
DROP TABLE IF EXISTS studio_flows;
DROP TABLE IF EXISTS flow_versions;
DROP TABLE IF EXISTS pull_requests;
DROP TABLE IF EXISTS ci_failures;
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
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT
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
