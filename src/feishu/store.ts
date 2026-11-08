import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { nowIso } from '../util.js'

/** 通道数据目录只允许属主访问；库文件只允许属主读写（与 WechatStore 同款）。 */
const DIR_MODE = 0o700
const FILE_MODE = 0o600
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 飞书通道的独立持久化：bot 身份（botId/appId/brand）、管理员 ou_id、
 * 回复锚点与待发件箱。与主库（team 工作台）分离。
 * 凭据模型（DSHBOTS-333）：app secret 由配置注入（进程内 SDK 使用），
 * 本库只存 bot 身份标识，secret 不进库不进日志。
 */
export class FeishuStore {
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
        cli_path TEXT NOT NULL DEFAULT '',
        bot_id TEXT,
        app_id TEXT,
        brand TEXT NOT NULL DEFAULT 'feishu',
        admin_ou_id TEXT,
        cursor TEXT NOT NULL DEFAULT '',
        reply_message_id TEXT,
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
    `)
    // 幂等收据键：同键只允许一行在库（存留期内重复推送被吸收）；部分唯一索引兜底竞态。
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS outbox_receipt_key_idx ON outbox(receipt_key) WHERE receipt_key IS NOT NULL')
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

  /** 绑定成功后落 bot 身份（botId/appId/brand）；secret 不在此列。 */
  saveBot({ botId, appId, brand = 'feishu' }) {
    this.db.prepare(
      `INSERT INTO channel_state (id, cli_path, bot_id, app_id, brand, updated_at) VALUES (1, '', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         bot_id = excluded.bot_id,
         app_id = excluded.app_id, brand = excluded.brand, updated_at = excluded.updated_at`,
    ).run(String(botId ?? ''), String(appId ?? ''), String(brand ?? 'feishu'), nowIso())
  }

  saveAdminOu(ouId) {
    this.db.prepare(
      `INSERT INTO channel_state (id, admin_ou_id, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET admin_ou_id = excluded.admin_ou_id, updated_at = excluded.updated_at`,
    ).run(String(ouId ?? ''), nowIso())
  }

  saveCursor(cursor) {
    this.db.prepare(
      `INSERT INTO channel_state (id, cursor, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ).run(String(cursor ?? ''), nowIso())
  }

  /** 出站回复目标：管理员最近一条入站消息 id（messages-reply 需要它定位话题）。
   *  入站消费另卡接线；本卡由绑定/测试直接写入。同时绑定管理员 ou_id。 */
  saveReplyMessageId(messageId, adminOuId = null) {
    this.db.prepare(
      `INSERT INTO channel_state (id, reply_message_id, admin_ou_id, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         reply_message_id = excluded.reply_message_id,
         admin_ou_id = COALESCE(excluded.admin_ou_id, channel_state.admin_ou_id),
         updated_at = excluded.updated_at`,
    ).run(String(messageId ?? ''), adminOuId ? String(adminOuId) : null, nowIso())
  }

  /** 解绑：绑定信息、cursor、管理员与待发件箱一起清空（与 WechatStore.clearCredentials 同口径）。 */
  clearBinding() {
    this.db.prepare(
      `UPDATE channel_state SET
         cli_path = '', bot_id = NULL, app_id = NULL, brand = 'feishu',
         admin_ou_id = NULL, cursor = '', reply_message_id = NULL, updated_at = ? WHERE id = 1`,
    ).run(nowIso())
    this.db.prepare('DELETE FROM outbox').run()
  }

  /**
   * 入队推送：带 receiptKey 时做幂等吸收——同键在存留期内只入队一次。
   * 返回 'enqueued' | 'duplicate' | 'skipped'。
   */
  enqueue(text, receiptKey = null) {
    const body = String(text ?? '').trim()
    if (!body) return 'skipped'
    const key = receiptKey ? String(receiptKey) : null
    if (!key) {
      this.db.prepare('INSERT INTO outbox (text, created_at) VALUES (?, ?)').run(body, nowIso())
      return 'enqueued'
    }
    const existing = this.db.prepare('SELECT id FROM outbox WHERE receipt_key = ?').get(key)
    if (existing) return 'duplicate'
    this.db.prepare('INSERT INTO outbox (text, created_at, receipt_key) VALUES (?, ?, ?)').run(body, nowIso(), key)
    return 'enqueued'
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

  /** 记一次发送失败（可重试），返回该条累计尝试次数（含本次；持久化，重启不重置）。 */
  markAttempt(id, error = '') {
    const result = this.db.prepare(
      "UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ? AND sent_at IS NULL AND gave_up_at IS NULL",
    ).run(String(error ?? '').slice(0, 500), id)
    if (!Number(result?.changes ?? 0)) return null
    const row = this.db.prepare('SELECT attempts FROM outbox WHERE id = ?').get(id)
    return Number(row?.attempts ?? 0)
  }

  /** 废弃指定待发条目：仍视为未发送，但永久不再补发（重试超限或目标消息 gone）。 */
  giveUp(ids, error = null) {
    if (!ids.length) return 0
    const statement = error
      ? this.db.prepare('UPDATE outbox SET gave_up_at = ?, last_error = ? WHERE id = ? AND sent_at IS NULL AND gave_up_at IS NULL')
      : this.db.prepare('UPDATE outbox SET gave_up_at = ? WHERE id = ? AND sent_at IS NULL AND gave_up_at IS NULL')
    const at = nowIso()
    let changed = 0
    for (const id of ids) {
      changed += Number(
        (error ? statement.run(at, String(error).slice(0, 500), id) : statement.run(at, id))?.changes ?? 0,
      )
    }
    return changed
  }

  /** 通道重新绑定完成时调用：作废全部存量待发（历史堆积不补发，只发绑定后产生的新事件）。 */
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
