import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { nowIso } from './util.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'blue',
  provider TEXT,
  model TEXT,
  effort TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  current_revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_revisions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  provider TEXT,
  model TEXT,
  effort TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(bot_id, version)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  owner_bot_id TEXT NOT NULL REFERENCES bots(id),
  status TEXT NOT NULL DEFAULT 'active',
  token_budget REAL,
  cost_budget REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL,
  member_id TEXT NOT NULL,
  member_role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL,
  PRIMARY KEY(project_id, member_type, member_id)
);

CREATE TABLE IF NOT EXISTS group_chats (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  owner_bot_id TEXT NOT NULL REFERENCES bots(id),
  reply_mode TEXT NOT NULL DEFAULT 'owner_first',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  group_chat_id TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',
  task_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee_bot_id TEXT REFERENCES bots(id),
  creator_type TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  review_target TEXT NOT NULL DEFAULT 'user',
  source_message_id TEXT,
  parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  estimate REAL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(project_id, number)
);

CREATE TABLE IF NOT EXISTS task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  PRIMARY KEY(task_id, label)
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  parent_run_id TEXT,
  kind TEXT NOT NULL DEFAULT 'chat',
  trigger_type TEXT NOT NULL,
  trigger_ref TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE,
  session_id TEXT,
  error_code TEXT,
  error_message TEXT,
  output TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  usage_input INTEGER NOT NULL DEFAULT 0,
  usage_cache_read INTEGER NOT NULL DEFAULT 0,
  usage_cache_write INTEGER NOT NULL DEFAULT 0,
  usage_output INTEGER NOT NULL DEFAULT 0,
  usage_cost REAL,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_bindings (
  session_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'project',
  created_at TEXT NOT NULL,
  UNIQUE(bot_id, project_id, kind)
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  before_text TEXT,
  after_text TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL,
  path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_versions (
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  PRIMARY KEY(slug, version)
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  evaluation TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT NOT NULL,
  decided_by TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT 'run',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  input_cost REAL,
  output_cost REAL,
  total_cost REAL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_prices (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_per_mtok REAL NOT NULL DEFAULT 0,
  cache_read_per_mtok REAL NOT NULL DEFAULT 0,
  cache_write_per_mtok REAL NOT NULL DEFAULT 0,
  output_per_mtok REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  effective_at TEXT NOT NULL,
  UNIQUE(provider, model, effective_at)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_task
  ON runs(task_id)
  WHERE task_id IS NOT NULL AND status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS runs_queue_idx ON runs(status, queued_at);
CREATE INDEX IF NOT EXISTS runs_project_idx ON runs(project_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS messages_project_idx ON messages(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS usage_project_idx ON usage_events(project_id, occurred_at);
CREATE INDEX IF NOT EXISTS usage_bot_idx ON usage_events(bot_id, occurred_at);
CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(scope_type, scope_id, status);
CREATE INDEX IF NOT EXISTS proposals_status_idx ON proposals(status, created_at DESC);
`

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec(SCHEMA)
  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name)
  if (!taskColumns.includes('review_target')) {
    db.exec("ALTER TABLE tasks ADD COLUMN review_target TEXT NOT NULL DEFAULT 'user'")
    db.exec("UPDATE tasks SET review_target = CASE WHEN creator_type = 'bot' THEN 'owner_bot' ELSE 'user' END")
  }
  return new Store(db)
}

export class Store {
  constructor(db) {
    this.db = db
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params).map(row => ({ ...row }))
  }

  get(sql, ...params) {
    const row = this.db.prepare(sql).get(...params)
    return row === undefined ? undefined : { ...row }
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params)
  }

  exec(sql) {
    this.db.exec(sql)
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  close() {
    this.db.close()
  }

  setting(key, fallback = null) {
    return this.get('SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback
  }

  setSetting(key, value) {
    this.run(
      'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      String(value),
    )
  }

  audit(actorType, actorId, action, targetType, targetId, data = {}) {
    this.run(
      'INSERT INTO audit_log(id, actor_type, actor_id, action, target_type, target_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      `aud_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      actorType,
      actorId,
      action,
      targetType,
      targetId,
      JSON.stringify(data),
      nowIso(),
    )
  }
}
