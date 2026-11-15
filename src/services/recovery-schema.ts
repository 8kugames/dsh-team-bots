// src/services/recovery-schema.js —— 重启恢复标记（recovery note）：独立迁移。
//
// 背景：宿主重启时运行中的 runs 会被重排队（core.js 的 running→queued 恢复逻辑），
// 但重新执行的 worker 不知道上次执行被中断，可能重复已落地的外部动作（提交/发布/消息）。
// recovery 列就是「这次排队源自重启恢复」的一次性标记：重排队时置 1，
// 首条提示词注入恢复提醒后即刻清 0（session.js startRun），后续运行回到标准提示词。
//
// 迁移独立成文件的原因：src/db.js 已贴 800 行红线（HEAD 版本已 818 行），迁移不写进 db.js。
// 手法与 src/services/attention-schema.js 的 ensureAttentionSchema、src/services/tasks.js 的
// ensureTaskTimesSchema 同款：schema_migrations 幂等守卫 + PRAGMA 判列 + ALTER TABLE。

import { nowIso } from '../util.js'

export const RECOVERY_MIGRATION = 'runs_recovery_note'

// 同一个 store 只做一次迁移（WeakSet 记忆，store 生命周期内零额外查询）。
const migrated = new WeakSet()

// runs 表加 recovery 列（一次性恢复标记，0/1），迁移名 runs_recovery_note。
export function ensureRecoverySchema(store) {
  if (!store || migrated.has(store)) return
  const columns = store.all('PRAGMA table_info(runs)').map(column => column.name)
  if (!columns.includes('recovery')) {
    store.exec('ALTER TABLE runs ADD COLUMN recovery INTEGER NOT NULL DEFAULT 0')
  }
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    RECOVERY_MIGRATION,
    nowIso(),
  )
  migrated.add(store)
}
