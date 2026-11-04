// src/services/task-sandbox-schema.js —— 派发沙箱覆盖列（DSHBOTS-156）：独立迁移。
//
// 背景：team_assign_task 的可选 sandbox 参数可把任务运行的会话沙箱档位从承接 bot 的
// 配置档收紧（只收紧不放大；入参解析与校验见 src/services/file-policy.js 的
// resolveSandboxOverride，对准承接 bot 的 file_policy）。生效口径见
// src/services/runtime/prompt.js 的 effectiveSandbox：任务写运行取 tasks.sandbox_override，
// 缺省回落 bot.file_policy（不传参数时行为与迁移前完全一致）。
//
// 迁移独立成文件的原因与 recovery-schema 相同：db.js 贴 800 行红线，迁移不写进 db.js。
// 手法同款：schema_migrations 幂等守卫 + PRAGMA 判列 + ALTER TABLE。

import { nowIso } from '../util.js'

export const TASK_SANDBOX_MIGRATION = 'tasks_sandbox_override'

// 同一个 store 只做一次迁移（WeakSet 记忆，store 生命周期内零额外查询）。
const migrated = new WeakSet()

// tasks 表加 sandbox_override 列（'read-only' | 'workspace-write' | NULL），NULL=跟随 bot 配置档。
export function ensureTaskSandboxSchema(store) {
  if (!store || migrated.has(store)) return
  const columns = store.all('PRAGMA table_info(tasks)').map(column => column.name)
  if (!columns.includes('sandbox_override')) {
    store.exec('ALTER TABLE tasks ADD COLUMN sandbox_override TEXT')
  }
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    TASK_SANDBOX_MIGRATION,
    nowIso(),
  )
  migrated.add(store)
}
