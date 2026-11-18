// src/services/chat-stores.js —— 聊天分库域（chat-db-split Phase 1）
// 每个群聊（=项目）与每个单聊（=bot）各一个库文件，正文类数据（messages/
// solo_messages/message_images/run_trajectory）住在聊天库里；顶库只留控制面与全局数据。
// 库文件名是引用 id（项目 id / bot id，均不可变）的纯函数，不需要注册表。
// 一次性迁移 migrateChatSplitP1 按聊天库逐库「幂等拷贝 → 记账」，全部完成后顶库
// 清空四张表并 VACUUM；任意步崩溃重启后按账本续跑（拷贝 INSERT OR IGNORE 幂等）。
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../db.js'
import { nowIso } from '../util.js'

// 句柄上限：聊天库懒打开、LRU 关闭。当前规模（项目数 + bot 数）远低于上限，
// 上限只防长期运行进程的句柄漂移。
const CHAT_STORE_LIMIT = 16

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
  openChatStoreFile(file) {
    if (!this.chatStoreCache) this.chatStoreCache = new Map()
    const hit = this.chatStoreCache.get(file)
    if (hit) {
      hit.at = Date.now()
      return hit.store
    }
    const store = openChatDatabase(join(this.chatStoresDir(), file))
    this.chatStoreCache.set(file, { store, at: Date.now() })
    if (this.chatStoreCache.size > CHAT_STORE_LIMIT) {
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
    return this.listChatStoreFiles().map(file => this.openChatStoreFile(file))
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
  // Phase 1 一次性迁移：见文件头注释。任意步崩溃重启续跑，最终记账后不再进入。
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
}
