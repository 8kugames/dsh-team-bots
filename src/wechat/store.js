import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { nowIso } from '../util.js'

/** 通道数据目录只允许属主访问；库文件（含明文 token）只允许属主读写。 */
const DIR_MODE = 0o700
const FILE_MODE = 0o600
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 微信通道的独立持久化：凭证、轮询 cursor、待发件箱。
 * 与主库（team 工作台）分离，避免耦合主 schema 迁移节奏。
 */
export class WechatStore {
  constructor(file) {
    this.db = null
    this.file = file
  }

  async open() {
    const dir = dirname(this.file)
    await mkdir(dir, { recursive: true, mode: DIR_MODE })
    await ensureMode(dir, DIR_MODE)
    this.db = new DatabaseSync(this.file)
    await this.secureFiles()
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS channel_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        credentials_json TEXT,
        cursor TEXT NOT NULL DEFAULT '',
        admin_peer_id TEXT,
        updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
    `)
    await this.secureFiles()
    return this
  }

  /** 库文件与 WAL/SHM 侧文件都收紧到 0600（新建与已存在都检查，过宽则收紧）。 */
  async secureFiles() {
    await ensureMode(this.file, FILE_MODE)
    await ensureMode(`${this.file}-wal`, FILE_MODE)
    await ensureMode(`${this.file}-shm`, FILE_MODE)
  }

  close() {
    this.db?.close()
    this.db = null
  }

  getState() {
    return this.db.prepare('SELECT * FROM channel_state WHERE id = 1').get() ?? null
  }

  saveCredentials(credentials) {
    this.db.prepare(
      `INSERT INTO channel_state (id, credentials_json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET credentials_json = excluded.credentials_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify(credentials), nowIso())
  }

  saveCursor(cursor) {
    this.db.prepare(
      `INSERT INTO channel_state (id, cursor, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ).run(String(cursor ?? ''), nowIso())
  }

  saveAdminPeer(peerId) {
    this.db.prepare(
      `INSERT INTO channel_state (id, admin_peer_id, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET admin_peer_id = excluded.admin_peer_id, updated_at = excluded.updated_at`,
    ).run(String(peerId), nowIso())
  }

  /** 登出：凭证、cursor、管理员绑定与待发件箱一起清空，避免旧消息在下次登录后外发。 */
  clearCredentials() {
    this.db.prepare(
      "UPDATE channel_state SET credentials_json = NULL, cursor = '', admin_peer_id = NULL, updated_at = ? WHERE id = 1",
    ).run(nowIso())
    this.db.prepare('DELETE FROM outbox').run()
  }

  enqueue(text) {
    const body = String(text ?? '').trim()
    if (!body) return false
    this.db.prepare(
      'INSERT INTO outbox (text, created_at) VALUES (?, ?)',
    ).run(body, nowIso())
    return true
  }

  pendingOutbox(limit = 20) {
    return this.db.prepare(
      'SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?',
    ).all(limit)
  }

  markSent(ids) {
    if (!ids.length) return
    const statement = this.db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ?')
    const at = nowIso()
    for (const id of ids) statement.run(at, id)
  }

  /** 清理 N 天前已发送的记录，默认保留 7 天。 */
  purgeSentOutbox(days = 7) {
    const cutoff = new Date(Date.now() - Math.max(0, days) * DAY_MS).toISOString()
    const result = this.db.prepare(
      'DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at < ?',
    ).run(cutoff)
    return Number(result?.changes ?? 0)
  }
}

/** 目标权限不符时收紧（新建文件已带对 mode 时不重复改）。 */
async function ensureMode(path, mode) {
  try {
    const info = await stat(path)
    if ((info.mode & 0o7777) === mode) return
    await chmod(path, mode)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
