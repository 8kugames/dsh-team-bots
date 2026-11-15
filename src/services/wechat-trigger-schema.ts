// src/services/wechat-trigger-schema.js —— 微信入站 Trigger 留痕表（B4-①/DSHBOTS-328）。
// 吸收原型 sources 层「不收的消息仍进系统并记 reason」的口径：微信是当前唯一外部入口，
// 每条入站事件按稳定 id 留痕（disposition：handled/filtered/rejected/duplicate + route +
// reason），面板与巡检可回答「这条消息为什么没有触发」。不做整套 Source 抽象（报告 B4
// 结论：按通道分步，勿整体搬 Source 层）；读入（Trigger 翻译）与写出（notify 收据）分离
// 各自留痕，通道出站侧收据见 wechat/store.ts 的 receipt_key（A3）。
//
// 迁移独立成文件的原因：与 attention-schema/recovery-schema 同款手法——src/db.js 贴 800
// 行红线，独立迁移文件 + schema_migrations 幂等登记。

import { nowIso } from '../util.js'

export const WECHAT_TRIGGER_MIGRATION = 'wechat_inbound_log'
// 滚动封顶：留痕是运维观测面不是账本，超过上限裁掉最旧的（插一行查一次总量，量小）。
export const WECHAT_TRIGGER_LOG_CAP = 500

const migrated = new WeakSet()

export function ensureWechatTriggerSchema(store) {
  if (!store || migrated.has(store)) return
  store.exec(`
    CREATE TABLE IF NOT EXISTS wechat_inbound (
      id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      disposition TEXT NOT NULL,
      route TEXT,
      reason TEXT,
      preview TEXT
    );
    CREATE INDEX IF NOT EXISTS wechat_inbound_time_idx ON wechat_inbound(received_at);
  `)
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    WECHAT_TRIGGER_MIGRATION,
    nowIso(),
  )
  migrated.add(store)
}

/** 落一行留痕并滚动封顶（稳定 id 主键，重复事件静默吸收）。返回 'recorded' | 'duplicate'。 */
export function recordWechatTriggerRow(store, event) {
  ensureWechatTriggerSchema(store)
  const existing = store.get('SELECT id FROM wechat_inbound WHERE id = ?', event.id)
  if (existing) return 'duplicate'
  store.run(
    `INSERT INTO wechat_inbound(id, received_at, peer_id, disposition, route, reason, preview)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    event.id, event.received_at ?? nowIso(), String(event.peer_id ?? ''),
    String(event.disposition ?? 'handled'), event.route ?? null, event.reason ?? null,
    String(event.preview ?? '').slice(0, 120),
  )
  const count = Number(store.get('SELECT COUNT(*) AS count FROM wechat_inbound')?.count ?? 0)
  if (count > WECHAT_TRIGGER_LOG_CAP) {
    store.run(
      `DELETE FROM wechat_inbound WHERE id IN (
         SELECT id FROM wechat_inbound ORDER BY received_at DESC LIMIT -1 OFFSET ?)`,
      WECHAT_TRIGGER_LOG_CAP,
    )
  }
  return 'recorded'
}
