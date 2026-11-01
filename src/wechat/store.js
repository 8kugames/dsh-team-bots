import { DatabaseSync } from 'node:sqlite'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { nowIso } from '../util.js'

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
    await mkdir(dirname(this.file), { recursive: true })
    this.db = new DatabaseSync(this.file)
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
    return this
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

  clearCredentials() {
    this.db.prepare(
      "UPDATE channel_state SET credentials_json = NULL, cursor = '', admin_peer_id = NULL, updated_at = ? WHERE id = 1",
    ).run(nowIso())
  }

  enqueue(text) {
    this.db.prepare(
      'INSERT INTO outbox (text, created_at) VALUES (?, ?)',
    ).run(text, nowIso())
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
}
