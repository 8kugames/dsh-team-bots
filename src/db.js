import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { nowIso } from './util.js'

// 旧库增量迁移与共享 DDL 常量外置于 db-migrations.js（db.js 贴 800 行红线不再加行）：
// RUNS_DDL/RUNS_INDEXES/BINDINGS_DDL 在新库建表（下方 SCHEMA）与旧库迁移重建间共用，防两处漂移。
import { runMigrations, RUNS_DDL, RUNS_INDEXES, BINDINGS_DDL } from './db-migrations.js'

const RUNS_COLUMNS = 'id, project_id, bot_id, task_id, parent_run_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, session_id, model_provider, model_model, model_effort, error_code, error_message, retry_after_ms, output, artifacts, queued_at, started_at, ended_at, last_progress_at, usage_input, usage_cache_read, usage_cache_write, usage_output, usage_cost, cancel_requested'

const BINDING_COLUMNS = 'session_id, bot_id, project_id, kind, task_id, created_at'

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
  fallback_provider TEXT,
  fallback_model TEXT,
  fallback_effort TEXT,
  file_policy TEXT NOT NULL DEFAULT 'workspace-write',
  solo_dir TEXT UNIQUE,
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
  production_dir TEXT,
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
  reply_to_id TEXT,
  created_at TEXT NOT NULL
);

-- 单聊：项目外与单个 Bot 的一对一对话记录，不依赖项目与群聊。
CREATE TABLE IF NOT EXISTS solo_messages (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
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
  time_budget_minutes INTEGER,
  write_scopes TEXT NOT NULL DEFAULT '[]',
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

CREATE TABLE IF NOT EXISTS runs (${RUNS_DDL});

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 运行轨迹：模型回合、思考文本、工具调用与工具结果的前端展示账本。
CREATE TABLE IF NOT EXISTS run_trajectory (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  turn INTEGER,
  step INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS run_trajectory_run_idx ON run_trajectory(run_id, seq);

CREATE TABLE IF NOT EXISTS session_bindings (${BINDINGS_DDL});

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
  approved_by TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  summary TEXT NOT NULL DEFAULT '',
  path TEXT,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
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
  evaluation_json TEXT NOT NULL DEFAULT '{}',
  diff_json TEXT NOT NULL DEFAULT '{}',
  canary_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT NOT NULL,
  decided_by TEXT,
  approved_by TEXT,
  applied_at TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS skill_bindings (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope_type, scope_id, slug)
);

CREATE TABLE IF NOT EXISTS usage_reconciliation (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_calls INTEGER NOT NULL DEFAULT 0,
  event_tokens INTEGER NOT NULL DEFAULT 0,
  run_tokens INTEGER NOT NULL DEFAULT 0,
  delta_tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  note TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL,
  UNIQUE(run_id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- terminal_commands：工作台「终端」tab 的非交互式命令执行记录。
-- status: running → succeeded | failed | timeout | canceled | interrupted；
-- output 是密钥掩码后的末尾 200KB；每项目保留最近 20 条（terminalState 查询时顺手清理）。
CREATE TABLE IF NOT EXISTS terminal_commands (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  exit_code INTEGER,
  output TEXT NOT NULL DEFAULT '',
  error_message TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS terminal_commands_project_idx ON terminal_commands(project_id, created_at DESC);

-- chat_reads：用户对各项目群聊的已读水位（IM 式未读计数的依据）。
-- 未读 = 水位之后到达的 bot 群聊消息；没有水位的项目以项目创建时间为基线。
CREATE TABLE IF NOT EXISTS chat_reads (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reader_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (project_id, reader_id)
);

-- outbox：状态变更 → 建运行 的可靠交接。写入即落库，调度器按顺序领取并投递，
-- 失败按退避重试，超过上限转 failed 供人工排查。
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  source_id TEXT,
  idempotency_key TEXT UNIQUE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(status, available_at);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  source_event_id TEXT,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT 'run',
  currency TEXT NOT NULL DEFAULT 'CNY',
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
  currency TEXT NOT NULL DEFAULT 'CNY',
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

-- bot_messages：bot 之间经 team_message_bot 的直接交互。(project_id, from_bot_id, request_id)
-- 唯一保证具名请求幂等；status: pending → delivered（dm 运行已建）→ replied（回复已产出）| failed。
CREATE TABLE IF NOT EXISTS bot_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  to_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  text TEXT NOT NULL,
  origin_session_id TEXT,
  origin_kind TEXT,
  origin_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  run_id TEXT,
  reply TEXT,
  replied_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, from_bot_id, request_id)
);

CREATE INDEX IF NOT EXISTS bot_messages_project_idx ON bot_messages(project_id, created_at DESC);

-- secrets：团队/项目两级密钥，值 AES-256-GCM 加密存储；fingerprint 供 UI 确认而不回显明文。
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('team', 'project')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  value_enc TEXT NOT NULL,
  value_iv TEXT NOT NULL,
  value_tag TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS secrets_scope_name_idx ON secrets(scope, IFNULL(project_id, ''), name);

-- secret_requests：bot 发起的密钥请求，用户在设置页处理。
CREATE TABLE IF NOT EXISTS secret_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  handled_at TEXT
);

CREATE INDEX IF NOT EXISTS secret_requests_status_idx ON secret_requests(status, created_at DESC);

${RUNS_INDEXES}
CREATE INDEX IF NOT EXISTS messages_project_idx ON messages(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS solo_messages_bot_idx ON solo_messages(bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS usage_project_idx ON usage_events(project_id, occurred_at);
CREATE INDEX IF NOT EXISTS usage_bot_idx ON usage_events(bot_id, occurred_at);
CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(scope_type, scope_id, status);
CREATE INDEX IF NOT EXISTS proposals_status_idx ON proposals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS skill_bindings_scope_idx ON skill_bindings(scope_type, scope_id, status);
CREATE INDEX IF NOT EXISTS usage_events_run_idx ON usage_events(run_id);
CREATE INDEX IF NOT EXISTS usage_events_occurred_idx ON usage_events(occurred_at);
`

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec(SCHEMA)
  const { ftsEnabled } = runMigrations(db)
  return new Store(db, { ftsEnabled })
}

export class Store {
  constructor(db, options = {}) {
    this.db = db
    this.ftsEnabled = options.ftsEnabled === true
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
