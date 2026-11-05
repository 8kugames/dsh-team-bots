// src/services/task-relations.js —— 任务父子关系与依赖阻塞：独立迁移 + 校验 + 调度闸门查询。
//
// 口径（DSHBOTS-59）：
// - tasks.parent_task_id：同项目内引用另一任务（跨项目/自引用拒绝）。v1 只做归属记录与渲染锚点，
//   父完成不自动级联关子（明确不做自动传播）。
// - tasks.blocked_by：JSON 数组存依赖任务 id。任一依赖状态非 done/canceled 时，调度器不领取该任务
//   的 task run（run 留 queued，记一条 task_blocked_dep 事件）。依赖满足与否由调度器判断，
//   不进 transitionTask。
//
// 迁移独立成文件的原因：src/db.js 已贴 800 行红线，迁移不写进 db.js（手法与
// attention-schema.js / approvals.js 同款：schema_migrations 幂等守卫 + PRAGMA 判列 + ALTER TABLE）。
//
// 环检测的定位：createTask 的边只指向已存在的任务，服务端又生成 taskId，公共 API 路径不可能成环；
// DFS 防的是脏数据（直插库造出的互阻环挂新任务时要拒）与未来 updateTask 开放改关系时的校验复用。

import { badRequest } from '../errors.js'
import { nowIso } from '../util.js'

export const TASK_RELATIONS_MIGRATION = 'tasks_parent_blocked_by'
export const MAX_BLOCKED_BY = 20

// task-relations-pure:start — 纯函数块（无 DB 依赖，tests/task-relations.test.js 直接抽取断言）

// 依赖视为「已满足」的任务终态：done（正常完成）或 canceled（放弃，不再挡路）。
export const DEP_SATISFIED_STATUSES = new Set(['done', 'canceled'])

// 规范化外部传入的 blocked_by：必须是字符串数组；trim、去重、截到 MAX_BLOCKED_BY。
// 与 input.dependsOn 的静默 slice(0,20) 先例同款（截断不报错），但类型错误显式拒绝——
// 依赖是调度闸门的输入，静默吞掉非数组会让「以为设了依赖其实没设」的错配不可见。
export function normalizeBlockedByInput(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw badRequest('blocked_by 应为任务 id 字符串数组')
  }
  const seen = new Set()
  const ids = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw badRequest('blocked_by 的每一项应为任务 id 字符串')
    }
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    ids.push(trimmed)
    if (ids.length >= MAX_BLOCKED_BY) break
  }
  return ids
}

// 读库里的 blocked_by 列 → id 数组；坏数据（非 JSON、非数组）一律降级为 []，不抛错。
export function parseStoredBlockedBy(raw) {
  if (!raw) return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
}

// 一个任务节点的关系出边：父任务 + 全部依赖（两套边合并做环检测）。
export function relationTargets(node) {
  if (!node) return []
  return [...(node.parentTaskId ? [node.parentTaskId] : []), ...(node.blockedBy ?? [])]
}

// DFS 环检测：从待落库任务的出边（parentTaskId + blockedBy）出发沿 lookup 图走。
// - 路径上到达 taskId 本身 → 返回 'self'（新边把环闭上了）。
// - 路径上重访当前路径节点 → 返回 'cycle'（库内已有脏环，拒绝挂接）。
// - visited 记忆已探明无环的子图；DAG 菱形（两条路汇到同一节点）不误报。
export function detectRelationCycle({ taskId, parentTaskId, blockedBy, lookup }) {
  const visiting = new Set()
  const visited = new Set()
  let found = null
  const walk = (current) => {
    if (found) return
    if (current === taskId) {
      found = 'self'
      return
    }
    if (visiting.has(current)) {
      found = 'cycle'
      return
    }
    if (visited.has(current)) return
    visiting.add(current)
    const node = lookup(current)
    for (const next of relationTargets(node)) walk(next)
    visiting.delete(current)
    visited.add(current)
  }
  for (const target of relationTargets({ parentTaskId, blockedBy })) walk(target)
  return found
}

// task-relations-pure:end

// 同一个 store 只做一次迁移（WeakSet 记忆，store 生命周期内零额外查询）。
const migrated = new WeakSet()

// tasks 表加 parent_task_id / blocked_by 两列，迁移名 tasks_parent_blocked_by。
export function ensureTaskRelationsSchema(store) {
  if (!store || migrated.has(store)) return
  const columns = store.all('PRAGMA table_info(tasks)').map(column => column.name)
  if (!columns.includes('parent_task_id')) {
    store.exec('ALTER TABLE tasks ADD COLUMN parent_task_id TEXT')
  }
  if (!columns.includes('blocked_by')) {
    store.exec('ALTER TABLE tasks ADD COLUMN blocked_by TEXT')
  }
  store.run(
    "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    TASK_RELATIONS_MIGRATION,
    nowIso(),
  )
  migrated.add(store)
}

// 创建任务时校验关系（全 badRequest，中文消息直达 API 调用方）：
// 自引用拒；父/依赖必须存在且同项目；沿 parent 链与 blocked_by 图做 DFS 环检测。
// 返回可直接落库的 { parentTaskId, blockedBy }。
export function validateTaskRelations({ store, projectId, taskId, parentTaskId, blockedBy }) {
  // 空串/纯空白 parent（模板变量为空的典型产物）不得静默当「无父」：那会让子卡悄悄变顶级卡，
  // 与「立子卡挂主项」的产品意图相反。null/undefined 仍表示不挂父，正常放行。
  if (typeof parentTaskId === 'string' && !parentTaskId.trim()) {
    throw badRequest('parent_task_id 不能为空字符串：挂主项请传任务 id，不挂请省略该参数')
  }
  if (parentTaskId) {
    if (parentTaskId === taskId) throw badRequest('任务不能以自身为父任务')
    const parent = store.get('SELECT id, project_id FROM tasks WHERE id = ?', parentTaskId)
    if (!parent) throw badRequest(`父任务 ${parentTaskId} 不存在`)
    if (parent.project_id !== projectId) throw badRequest(`父任务 ${parentTaskId} 不在当前项目内`)
  }
  for (const depId of blockedBy) {
    if (depId === taskId) throw badRequest('任务不能依赖自身')
    const dep = store.get('SELECT id, project_id FROM tasks WHERE id = ?', depId)
    if (!dep) throw badRequest(`依赖任务 ${depId} 不存在`)
    if (dep.project_id !== projectId) throw badRequest(`依赖任务 ${depId} 不在当前项目内`)
  }
  const cycle = detectRelationCycle({
    taskId,
    parentTaskId,
    blockedBy,
    lookup: (id) => {
      const row = store.get('SELECT parent_task_id, blocked_by FROM tasks WHERE id = ?', id)
      if (!row) return null
      return { parentTaskId: row.parent_task_id ?? null, blockedBy: parseStoredBlockedBy(row.blocked_by) }
    },
  })
  if (cycle) throw badRequest('任务关系成环：父子链或依赖链存在循环引用')
  return { parentTaskId: parentTaskId ?? null, blockedBy }
}

// 返回 task 的未满足依赖行（id/number/status）。无依赖、任务缺失、依赖 id 悬空（已不在库）时为 []。
// 悬空 id 不挡调度：依赖记录指向不存在的任务视作历史脏数据，不构成阻塞。
export function unsatisfiedBlockedDeps(store, task) {
  const ids = parseStoredBlockedBy(task?.blocked_by)
  if (!ids.length) return []
  const marks = `(${ids.map(() => '?').join(', ')})`
  const rows = store.all(`SELECT id, number, status FROM tasks WHERE id IN ${marks}`, ...ids)
  return rows.filter(row => !DEP_SATISFIED_STATUSES.has(row.status))
}

// taskView 的依赖派生字段：blockedBy（解析后的数组）、depsSatisfied、blockedByNames（未满足依赖的
// identifier，只列还挡着路的，避免 done 之后仍显示长名单）。
export function taskDepsView(store, task, projectKey) {
  const blockedBy = parseStoredBlockedBy(task?.blocked_by)
  const unsatisfied = unsatisfiedBlockedDeps(store, task)
  return {
    blockedBy,
    depsSatisfied: unsatisfied.length === 0,
    blockedByNames: unsatisfied.map(row => `${projectKey ?? 'T'}-${row.number}`),
  }
}
