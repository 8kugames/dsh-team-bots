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
        direct_project_key TEXT,
        updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        gave_up_at TEXT,
        receipt_key TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS peers (
        peer_id TEXT PRIMARY KEY,
        context_token TEXT NOT NULL,
        client_id TEXT,
        at INTEGER NOT NULL
      );
    `)
    await this.migrateOutboxColumns()
    await this.migrateChannelStateColumns()
    // 幂等收据键（A3/DSHBOTS-323）：同键只允许一行在库（存留期内重复推送被吸收）。
    // 部分唯一索引：无键行（notify 未带 receiptKey 的旧调用形态）不参与约束。
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS outbox_receipt_key_idx ON outbox(receipt_key) WHERE receipt_key IS NOT NULL')
    await this.secureFiles()
    return this
  }

  /**
   * 旧库补列迁移：直达对话（DSHBOTS-208）引入项目绑定列之前的库缺这一列。
   * 幂等：列已存在则跳过；补列无默认值，旧行语义等价于「未绑定」。
   */
  async migrateChannelStateColumns() {
    const columns = new Set(
      this.db.prepare('PRAGMA table_info(channel_state)').all().map(column => column.name),
    )
    if (!columns.has('direct_project_key')) {
      this.db.exec('ALTER TABLE channel_state ADD COLUMN direct_project_key TEXT')
    }
  }

  /**
   * 旧库补列迁移：outbox 引入重试上限（attempts）与废弃标记（gave_up_at）前的库缺这两列；
   * 幂等收据键（A3/DSHBOTS-323）与最近失败原因（last_error）同批补齐。
   * 幂等：列已存在则跳过；补列带默认值，旧行语义等价于「未重试过、未废弃、无收据键」。
   */
  async migrateOutboxColumns() {
    const columns = new Set(
      this.db.prepare('PRAGMA table_info(outbox)').all().map(column => column.name),
    )
    if (!columns.has('attempts')) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
    }
    if (!columns.has('gave_up_at')) {
      this.db.exec('ALTER TABLE outbox ADD COLUMN gave_up_at TEXT')
    }
    if (!columns.has('receipt_key')) {
      this.db.exec('ALTER TABLE outbox ADD COLUMN receipt_key TEXT')
    }
    if (!columns.has('last_error')) {
      this.db.exec('ALTER TABLE outbox ADD COLUMN last_error TEXT')
    }
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

  /** 直达对话（DSHBOTS-208）：管理员微信会话当前绑定的项目 key（未绑定为 null）。 */
  getDirectProjectKey() {
    return this.getState()?.direct_project_key ?? null
  }

  /** 绑定直达项目：`<key>: <消息>` 显式路由或自由文本成功路由后调用；空值解除绑定。 */
  saveDirectProjectKey(key) {
    this.db.prepare(
      `INSERT INTO channel_state (id, direct_project_key, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET direct_project_key = excluded.direct_project_key, updated_at = excluded.updated_at`,
    ).run(key ? String(key) : null, nowIso())
  }

  /** 会话凭证（contextToken/clientId）：每个联系人一行，入站消息即刷新（UPSERT）。
   *  at 为该凭证最后刷新时间（epoch ms），供通道侧做过期判定。 */
  savePeer(peerId, { contextToken, clientId, at }) {
    if (!peerId || !contextToken) return false
    this.db.prepare(
      `INSERT INTO peers (peer_id, context_token, client_id, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(peer_id) DO UPDATE SET
         context_token = excluded.context_token,
         client_id = excluded.client_id,
         at = excluded.at`,
    ).run(String(peerId), String(contextToken), clientId == null ? null : String(clientId), Number(at) || Date.now())
    return true
  }

  loadPeers() {
    return this.db.prepare('SELECT peer_id, context_token, client_id, at FROM peers').all()
  }

  /** 清理 N 天前最后刷新的过期会话凭证（默认 7 天，与通道侧凭证时效一致）。 */
  purgeExpiredPeers(days = 7) {
    const cutoff = Date.now() - Math.max(0, days) * DAY_MS
    const result = this.db.prepare('DELETE FROM peers WHERE at < ?').run(cutoff)
    return Number(result?.changes ?? 0)
  }

  /** 登出：凭证、cursor、管理员绑定、会话凭证与待发件箱一起清空，
   *  避免旧消息与旧账号的会话凭证在下次登录后外发。 */
  clearCredentials() {
    this.db.prepare(
      "UPDATE channel_state SET credentials_json = NULL, cursor = '', admin_peer_id = NULL, direct_project_key = NULL, updated_at = ? WHERE id = 1",
    ).run(nowIso())
    this.db.prepare('DELETE FROM peers').run()
    this.db.prepare('DELETE FROM outbox').run()
  }

  /**
   * 入队推送（A3/DSHBOTS-323）：带 receiptKey 时做幂等吸收——同键在存留期内只入队一次
   * （先查后插，单进程无并发入队者；部分唯一索引兜底路径性竞态，竞态冲突由调用方 catch）。
   * 返回 'enqueued' | 'duplicate' | 'skipped'，调用方据此留痕；不带键的旧形态行为不变。
   */
  enqueue(text, receiptKey = null) {
    const body = String(text ?? '').trim()
    if (!body) return 'skipped'
    const key = receiptKey ? String(receiptKey) : null
    if (!key) {
      this.db.prepare(
        'INSERT INTO outbox (text, created_at) VALUES (?, ?)',
      ).run(body, nowIso())
      return 'enqueued'
    }
    const existing = this.db.prepare('SELECT id FROM outbox WHERE receipt_key = ?').get(key)
    if (existing) return 'duplicate'
    this.db.prepare(
      'INSERT INTO outbox (text, created_at, receipt_key) VALUES (?, ?, ?)',
    ).run(body, nowIso(), key)
    return 'enqueued'
  }

  /** 按 receipt_key 查收据终态（A3/DSHBOTS-323）：sent（已发送）/ gone（已废弃）/ pending（待发）。 */
  receiptStates(keys) {
    const list = (Array.isArray(keys) ? keys : []).map(key => String(key)).filter(Boolean)
    if (!list.length) return []
    const placeholders = list.map(() => '?').join(', ')
    return this.db.prepare(
      `SELECT receipt_key, text, sent_at, gave_up_at, attempts, last_error, created_at
       FROM outbox WHERE receipt_key IN (${placeholders}) ORDER BY id DESC`,
    ).all(...list)
  }

  /** 近期收据流水（A3/DSHBOTS-323）：带键条目按入队倒序，供运维视图追责/回放。 */
  receipts(limit = 50) {
    return this.db.prepare(
      `SELECT receipt_key, text, sent_at, gave_up_at, attempts, last_error, created_at
       FROM outbox WHERE receipt_key IS NOT NULL ORDER BY id DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(200, Number(limit) || 50)))
  }

  pendingOutbox(limit = 20) {
    return this.db.prepare(
      'SELECT * FROM outbox WHERE sent_at IS NULL AND gave_up_at IS NULL ORDER BY id LIMIT ?',
    ).all(limit)
  }

  markSent(ids) {
    if (!ids.length) return
    const statement = this.db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ?')
    const at = nowIso()
    for (const id of ids) statement.run(at, id)
  }

  /** 记一次发送失败（可重试），返回该条累计尝试次数（含本次；持久化，重启不重置）。
   *  last_error 存最近一次失败原因（A3/DSHBOTS-323：废弃后可解释「为什么没收到」。 */
  markAttempt(id, error = '') {
    const result = this.db.prepare(
      "UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ? AND sent_at IS NULL AND gave_up_at IS NULL",
    ).run(String(error ?? '').slice(0, 500), id)
    if (!Number(result?.changes ?? 0)) return null
    const row = this.db.prepare('SELECT attempts FROM outbox WHERE id = ?').get(id)
    return Number(row?.attempts ?? 0)
  }

  /** 废弃指定待发条目：仍视为未发送，但永久不再补发（重试超限或不可重试失败）。
   *  可带失败原因落 last_error（不带时保留既有原因，如链接重建的批量作废）。 */
  giveUp(ids, error = null) {
    if (!ids.length) return 0
    const statement = error
      ? this.db.prepare(
        'UPDATE outbox SET gave_up_at = ?, last_error = ? WHERE id = ? AND sent_at IS NULL AND gave_up_at IS NULL',
      )
      : this.db.prepare(
        'UPDATE outbox SET gave_up_at = ? WHERE id = ? AND sent_at IS NULL AND gave_up_at IS NULL',
      )
    const at = nowIso()
    let changed = 0
    for (const id of ids) changed += Number((error ? statement.run(at, String(error).slice(0, 500), id) : statement.run(at, id))?.changes ?? 0)
    return changed
  }

  /** 通道链接建立时调用：作废全部存量待发（历史堆积不补发，只发链接后产生的新事件）。 */
  giveUpAllPending() {
    const result = this.db.prepare(
      'UPDATE outbox SET gave_up_at = ? WHERE sent_at IS NULL AND gave_up_at IS NULL',
    ).run(nowIso())
    return Number(result?.changes ?? 0)
  }

  /** 清理 N 天前已发送或已废弃的记录，默认保留 7 天。 */
  purgeSentOutbox(days = 7) {
    const cutoff = new Date(Date.now() - Math.max(0, days) * DAY_MS).toISOString()
    const result = this.db.prepare(
      'DELETE FROM outbox WHERE (sent_at IS NOT NULL AND sent_at < ?) OR (gave_up_at IS NOT NULL AND gave_up_at < ?)',
    ).run(cutoff, cutoff)
    return Number(result?.changes ?? 0)
  }
}

/** 目标权限不符时收紧（新建文件已带对 mode 时不重复改）。 */
async function ensureMode(path, mode) {
  try {
    const info = await stat(path)
    if ((info.mode & 0o7777) === mode) return
    await chmod(path, mode)
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
}
