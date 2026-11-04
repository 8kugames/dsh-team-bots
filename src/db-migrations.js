// src/db-migrations.js —— 旧库增量迁移（自 db.js 外置：db.js 贴 800 行红线，迁移不再回填进 db.js）。
// 这里只做「把老库结构补到与 SCHEMA 一致」的幂等迁移：addColumn/rebuildTable 自带存在性检查，
// 每个迁移名记入 schema_migrations 账本。新库由 db.js 的 SCHEMA 直接建出全量结构，
// 本文件的迁移对新库全部空转（列已存在即跳过）。

import { nowIso } from './util.js'

// runs 与 session_bindings 的表体：project_id 可空以支持项目外单聊（kind='solo'）。
// 新库建表（db.js SCHEMA）与旧库迁移重建共用同一段 DDL，避免两处定义漂移。
export const RUNS_DDL = `
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
  model_provider TEXT,
  model_model TEXT,
  model_effort TEXT,
  error_code TEXT,
  error_message TEXT,
  retry_after_ms INTEGER,
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

export const RUNS_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_task
    ON runs(task_id)
    WHERE task_id IS NOT NULL AND status IN ('queued', 'running');
  CREATE INDEX IF NOT EXISTS runs_queue_idx ON runs(status, queued_at);
  CREATE INDEX IF NOT EXISTS runs_project_idx ON runs(project_id, queued_at DESC);
  CREATE INDEX IF NOT EXISTS runs_bot_status_idx
    ON runs(bot_id, COALESCE(ended_at, queued_at) DESC);
`

export const BINDINGS_DDL = `
  session_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'project',
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
`

const BINDING_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS one_project_binding
    ON session_bindings(bot_id, project_id, kind) WHERE task_id IS NULL AND project_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS one_task_binding
    ON session_bindings(bot_id, project_id, kind, task_id) WHERE task_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS one_solo_binding
    ON session_bindings(bot_id) WHERE kind = 'solo' AND project_id IS NULL AND task_id IS NULL;
  CREATE INDEX IF NOT EXISTS session_bindings_task_idx ON session_bindings(task_id);
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

// 顺序迁移入口：db.js 的 openDatabase 在 SCHEMA 建表后调用一次。
// 返回 { ftsEnabled } 供 Store 决定走 FTS 还是 LIKE 兜底。
export function runMigrations(db) {
  migrateReviewTarget(db)
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
  recordMigration(db, 'projects_code_hygiene_limit_lines')
  recordMigration(db, 'terminal_commands')
  recordMigration(db, 'messages_reply_to')
  recordMigration(db, 'bots_file_policy')
  recordMigration(db, 'tasks_runs_write_scopes')
  recordMigration(db, 'tasks_time_budget_minutes')
  recordMigration(db, 'runs_retry_after_ms')
  recordMigration(db, 'bots_fallback_model')
  recordMigration(db, 'runs_model_override')
  recordMigration(db, 'chat_reads')
  return { ftsEnabled }
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name)
}

function addColumn(db, table, column, definition) {
  if (columnsOf(db, table).includes(column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

// tasks.review_target：验收目标回填（user / owner_bot），老库按创建者身份推导。
function migrateReviewTarget(db) {
  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name)
  if (!taskColumns.includes('review_target')) {
    db.exec("ALTER TABLE tasks ADD COLUMN review_target TEXT NOT NULL DEFAULT 'user'")
    db.exec("UPDATE tasks SET review_target = CASE WHEN creator_type = 'bot' THEN 'owner_bot' ELSE 'user' END")
  }
}

// bots.file_policy：宿主文件沙箱档位（read-only / workspace-write / danger-full-access），默认工作区内修改。
// bots.fallback_*：主模型不可用时临时接手的备用模型（provider 与 model 成对，effort 可空）。
function migrateBots(db) {
  addColumn(db, 'bots', 'file_policy', "TEXT NOT NULL DEFAULT 'workspace-write'")
  addColumn(db, 'bots', 'fallback_provider', 'TEXT')
  addColumn(db, 'bots', 'fallback_model', 'TEXT')
  addColumn(db, 'bots', 'fallback_effort', 'TEXT')
}

// run.mode 区分写入型与只读型运行：同一项目同时只允许一个写运行，只读运行可并行。
// run.write_scopes 是任务运行入队时对写范围的快照（JSON 路径数组）；空 = 未声明。
function migrateRuns(db) {
  addColumn(db, 'runs', 'mode', "TEXT NOT NULL DEFAULT 'write'")
  addColumn(db, 'runs', 'last_progress_at', 'TEXT')
  addColumn(db, 'runs', 'artifacts', 'TEXT')
  addColumn(db, 'runs', 'write_scopes', 'TEXT')
  // 限流失败的机器可读退避时间（provider Retry-After 换算的毫秒数），只有 provider 真发了才有值。
  addColumn(db, 'runs', 'retry_after_ms', 'INTEGER')
  // 本条运行实际下发的模型；model_provider 非空 = 该运行走的是备用模型（NULL = 用 Bot 主模型）。
  addColumn(db, 'runs', 'model_provider', 'TEXT')
  addColumn(db, 'runs', 'model_model', 'TEXT')
  addColumn(db, 'runs', 'model_effort', 'TEXT')
  db.exec(`UPDATE runs SET mode = 'read' WHERE kind IN ('chat', 'review', 'handle') AND mode = 'write'`)
}

// tasks.write_scopes 存任务声明的写范围（JSON 路径数组）；空数组 = 未声明，
// 调度器据此把同项目写运行改为「范围不重叠才并行」。
// tasks.time_budget_minutes 存发布时的时效要求（分钟，NULL = 未声明不注入提示词）。
function migrateTasks(db) {
  addColumn(db, 'tasks', 'write_scopes', "TEXT NOT NULL DEFAULT '[]'")
  addColumn(db, 'tasks', 'time_budget_minutes', 'INTEGER')
}

// projects.disabled_skills 存项目内关闭的技能 slug JSON 数组。
// projects.production_dir 存项目生产目录（bots 的 cwd）；NULL 表示用默认 <工作区>/{slug}。
// projects.code_hygiene_limit_lines 存单文件行数约定（DSHBOTS-172）；NULL = 默认 800，0 = 关闭。
function migrateProjects(db) {
  addColumn(db, 'projects', 'disabled_skills', "TEXT NOT NULL DEFAULT '[]'")
  addColumn(db, 'projects', 'production_dir', 'TEXT')
  addColumn(db, 'projects', 'code_hygiene_limit_lines', 'INTEGER')
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
