// src/services/task-goal.ts —— 任务卡的版本化 Goal 锚点：独立迁移 + 解析校验 + 视图与引用核对。
//
// 口径：
// - Goal 是卡片的结构字段（goal_statement / goal_criteria / goal_version / goal_parent_version），
//   只由建卡人或 director 显式填写；状态、负责人、评论、交付物、写作用域的变更都不产生新版本，
//   也不从 description 自动生成。
// - 每次显式改 Goal 产生新版本（goal_version 单调递增，不清零），旧版本正文留在 task_events 的
//   goal_revised 事件里，不进新 run 的上下文。
// - goal_parent_version 是设目标时父任务 Goal 版本的快照：父卡之后改了目标，子卡 run 能看出来。
// - 进展与中间发现不进 Goal，留在卡片评论或执行日志。
//
// 迁移独立成文件的原因与 task-sandbox-schema 相同：db.ts 不为单列迁移加行。
// 手法同款：schema_migrations 幂等守卫 + PRAGMA 判列 + ALTER TABLE。

import { badRequest } from '../errors.js'
import { nowIso } from '../util.js'

export const TASK_GOAL_MIGRATION = 'tasks_goal_anchor'
export const GOAL_STATEMENT_MAX_CHARS = 2_000
export const GOAL_CRITERION_MAX_CHARS = 500
export const GOAL_CRITERIA_MAX = 12

// 同一个 store 只做一次迁移（WeakSet 记忆，store 生命周期内零额外查询）。
const migrated = new WeakSet()

// tasks 表加 Goal 四列。goal_statement 为 NULL 即本卡没有 Goal。
export function ensureTaskGoalSchema(store) {
  if (!store || migrated.has(store)) return
  const columns = store.all('PRAGMA table_info(tasks)').map(column => column.name)
  for (const [column, type] of [['goal_statement', 'TEXT'], ['goal_criteria', 'TEXT'], ['goal_version', 'INTEGER'], ['goal_parent_version', 'INTEGER']]) {
    if (!columns.includes(column)) store.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`)
  }
  store.run(
    'INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
    TASK_GOAL_MIGRATION,
    nowIso(),
  )
  migrated.add(store)
}

export const criterionId = index => `C${index + 1}`

// 解析外部传入的 Goal（{ statement, criteria }）。超限一律拒绝而不是截断：完成标准被悄悄
// 截掉半条，验收就会对着一条不存在的标准放行。
export function parseGoalInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('goal 应为 { statement, criteria } 对象')
  }
  const statement = String(raw.statement ?? '').trim()
  if (!statement) throw badRequest('Goal 的目标陈述不能为空')
  if (statement.length > GOAL_STATEMENT_MAX_CHARS) {
    throw badRequest(`Goal 的目标陈述不能超过 ${GOAL_STATEMENT_MAX_CHARS} 字符（实测 ${statement.length}）`)
  }
  if (!Array.isArray(raw.criteria)) throw badRequest('Goal 的完成标准应为字符串数组，每条一项')
  const criteria = []
  for (const item of raw.criteria) {
    const line = String(item ?? '').trim()
    if (!line) continue
    if (line.length > GOAL_CRITERION_MAX_CHARS) {
      throw badRequest(`单条完成标准不能超过 ${GOAL_CRITERION_MAX_CHARS} 字符（实测 ${line.length}）：${line.slice(0, 40)}…`)
    }
    criteria.push(line)
  }
  if (!criteria.length) throw badRequest('Goal 至少需要一条完成标准')
  if (criteria.length > GOAL_CRITERIA_MAX) {
    throw badRequest(`Goal 的完成标准最多 ${GOAL_CRITERIA_MAX} 条（实测 ${criteria.length}），请合并或拆卡`)
  }
  return { statement, criteria }
}

// 读卡片行上的 Goal；没有 Goal 时返回 null（列缺失或坏数据同样按没有处理）。
export function readTaskGoal(task) {
  if (!task?.goal_statement) return null
  let stored
  try {
    stored = JSON.parse(task.goal_criteria ?? '[]')
  } catch {
    stored = []
  }
  const criteria = (Array.isArray(stored) ? stored : []).filter(item => typeof item === 'string' && item.trim())
  if (!criteria.length) return null
  return { version: Number(task.goal_version) || 1, statement: task.goal_statement, criteria }
}

// taskView 的 goal 字段：null 或 { version, statement, criteria: [{ id, text }], parentGoalVersion }。
export function goalView(task) {
  const goal = readTaskGoal(task)
  if (!goal) return null
  const parentVersion = Number(task.goal_parent_version)
  return {
    version: goal.version,
    statement: goal.statement,
    criteria: goal.criteria.map((text, index) => ({ id: criterionId(index), text })),
    parentGoalVersion: task.goal_parent_version !== null && Number.isFinite(parentVersion) ? parentVersion : null,
  }
}

// 一次显式改目标要落的列。内容与当前 Goal 完全一致时返回 null：同值重写不产生版本，
// 否则版本号会被无意义的重写推高，引用「Goal vN」就失去了区分度。
export function goalRevisionColumns(task, goal, parentGoalVersion) {
  const current = readTaskGoal(task)
  const unchanged = current
    && current.statement === goal.statement
    && current.criteria.length === goal.criteria.length
    && current.criteria.every((line, index) => line === goal.criteria[index])
  if (unchanged) return null
  return {
    goal_statement: goal.statement,
    goal_criteria: JSON.stringify(goal.criteria),
    goal_version: (Number(task?.goal_version) || 0) + 1,
    goal_parent_version: parentGoalVersion,
  }
}

// 父任务当前 Goal 版本的快照：父卡不存在或没有 Goal 时为 null。
export function parentGoalVersionOf(store, task) {
  if (!task?.parent_task_id) return null
  const parent = store.get('SELECT goal_statement, goal_version FROM tasks WHERE id = ?', task.parent_task_id)
  if (!parent?.goal_statement) return null
  return Number(parent.goal_version) || 1
}

// 验收结论对 Goal 的引用：引用的版本号（没写为 null）与被引用的标准编号（去重，按出现顺序）。
export function parseGoalCitation(comment) {
  const source = String(comment ?? '')
  const versionMatch = source.match(/\bgoal\s+v\.?\s*(\d+)/i)
  const cited = []
  for (const match of source.matchAll(/\bC(\d{1,2})\b/gi)) {
    const id = criterionId(Number(match[1]) - 1)
    if (!cited.includes(id)) cited.push(id)
  }
  return { version: versionMatch ? Number(versionMatch[1]) : null, cited }
}
