// src/services/chat-stores.js —— 聊天分库域
// 每个群聊（=项目）与每个单聊（=bot）各一个库文件，正文类数据（messages/
// solo_messages/message_images/run_trajectory）住在聊天库里；顶库只留控制面与全局数据。
// 库文件名是引用 id（项目 id / bot id，均不可变）的纯函数，不需要注册表。
// 一次性迁移 migrateChatSplitP1 按聊天库逐库「幂等拷贝 → 记账」，全部完成后顶库
// 清空四张表并 VACUUM；任意步崩溃重启后按账本续跑（拷贝 INSERT OR IGNORE 幂等）。
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../db.js'
import { jsonParse, nowIso } from '../util.js'

// 句柄上限：聊天库懒打开、LRU 关闭。当前规模（项目数 + bot 数）远低于上限，
// 上限只防长期运行进程的句柄漂移。
const CHAT_STORE_LIMIT = 32

// 迁移拷贝分块：每片一个聊天库事务，避免整表载入内存（生产轨迹 18.7 万行 / 186MB）。
const COPY_CHUNK_ROWS = 500

// 聊天库结构：与顶库同名表同列集，但去掉指向顶库表（projects/bots/runs）的外键——
// 跨库引用由服务层守门（与 messages.reply_to_id 悬空容忍同一口径）。库内引用
// （message_images → messages/solo_messages）保留外键与级联。
const CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  group_chat_id TEXT,
  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',
  task_id TEXT,
  run_id TEXT,
  reply_to_id TEXT,
  kind TEXT NOT NULL DEFAULT 'text',
  question_id TEXT,
  approval_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_project_idx ON messages(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_task_idx ON messages(task_id, created_at);

-- 收件箱的 @owner 事项：总监群消息写出 @owner 即登记一行，手动标已读写 read_at。
-- 随消息级联删除：/clear 清群后事项自然消失，不留悬空行。
CREATE TABLE IF NOT EXISTS owner_mentions (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS solo_messages (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL DEFAULT 'text',
  question_id TEXT,
  approval_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS solo_messages_bot_idx ON solo_messages(bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_images (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  solo_message_id TEXT REFERENCES solo_messages(id) ON DELETE CASCADE,
  project_id TEXT,
  bot_id TEXT,
  media_type TEXT NOT NULL,
  data TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  CHECK ((message_id IS NULL) <> (solo_message_id IS NULL))
);
CREATE INDEX IF NOT EXISTS message_images_message_idx ON message_images(message_id);
CREATE INDEX IF NOT EXISTS message_images_solo_idx ON message_images(solo_message_id);

CREATE TABLE IF NOT EXISTS run_trajectory (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  turn INTEGER,
  step INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_trajectory_run_idx ON run_trajectory(run_id, seq);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  source_event_id TEXT,
  run_id TEXT,
  project_id TEXT,
  bot_id TEXT,
  task_id TEXT,
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
CREATE INDEX IF NOT EXISTS usage_project_idx ON usage_events(project_id, occurred_at);
CREATE INDEX IF NOT EXISTS usage_bot_idx ON usage_events(bot_id, occurred_at);
CREATE INDEX IF NOT EXISTS usage_events_run_idx ON usage_events(run_id);
CREATE INDEX IF NOT EXISTS usage_events_task_idx ON usage_events(task_id);
CREATE INDEX IF NOT EXISTS usage_events_occurred_idx ON usage_events(occurred_at);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS run_events_type_idx ON run_events(type);

-- run 胖载荷（Phase 3）：runs 瘦身留顶库当调度索引，output/artifacts 住这里。
CREATE TABLE IF NOT EXISTS run_payload (
  run_id TEXT PRIMARY KEY,
  output TEXT,
  artifacts TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_comments_task_idx ON task_comments(task_id, created_at);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events(task_id, created_at);

CREATE TABLE IF NOT EXISTS terminal_commands (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  exit_code INTEGER,
  output TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS terminal_commands_project_idx ON terminal_commands(project_id, created_at);

CREATE TABLE IF NOT EXISTS usage_reconciliation (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_calls INTEGER NOT NULL DEFAULT 0,
  event_tokens INTEGER NOT NULL DEFAULT 0,
  run_tokens INTEGER NOT NULL DEFAULT 0,
  delta_tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  note TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL,
  UNIQUE(run_id)
);
`

export function openChatDatabase(path) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec(CHAT_SCHEMA)
  return new Store(db, {})
}

// 分块幂等拷贝：按 rowid 键序翻页读源表，逐片一个目标库事务 INSERT OR IGNORE。
function copyRowsBetween(from, to, table, columns, where, params) {
  const cols = columns.split(',').map(item => item.trim())
  const insert = `INSERT OR IGNORE INTO ${table}(${columns}) VALUES (${cols.map(() => '?').join(', ')})`
  let last = 0
  for (;;) {
    const rows = from.all(
      `SELECT rowid AS __rid, ${columns} FROM ${table} WHERE (${where}) AND rowid > ? ORDER BY rowid LIMIT ${COPY_CHUNK_ROWS}`,
      ...params, last,
    )
    if (!rows.length) return
    to.transaction(() => {
      for (const row of rows) to.run(insert, ...cols.map(col => row[col] ?? null))
    })
    last = rows[rows.length - 1].__rid
  }
}

const CHAT_TABLE_COLUMNS = {
  messages: 'id, project_id, group_chat_id, sender_type, sender_id, body, mentions_json, task_id, run_id, reply_to_id, kind, question_id, approval_id, created_at',
  solo_messages: 'id, bot_id, sender_type, sender_id, body, run_id, kind, question_id, approval_id, created_at',
  message_images: 'id, message_id, solo_message_id, project_id, bot_id, media_type, data, bytes, name, created_at',
  run_trajectory: 'id, run_id, seq, kind, title, detail, turn, step, created_at',
  usage_events: 'id, source_key, source_event_id, run_id, project_id, bot_id, task_id, provider, model, purpose, currency, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, input_cost, output_cost, total_cost, occurred_at, created_at',
  usage_reconciliation: 'id, run_id, event_calls, event_tokens, run_tokens, delta_tokens, status, note, checked_at',
  run_events: 'id, run_id, type, message, created_at',
  task_comments: 'id, task_id, author_type, author_id, body, created_at',
  task_events: 'id, task_id, type, actor_type, actor_id, data_json, created_at',
  terminal_commands: 'id, project_id, command, status, exit_code, output, error_message, created_at, ended_at',
}

export const chatStoreMethods = {
  chatStoresDir() {
    return join(this.config.dataDir, 'chats')
  },
  groupChatFileName(projectId) {
    return `p-${projectId}.sqlite`
  },
  soloChatFileName(botId) {
    return `solo-${botId}.sqlite`
  },
  openChatStoreFile(file, { evict = true } = {}) {
    if (!this.chatStoreCache) this.chatStoreCache = new Map()
    const hit = this.chatStoreCache.get(file)
    if (hit) {
      hit.at = Date.now()
      return hit.store
    }
    const store = openChatDatabase(join(this.chatStoresDir(), file))
    this.chatStoreCache.set(file, { store, at: Date.now() })
    if (evict && this.chatStoreCache.size > CHAT_STORE_LIMIT) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [key, entry] of this.chatStoreCache) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at
          oldestKey = key
        }
      }
      if (oldestKey && oldestKey !== file) {
        const evicted = this.chatStoreCache.get(oldestKey)
        this.chatStoreCache.delete(oldestKey)
        try { evicted.store.close() } catch { /* 已关闭的库再关一次不算错误 */ }
      }
    }
    return store
  },
  groupChatStore(projectId) {
    return this.openChatStoreFile(this.groupChatFileName(projectId))
  },
  soloChatStore(botId) {
    return this.openChatStoreFile(this.soloChatFileName(botId))
  },
  // 运行归属的聊天库：project_id 非空 → 该项目群聊库；为空 → 运行 bot 的单聊库。
  runChatStore(run) {
    if (!run) return this.store
    return run.project_id ? this.groupChatStore(run.project_id) : this.soloChatStore(run.bot_id)
  },
  listChatStoreFiles() {
    try {
      return readdirSync(this.chatStoresDir()).filter(file => file.endsWith('.sqlite'))
    } catch {
      return []
    }
  },
  allChatStores() {
    // 批量快照期间不做 LRU 淘汰：淘汰会当场关闭本轮已收集进数组的句柄，
    // 随后的扇出清理（applyRetention/未读数/图片回填）就会打到已关闭的库，
    // 报 "database is not open"（聊天库数超过 LRU 上限时必现）。
    // 批量后缓存可能暂时超上限，由后续单开的 LRU 逐步收敛。
    return this.listChatStoreFiles().map(file => this.openChatStoreFile(file, { evict: false }))
  },
  // state 版本签名段：每个聊天库一条「引用 id:本连接累计变更数」。
  // 取聊天实体清单（顶库的 projects/bots）而不是文件系统列表：文件清单会随「首次打开某聊天库」
  // 而增长，导致版本串在两次轮询间漂移、短路失效。实体清单只随项目/bot 增删变化（那是真实变更）。
  // 未缓存的聊天库记 0——它没有被打开过，自然也没有写入；写必先打开（缓存），故不漏检。
  chatVersionParts() {
    const parts = []
    for (const row of this.store.all('SELECT id FROM projects')) {
      parts.push(`p-${row.id}:${this.cachedChatChanges(this.groupChatFileName(row.id))}`)
    }
    for (const row of this.store.all('SELECT id FROM bots')) {
      parts.push(`s-${row.id}:${this.cachedChatChanges(this.soloChatFileName(row.id))}`)
    }
    return parts
  },
  cachedChatChanges(file) {
    const entry = this.chatStoreCache?.get(file)
    if (!entry) return 0
    try {
      return entry.store.changes()
    } catch {
      return 0
    }
  },
  closeChatStores() {
    if (!this.chatStoreCache) return
    for (const entry of this.chatStoreCache.values()) {
      try { entry.store.close() } catch { /* 关闭失败不阻塞停机 */ }
    }
    this.chatStoreCache.clear()
  },
  // 移除追踪：整个聊天库文件随之删除（正文数据全在其中），连 -wal/-shm 一起清。
  dropGroupChatDb(projectId) {
    const file = this.groupChatFileName(projectId)
    const entry = this.chatStoreCache?.get(file)
    if (entry) {
      try { entry.store.close() } catch { /* 已关闭的库再关一次不算错误 */ }
      this.chatStoreCache.delete(file)
    }
    const base = join(this.chatStoresDir(), file)
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(`${base}${suffix}`, { force: true }) } catch { /* 删除失败留人工处理 */ }
    }
  },
  // 路由助手：run 胖载荷住运行归属的聊天库。
  // 顶库 runs 已瘦身（output/artifacts 住 run_payload）：读取经助手并到载荷。
  runOutputOf(run) {
    if (!run) return ''
    const payload = this.runPayloadOf(run)
    return payload?.output ?? run.output ?? ''
  },
  runArtifactsOf(run) {
    if (!run) return []
    const payload = this.runPayloadOf(run)
    const list = jsonParse(payload?.artifacts ?? run.artifacts, [])
    return Array.isArray(list) ? list : []
  },
  runPayloadOf(run) {
    if (!run) return null
    return this.runChatStore(run).get('SELECT * FROM run_payload WHERE run_id = ?', run.id)
  },
  saveRunPayload(run, { output = null, artifacts = null }) {
    this.runChatStore(run).run(
      `INSERT INTO run_payload(run_id, output, artifacts, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET output = COALESCE(excluded.output, output),
         artifacts = COALESCE(excluded.artifacts, artifacts), updated_at = excluded.updated_at`,
      run.id, output, artifacts, nowIso(),
    )
  },

  // 一次性迁移：见文件头注释。任意步崩溃重启续跑，最终记账后不再进入。
  migrateChatSplitP1() {
    const ledgerName = 'chat_split_p1'
    if (this.store.get('SELECT 1 FROM schema_migrations WHERE name = ?', ledgerName)) return
    mkdirSync(this.chatStoresDir(), { recursive: true })
    const targets = []
    for (const project of this.store.all('SELECT id FROM projects')) {
      const pid = project.id
      targets.push({
        file: this.groupChatFileName(pid),
        ledger: `chat_split_p1:p:${pid}`,
        copies: [
          { table: 'messages', where: 'project_id = ?', params: [pid] },
          { table: 'message_images', where: 'project_id = ? OR message_id IN (SELECT id FROM messages WHERE project_id = ?)', params: [pid, pid] },
          { table: 'run_trajectory', where: 'run_id IN (SELECT id FROM runs WHERE project_id = ?)', params: [pid] },
        ],
      })
    }
    for (const bot of this.store.all('SELECT id FROM bots')) {
      const bid = bot.id
      targets.push({
        file: this.soloChatFileName(bid),
        ledger: `chat_split_p1:s:${bid}`,
        copies: [
          { table: 'solo_messages', where: 'bot_id = ?', params: [bid] },
          { table: 'message_images', where: 'bot_id = ? OR solo_message_id IN (SELECT id FROM solo_messages WHERE bot_id = ?)', params: [bid, bid] },
          { table: 'run_trajectory', where: 'run_id IN (SELECT id FROM runs WHERE project_id IS NULL AND bot_id = ?)', params: [bid] },
        ],
      })
    }
    for (const target of targets) {
      if (this.store.get('SELECT 1 FROM schema_migrations WHERE name = ?', target.ledger)) continue
      const chat = this.openChatStoreFile(target.file)
      for (const copy of target.copies) {
        copyRowsBetween(this.store, chat, copy.table, CHAT_TABLE_COLUMNS[copy.table], copy.where, copy.params)
      }
      this.store.run(
        'INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
        target.ledger, nowIso(),
      )
    }
    // 四张表的每一行都属且仅属一个聊天库（图片按归属列兜底关联拷贝），全库拷贝完成后
    // 顶库一次性清空；拷贝幂等，本事务与逐库记账之间的崩溃只会导致重拷，不会丢行。
    this.store.transaction(() => {
      this.store.run('DELETE FROM message_images')
      this.store.run('DELETE FROM messages')
      this.store.run('DELETE FROM solo_messages')
      this.store.run('DELETE FROM run_trajectory')
      this.store.run(
        'INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
        ledgerName, nowIso(),
      )
    })
    // 删除只进 freelist，主文件不缩：一次性 VACUUM 回收（生产库量级数十秒，仅本迁移触发）。
    this.store.exec('VACUUM')
    this.logger?.info?.('dsh-team: 聊天分库 Phase 1 迁移完成：messages/solo_messages/message_images/run_trajectory 已迁入各聊天库')
  },
  // 一次性迁移：用量明细与对账迁入聊天库，顶库一次性构建 usage_rollup 汇总
  // （视图/预算自此只读汇总）。同样账本闸控、崩溃可续跑。
  migrateChatSplitP2() {
    const ledgerName = 'chat_split_p2'
    if (this.store.get('SELECT 1 FROM schema_migrations WHERE name = ?', ledgerName)) return
    mkdirSync(this.chatStoresDir(), { recursive: true })
    // 历史行 task_id 预回填：聊天库里没有 runs 表可 JOIN 追认，迁移时在顶库一次性补齐，
    // 之后明细拷贝就是自足的。
    this.store.run(
      `UPDATE usage_events SET task_id = (SELECT task_id FROM runs WHERE id = usage_events.run_id)
        WHERE task_id IS NULL AND run_id IS NOT NULL`,
    )
    const targets = []
    for (const project of this.store.all('SELECT id FROM projects')) {
      const pid = project.id
      targets.push({
        file: this.groupChatFileName(pid),
        ledger: `chat_split_p2:p:${pid}`,
        copies: [
          { table: 'usage_events', where: 'project_id = ? OR run_id IN (SELECT id FROM runs WHERE project_id = ?)', params: [pid, pid] },
          { table: 'usage_reconciliation', where: 'run_id IN (SELECT id FROM runs WHERE project_id = ?)', params: [pid] },
        ],
      })
    }
    for (const bot of this.store.all('SELECT id FROM bots')) {
      const bid = bot.id
      targets.push({
        file: this.soloChatFileName(bid),
        ledger: `chat_split_p2:s:${bid}`,
        copies: [
          { table: 'usage_events', where: '(project_id IS NULL AND bot_id = ?) OR run_id IN (SELECT id FROM runs WHERE project_id IS NULL AND bot_id = ?)', params: [bid, bid] },
          { table: 'usage_reconciliation', where: 'run_id IN (SELECT id FROM runs WHERE project_id IS NULL AND bot_id = ?)', params: [bid] },
        ],
      })
    }
    for (const target of targets) {
      if (this.store.get('SELECT 1 FROM schema_migrations WHERE name = ?', target.ledger)) continue
      const chat = this.openChatStoreFile(target.file)
      for (const copy of target.copies) {
        copyRowsBetween(this.store, chat, copy.table, CHAT_TABLE_COLUMNS[copy.table], copy.where, copy.params)
      }
      this.store.run(
        'INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
        target.ledger, nowIso(),
      )
    }
    // 顶库汇总一次性构建（单条 INSERT..SELECT 原子完成，但重跑会重复累加——
    // 单独账本闸兜崩溃续跑：建桶即记账，续跑只在闸缺失时重建）。
    // project_key 冗余存档：项目移除后历史汇总仍可读。未落在任何聊天库的无主行
    // （无 project/bot/run 归属）也进汇总——用量是全局历史，不因无法路由而丢账。
    if (!this.store.get('SELECT 1 FROM schema_migrations WHERE name = ?', `${ledgerName}:rollup`)) {
    this.store.exec(`
      INSERT INTO usage_rollup(hour_utc, project_id, project_key, bot_id, provider, model, currency, priced,
        calls, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, stored_cost)
      SELECT substr(occurred_at, 1, 13),
             COALESCE(project_id, ''),
             COALESCE((SELECT key FROM projects WHERE id = usage_events.project_id), ''),
             COALESCE(bot_id, ''), provider, model, currency,
             CASE WHEN total_cost IS NOT NULL THEN 1 ELSE 0 END,
             COUNT(*), SUM(input_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens),
             SUM(output_tokens), SUM(reasoning_tokens),
             COALESCE(SUM(CASE WHEN total_cost IS NOT NULL THEN total_cost ELSE 0 END), 0)
        FROM usage_events
       GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
      ON CONFLICT(hour_utc, project_id, bot_id, provider, model, currency, priced) DO UPDATE SET
        calls = calls + excluded.calls,
        input_tokens = input_tokens + excluded.input_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
        stored_cost = stored_cost + excluded.stored_cost
    `)
    this.store.run(
      'INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
      `${ledgerName}:rollup`, nowIso(),
    )
    }
    // 拷贝幂等 + 汇总闸幂等，清空与记账一个事务；无主行留在顶库由保留期清理兜底。
    this.store.transaction(() => {
      this.store.run('DELETE FROM usage_events WHERE project_id IS NOT NULL OR bot_id IS NOT NULL OR run_id IS NOT NULL')
      this.store.run('DELETE FROM usage_reconciliation WHERE run_id IN (SELECT id FROM runs)')
      this.store.run(
        'INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
        ledgerName, nowIso(),
      )
    })
    this.store.exec('VACUUM')
    this.logger?.info?.('dsh-team: 聊天分库 Phase 2 迁移完成：usage_events/usage_reconciliation 已迁入各聊天库，顶库改读 usage_rollup 汇总')
  },
  // 一次性迁移：run_events/胖载荷/任务评论事件/终端命令迁入聊天库；
  // runs 瘦身留顶库当调度索引（output/artifacts 清空转 run_payload）。
  migrateChatSplitP3() {
    const ledgerName = 'chat_split_p3'
    if (this.store.get('SELECT 1 FROM schema_migrations WHERE name = ?', ledgerName)) return
    mkdirSync(this.chatStoresDir(), { recursive: true })
    const targets = []
    for (const project of this.store.all('SELECT id FROM projects')) {
      targets.push({ file: this.groupChatFileName(project.id), ledger: `chat_split_p3:p:${project.id}`, pid: project.id })
    }
    for (const bot of this.store.all('SELECT id FROM bots')) {
      targets.push({ file: this.soloChatFileName(bot.id), ledger: `chat_split_p3:s:${bot.id}`, bid: bot.id })
    }
    for (const target of targets) {
      if (this.store.get('SELECT 1 FROM schema_migrations WHERE name = ?', target.ledger)) continue
      const chat = this.openChatStoreFile(target.file)
      const copies = target.pid
        ? [
          { table: 'run_events', where: 'run_id IN (SELECT id FROM runs WHERE project_id = ?)', params: [target.pid] },
          { table: 'task_comments', where: 'task_id IN (SELECT id FROM tasks WHERE project_id = ?)', params: [target.pid] },
          { table: 'task_events', where: 'task_id IN (SELECT id FROM tasks WHERE project_id = ?)', params: [target.pid] },
          { table: 'terminal_commands', where: 'project_id = ?', params: [target.pid] },
        ]
        : [
          { table: 'run_events', where: 'run_id IN (SELECT id FROM runs WHERE project_id IS NULL AND bot_id = ?)', params: [target.bid] },
        ]
      for (const copy of copies) {
        copyRowsBetween(this.store, chat, copy.table, CHAT_TABLE_COLUMNS[copy.table], copy.where, copy.params)
      }
      // run 胖载荷：output/artifacts 非空的运行搬进 run_payload（幂等）。
      chat.transaction(() => {
        const rows = this.store.all(
          `SELECT id, output, artifacts FROM runs WHERE ${target.pid ? 'project_id = ?' : 'project_id IS NULL AND bot_id = ?'}
             AND (output IS NOT NULL OR artifacts IS NOT NULL)`,
          target.pid ?? target.bid,
        )
        for (const row of rows) {
          chat.run(
            `INSERT INTO run_payload(run_id, output, artifacts, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(run_id) DO NOTHING`,
            row.id, row.output, row.artifacts, nowIso(),
          )
        }
      })
      this.store.run(
        'INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
        target.ledger, nowIso(),
      )
    }
    // 清空与 runs 瘦身一个事务；无主行（join 不上 runs/tasks 的孤儿）留顶库由保留期兜底。
    this.store.transaction(() => {
      this.store.run('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs)')
      this.store.run('DELETE FROM task_comments WHERE task_id IN (SELECT id FROM tasks)')
      this.store.run('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks)')
      this.store.run('DELETE FROM terminal_commands WHERE project_id IS NOT NULL')
      this.store.run('UPDATE runs SET output = NULL, artifacts = NULL WHERE output IS NOT NULL OR artifacts IS NOT NULL')
      this.store.run(
        'INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
        ledgerName, nowIso(),
      )
    })
    this.store.exec('VACUUM')
    this.logger?.info?.('dsh-team: 聊天分库 Phase 3 迁移完成：run_events/胖载荷/任务评论事件/终端命令已迁入各聊天库，runs 已瘦身')
  },
}
