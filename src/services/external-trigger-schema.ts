// src/services/external-trigger-schema.js —— 外部触发留痕表（B4-②/DSHBOTS-335）。
// 与 wechat_inbound（B4-①，通道自有形态）并列的外部来源观测面：GitHub 触发按
// (source, external_id) 主键落痕——表即「已见集合」，未见过的事件才产生候选通知。
// 每个读入面各自留痕、互不混表；未来如需统一收口再作专项卡。observe 口径：外部
// 事件只记录 + 通知候选，绝不直接建卡/派单（权威链仍是 director 派单，报告 B4 结论）。

import { nowIso } from '../util.js'

export const EXTERNAL_TRIGGER_MIGRATION = 'external_triggers'
export const EXTERNAL_TRIGGER_LOG_CAP = 500

const migrated = new WeakSet()

export function ensureExternalTriggerSchema(store) {
  if (!store || migrated.has(store)) return
  store.exec(`
    CREATE TABLE IF NOT EXISTS external_triggers (
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      project_key TEXT,
      disposition TEXT NOT NULL,
      route TEXT,
      reason TEXT,
      preview TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source, external_id)
    );
    CREATE INDEX IF NOT EXISTS external_triggers_time_idx ON external_triggers(created_at);
  `)
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    EXTERNAL_TRIGGER_MIGRATION,
    nowIso(),
  )
  migrated.add(store)
}

/**
 * 落一行外部触发（主键去重，重复事件静默吸收）并滚动封顶。
 * 返回 'recorded' | 'duplicate'；'recorded' 才应产生候选通知。
 */
export function recordExternalTrigger(store, { source, externalId, projectKey = null, disposition, route = null, reason = null, preview = '' }) {
  ensureExternalTriggerSchema(store)
  if (!source || !externalId) return 'skipped'
  const existing = store.get('SELECT rowid FROM external_triggers WHERE source = ? AND external_id = ?', source, externalId)
  if (existing) return 'duplicate'
  store.run(
    `INSERT INTO external_triggers(source, external_id, project_key, disposition, route, reason, preview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    source, externalId, projectKey, disposition, route, reason, String(preview ?? '').slice(0, 200), nowIso(),
  )
  const count = Number(store.get('SELECT COUNT(*) AS count FROM external_triggers')?.count ?? 0)
  if (count > EXTERNAL_TRIGGER_LOG_CAP) {
    store.run(
      `DELETE FROM external_triggers WHERE rowid IN (
         SELECT rowid FROM external_triggers ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
      EXTERNAL_TRIGGER_LOG_CAP,
    )
  }
  return 'recorded'
}
