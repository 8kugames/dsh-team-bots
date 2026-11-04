// src/services/rollover-schema.js —— 会话结转支撑索引（runs_session_idx）：独立迁移。
//
// 背景：会话结转（DSHBOTS-145）在每次会话复用时按 session_id 统计 runs 轮次（COUNT(*)），
// 无索引时全表扫描；runs 表随运行只增不减（留存默认关闭），统计必须走索引。
// 迁移独立成文件的原因同 src/services/recovery-schema.js：db.js / db-migrations.js 的
// 表结构常量按房规不塞新索引，结转域自管。手法同款：schema_migrations 幂等守卫 +
// CREATE INDEX IF NOT EXISTS（索引本身幂等，账本用 ON CONFLICT(name) DO NOTHING）。

import { nowIso } from '../util.js'

export const ROLLOVER_MIGRATION = 'runs_session_idx'

// 同一个 store 只做一次迁移（WeakSet 记忆，store 生命周期内零额外查询）。
const migrated = new WeakSet()

// runs(session_id) 索引：会话结转轮次统计（COUNT(*)）的支撑索引。
export function ensureRolloverSchema(store) {
  if (!store || migrated.has(store)) return
  store.exec('CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(session_id)')
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    ROLLOVER_MIGRATION,
    nowIso(),
  )
  migrated.add(store)
}
