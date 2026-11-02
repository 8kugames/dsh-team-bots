import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { nowIso } from './util.js'

// runs 与 session_bindings 的表体：project_id 可空以支持项目外单聊（kind='solo'）。
// 新库建表与旧库迁移重建共用同一段 DDL，避免两处定义漂移。
const RUNS_DDL = `
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  parent_run_id TEXT,
  kind TEXT NOT NULL DEFAULT 'chat',
  mode TEXT NOT NULL DEFAULT 'write',
  write_scopes TEXT,
  trigger_type TEXT NOT NULL,
  trigger_ref TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE,
  session_id TEXT,
  error_code TEXT,
  error_message TEXT,
  output TEXT,
  artifacts TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  last_progress_at TEXT,
  usage_input INTEGER NOT NULL DEFAULT 0,
  usage_cache_read INTEGER NOT NULL DEFAULT 0,
  usage_cache_write INTEGER NOT NULL DEFAULT 0,
  usage_output INTEGER NOT NULL DEFAULT 0,
  usage_cost REAL,
  cancel_requested INTEGER NOT NULL DEFAULT 0
`

const RUNS_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_task
  ON runs(task_id)
  WHERE task_id IS NOT NULL AND status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS runs_queue_idx ON runs(status, queued_at);
CREATE INDEX IF NOT EXISTS runs_project_idx ON runs(project_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS runs_bot_status_idx
  ON runs(bot_id, COALESCE(ended_at, queued_at) DESC);
`

const RUNS_COLUMNS = 'id, project_id, bot_id, task_id, parent_run_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, session_id, error_code, error_message, output, artifacts, queued_at, started_at, ended_at, last_progress_at, usage_input, usage_cache_read, usage_cache_write, usage_output, usage_cost, cancel_requested'

const BINDINGS_DDL = `
  session_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'project',
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
`

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

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  topic,
  content,
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(memory_id, topic, content) VALUES (new.id, new.topic, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  UPDATE memories_fts SET topic = new.topic, content = new.content WHERE memory_id = old.id;
END;
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
  migrateRuns(db)
  migrateBots(db)
  migrateTasks(db)
  migrateSessionBindings(db)
  migrateProjects(db)
  migrateMemories(db)
  migrateProposals(db)
  migrateUsageEvents(db)
  migrateSoloSupport(db)
  migrateSoloDirUnique(db)
  migrateMessages(db)
  db.exec(BINDING_INDEXES)
  const ftsEnabled = setupFts(db)
  recordMigration(db, 'memories_source_refs_revision')
  recordMigration(db, 'proposals_diff_evaluation_canary')
  recordMigration(db, 'usage_events_currency_task')
  recordMigration(db, 'skill_bindings_table')
  recordMigration(db, 'usage_reconciliation_table')
  recordMigration(db, 'memories_fts')
  recordMigration(db, 'solo_chat_support')
  recordMigration(db, 'bot_direct_messages')
  recordMigration(db, 'runs_artifacts')
  recordMigration(db, 'run_trajectory')
  recordMigration(db, 'projects_production_dir')
  recordMigration(db, 'terminal_commands')
  recordMigration(db, 'messages_reply_to')
  recordMigration(db, 'bots_file_policy')
  recordMigration(db, 'tasks_runs_write_scopes')
  return new Store(db, { ftsEnabled })
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name)
}

function addColumn(db, table, column, definition) {
  if (columnsOf(db, table).includes(column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}


// bots.file_policy：宿主文件沙箱档位（read-only / workspace-write / danger-full-access），默认工作区内修改。
function migrateBots(db) {
  addColumn(db, 'bots', 'file_policy', "TEXT NOT NULL DEFAULT 'workspace-write'")
}

// run.mode 区分写入型与只读型运行：同一项目同时只允许一个写运行，只读运行可并行。
// run.write_scopes 是任务运行入队时对写范围的快照（JSON 路径数组）；空 = 未声明。
function migrateRuns(db) {
  addColumn(db, 'runs', 'mode', "TEXT NOT NULL DEFAULT 'write'")
  addColumn(db, 'runs', 'last_progress_at', 'TEXT')
  addColumn(db, 'runs', 'artifacts', 'TEXT')
  addColumn(db, 'runs', 'write_scopes', 'TEXT')
  db.exec(`UPDATE runs SET mode = 'read' WHERE kind IN ('chat', 'review', 'handle') AND mode = 'write'`)
}

// tasks.write_scopes 存任务声明的写范围（JSON 路径数组）；空数组 = 未声明，
// 调度器据此把同项目写运行改为「范围不重叠才并行」。
function migrateTasks(db) {
  addColumn(db, 'tasks', 'write_scopes', "TEXT NOT NULL DEFAULT '[]'")
}

// projects.disabled_skills 存项目内关闭的技能 slug JSON 数组。
// projects.production_dir 存项目生产目录（bots 的 cwd）；NULL 表示用默认 <工作区>/{slug}。
function migrateProjects(db) {
  addColumn(db, 'projects', 'disabled_skills', "TEXT NOT NULL DEFAULT '[]'")
  addColumn(db, 'projects', 'production_dir', 'TEXT')
}

// 记忆的来源引用、审批人、版本号与派生路径。
function migrateMemories(db) {
  addColumn(db, 'memories', 'source_refs_json', "TEXT NOT NULL DEFAULT '[]'")
  addColumn(db, 'memories', 'approved_by', 'TEXT')
  addColumn(db, 'memories', 'revision', 'INTEGER NOT NULL DEFAULT 1')
  addColumn(db, 'memories', 'summary', "TEXT NOT NULL DEFAULT ''")
  addColumn(db, 'memories', 'path', 'TEXT')
}

// 提案的结构化差异、评估结果、灰度范围与审批痕迹。
function migrateProposals(db) {
  addColumn(db, 'proposals', 'evaluation_json', "TEXT NOT NULL DEFAULT '{}'")
  addColumn(db, 'proposals', 'diff_json', "TEXT NOT NULL DEFAULT '{}'")
  addColumn(db, 'proposals', 'canary_json', 'TEXT')
  addColumn(db, 'proposals', 'approved_by', 'TEXT')
  addColumn(db, 'proposals', 'applied_at', 'TEXT')
}

// 用量事件补齐币种、来源事件 id 与任务关联。
function migrateUsageEvents(db) {
  addColumn(db, 'usage_events', 'currency', "TEXT NOT NULL DEFAULT 'CNY'")
  addColumn(db, 'usage_events', 'source_event_id', 'TEXT')
  addColumn(db, 'usage_events', 'task_id', 'TEXT REFERENCES tasks(id) ON DELETE SET NULL')
}

// FTS5 全文索引：可用则建立并回填，不可用则回退到 LIKE 扫描。
function setupFts(db) {
  try {
    db.exec(FTS_SCHEMA)
  } catch {
    return false
  }
  db.exec(`INSERT INTO memories_fts(memory_id, topic, content)
    SELECT id, topic, content FROM memories
    WHERE id NOT IN (SELECT memory_id FROM memories_fts)`)
  return true
}

function recordMigration(db, name) {
  db.prepare(
    'INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
  ).run(name, nowIso())
}

// 旧的 session_bindings 带 UNIQUE(bot_id, project_id, kind)，无法容纳每任务一条会话绑定。
// task_id 为 NULL 时用部分唯一索引表达「每 Bot 每项目一个会话」，非 NULL 时按任务唯一。
function migrateSessionBindings(db) {
  if (columnsOf(db, 'session_bindings').includes('task_id')) return
  rebuildTable(db, 'session_bindings', `CREATE TABLE session_bindings (${BINDINGS_DDL})`)
}

// 单聊支持：runs 与 session_bindings 的 project_id 放宽为可空（项目外会话与运行），
// bots 增加 solo_dir。子表（run_events/usage_events/usage_reconciliation）按名字引用 runs，
// 「建新表→拷贝→删旧表→改回原名」后名字恢复，外键子句无需改写。
function migrateSoloSupport(db) {
  addColumn(db, 'bots', 'solo_dir', 'TEXT')
  // 旧版 one_project_binding 覆盖 project_id 为 NULL 的行，单聊绑定会撞唯一约束；先删，BINDING_INDEXES 重建收窄版。
  db.exec('DROP INDEX IF EXISTS one_project_binding')
  if (columnNotNull(db, 'runs', 'project_id')) {
    rebuildTable(db, 'runs', `CREATE TABLE runs (${RUNS_DDL})`)
    db.exec(RUNS_INDEXES)
  }
  if (columnNotNull(db, 'session_bindings', 'project_id')) {
    rebuildTable(db, 'session_bindings', `CREATE TABLE session_bindings (${BINDINGS_DDL})`)
  }
}

function columnNotNull(db, table, column) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all().find(row => row.name === column)
  return Boolean(info?.notnull)
}

// 单聊目录唯一：新库建表时 solo_dir 就带 UNIQUE，老库是 addColumn 补的列，没有唯一约束，
// 两个 bot 可能指向同一个工作目录互相覆盖。补一个部分唯一索引把这种状态挡住。
// 老库里若已有重复目录名，这里不改名：改名等于把 bot 指向另一个工作目录，比缺约束更难收拾，
// 只告警让使用者自己改名或合并。
function migrateSoloDirUnique(db) {
  if (!columnsOf(db, 'bots').includes('solo_dir')) return
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS bots_solo_dir_unique ON bots(solo_dir) WHERE solo_dir IS NOT NULL')
  } catch (error) {
    console.warn(`dsh-team: 单聊目录存在重复，bots.solo_dir 唯一索引未创建：${error.message}`)
  }
}

// 群聊消息引用回复：messages.reply_to_id 存被引用消息的 id，一级引用不建链。
// 不加外键约束：引用目标可能被级联删除，引用悬空时由 service/messageView 容忍（视图里 reply_to 置 null）。
function migrateMessages(db) {
  addColumn(db, 'messages', 'reply_to_id', 'TEXT')
}

// 全量重建一张表：原名表数据拷入 <name>_new 后删除原名表，再把新表改回原名。
function rebuildTable(db, name, createSql) {
  const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name)
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec(createSql.replace(`CREATE TABLE ${name} (`, `CREATE TABLE ${name}_new (`))
    db.exec(`INSERT INTO ${name}_new(${columns.join(', ')})
      SELECT ${columns.join(', ')} FROM ${name}`)
    db.exec(`DROP TABLE ${name}`)
    db.exec(`ALTER TABLE ${name}_new RENAME TO ${name}`)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

const BINDING_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS one_project_binding
  ON session_bindings(bot_id, project_id, kind) WHERE task_id IS NULL AND project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_task_binding
  ON session_bindings(bot_id, project_id, kind, task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_solo_binding
  ON session_bindings(bot_id) WHERE kind = 'solo' AND project_id IS NULL AND task_id IS NULL;
CREATE INDEX IF NOT EXISTS session_bindings_task_idx ON session_bindings(task_id);
`

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
