// src/services/tasks.js —— 任务与审批域
// 任务建档、状态流转、派单与评论；交付验收/退回与核验委派见 ./task-review.js。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { clampNumber, id, nowIso, projectKey, TASK_ID_PATTERN, text } from '../util.js'
import { filterIgnoredWriteScopes, parseWriteScopes, parseWriteScopesFromDescription, readWriteScopes } from './write-scopes.js'
import { ensureAttentionSchema, parseAttention } from './attention-schema.js'
import { resolveSandboxOverride, SANDBOX_OVERRIDES } from './file-policy.js'
import { ensureTaskSandboxSchema } from './task-sandbox-schema.js'
import {
  ensureTaskRelationsSchema, normalizeBlockedByInput, taskDepsView, validateTaskRelations,
} from './task-relations.js'
// 任务工单七态派生与标签口径的唯一来源：task-stage 纯函数域（tests/task-stage.test.js 断言其判定表）。
import { taskStage, taskStageLabel } from './task-stage.js'
import { effectiveTaskTimeBudgetMinutes } from '../config.js'
import { taskSubtreeIds, taskTreeUsageTotals, taskUsageTotals } from '../usage.js'

export const TASK_STATUSES = new Set(['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled'])

export const TASK_PRIORITIES = new Set(['urgent', 'high', 'medium', 'low', 'none'])

export const TRANSITIONS = {
  backlog: new Set(['todo', 'canceled']),
  todo: new Set(['backlog', 'in_progress', 'blocked', 'canceled']),
  in_progress: new Set(['todo', 'blocked', 'in_review', 'canceled']),
  blocked: new Set(['todo', 'in_progress', 'canceled']),
  in_review: new Set(['in_progress', 'done', 'canceled']),
  // 终态回流：done/canceled → backlog 是「驳回」（旧板 task-6 口径），→ todo 是「重新派单」，
  // 两条路径都在这里放行；离开终态时的活跃运行守卫见 updateTask。
  done: new Set(['todo', 'backlog']),
  canceled: new Set(['todo', 'backlog']),
}

// task-stage 域已拆至 src/services/task-stage.js（工单七态判定表 + 标签口径唯一来源），
// 此处经顶部 import 引入 taskStage/taskStageLabel 供 taskView 派生 stage/stageLabel。

// tasks 表时间列迁移（外置自管：db.js 已贴 800 行红线不再加行，approvals/message-images 同款先例）。
// canceled_at 与 completed_at 对称：进 canceled 写、离开清；老数据回填 canceled_at=updated_at，仅补空行。
export function ensureTaskTimesSchema(store) {
  if (store.get('SELECT 1 AS ok FROM schema_migrations WHERE name = ?', 'tasks_canceled_at')) return
  const columns = store.all('PRAGMA table_info(tasks)').map(row => row.name)
  if (!columns.includes('canceled_at')) {
    store.exec('ALTER TABLE tasks ADD COLUMN canceled_at TEXT')
  }
  store.run("UPDATE tasks SET canceled_at = updated_at WHERE status = 'canceled' AND canceled_at IS NULL")
  store.run('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING', 'tasks_canceled_at', nowIso())
}

// 终态时间回填（DSHBOTS-69）：只补 status 对应终态列为空的存量行，值取 updated_at；
// 幂等可重跑。canceled 侧与 tasks_canceled_at 重叠无害（同样只补空行），本迁移重点补 done 侧。
export function ensureTaskTerminalTimeBackfill(store) {
  if (store.get('SELECT 1 AS ok FROM schema_migrations WHERE name = ?', 'tasks_terminal_time_backfill')) return
  store.run("UPDATE tasks SET completed_at = updated_at WHERE status = 'done' AND completed_at IS NULL")
  store.run("UPDATE tasks SET canceled_at = updated_at WHERE status = 'canceled' AND canceled_at IS NULL")
  store.run('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING', 'tasks_terminal_time_backfill', nowIso())
}

export const tasksMethods = {
  // 缺省任务预算（DSHBOTS-198）：env > 无进展看门狗（分钟）生效值 > 兜底 20，
  // 建档补挂与重派补挂共用同一缺省链。
  defaultTaskTimeBudget() {
    return effectiveTaskTimeBudgetMinutes(this.config, key => this.store.setting(key))
  },
  async createTask(input, actor = this.actor()) {
    // DSHBOTS-237：建卡强制项目编号（项目 KEY-N）。无项目语境直接报错引导，
    // 不再允许脱离项目建卡（共享板 task-N 口径废弃：存量可读，新建一律走项目编号）。
    if (input.projectId === undefined || input.projectId === null || String(input.projectId).trim() === '') {
      throw badRequest('建卡必须归属项目：请指定项目后再建卡，任务卡编号统一为「项目 KEY-N」（如 DSHBOTS-1），不再支持无项目的共享板建卡')
    }
    const project = this.projectRow(input.projectId)
    if (project.status !== 'active') throw conflict('项目已归档')
    const title = text(input.title, 240)
    if (!title) throw badRequest('任务标题不能为空')
    const assigneeId = input.assigneeBotId || null
    if (assigneeId) this.assertDispatchTarget(project.id, assigneeId)
    const status = input.status && TASK_STATUSES.has(input.status) ? input.status : (assigneeId ? 'todo' : 'backlog')
    const priority = TASK_PRIORITIES.has(input.priority) ? input.priority : 'medium'
    // 写范围：显式传参优先（含空数组 = 明确不声明）；未传时从描述的「写范围：」行兜底解析。
    const parsedScopes = input.writeScopes === undefined || input.writeScopes === null
      ? parseWriteScopesFromDescription(input.description)
      : parseWriteScopes(input.writeScopes)
    // 时效要求（DSHBOTS-125）：发布方可传交付时限（分钟）；钳制到 1..10080（一分钟到一周）：
    // 只挡垃圾值，不替发布方做取舍；0/负数视为未提。
    // DSHBOTS-198：产品规则=每卡必有预算——未显式提时按缺省链补挂
    // （env DSH_TEAM_TASK_TIME_BUDGET_MINUTES > 看门狗分钟生效值 > 兜底 20），显式值优先不覆盖。
    // DSHBOTS-131：该任务派生运行的超时上限取 min(本字段, 全局 runTimeoutMs)，到期即超时中止。
    const rawTimeBudget = input.timeBudgetMinutes ?? input.time_budget_minutes
    const timeBudgetMinutes = (Number(rawTimeBudget) > 0 ? clampNumber(rawTimeBudget, 1, 10_080, null) : null)
      ?? this.defaultTaskTimeBudget()
    // 派发沙箱覆盖（DSHBOTS-156/234）：档位解析顺序=卡面显式声明 > bot 配置（inherit 为缺省）。
    // 'inherit'/空值同义=跟随 bot 配置档（列落 NULL）；列只收合法收紧档，垃圾值拒收。
    // 「只收紧不放大」校验在派发入口 assignFromBot（对准承接 bot 的 file_policy）。
    const rawSandboxOverride = input.sandboxOverride
    if (rawSandboxOverride !== undefined && rawSandboxOverride !== null && rawSandboxOverride !== ''
      && rawSandboxOverride !== 'inherit' && !SANDBOX_OVERRIDES.includes(rawSandboxOverride)) {
      throw badRequest(`沙箱覆盖无效，允许值：inherit / ${SANDBOX_OVERRIDES.join(' / ')}`)
    }
    const sandboxOverride = !rawSandboxOverride || rawSandboxOverride === 'inherit' ? null : rawSandboxOverride
    const taskId = id('task')
    const createdAt = nowIso()
    // 终态时间在创建时补齐（DSHBOTS-69）：以 done/canceled 建档的任务终态列取同一 createdAt，
    // 非终态两列留 NULL；与 updateTask 的对称维护（进终态写、离开清）同口径。
    const completedAt = status === 'done' ? createdAt : null
    const canceledAt = status === 'canceled' ? createdAt : null
    // 父子/依赖关系（DSHBOTS-59）：camelCase 与 snake_case 都收；taskId 服务端生成，
    // 真自引用在公共 API 层面构造不出来，validateTaskRelations 仍显式拒（防直插库与未来 update 复用）。
    const parentTaskId = input.parentTaskId ?? input.parent_task_id ?? null
    const blockedBy = normalizeBlockedByInput(input.blockedBy ?? input.blocked_by)
    ensureTaskRelationsSchema(this.store)
    ensureTaskSandboxSchema(this.store)
    let number
    this.store.transaction(() => {
      // 派单清洗（DSHBOTS-168）：ignored 机械移除 + 一级目录驳回，与建档同事务——
      // 清洗后清单即落库清单（运行快照天然继承），审计挂真实 taskId 不产生孤儿行。
      const writeScopes = this.normalizeDispatchScopes(project, parsedScopes, { actor, taskId })
      const relations = validateTaskRelations({ store: this.store, projectId: project.id, taskId, parentTaskId, blockedBy })
      number = Number(this.store.get('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE project_id = ?', project.id)?.n ?? 1)
      this.store.run(
        `INSERT INTO tasks(id, project_id, number, title, description, status, priority, assignee_bot_id,
          creator_type, creator_id, review_target, source_message_id, parent_id, parent_task_id, blocked_by, position, due_at, estimate,
          time_budget_minutes, write_scopes, sandbox_override, version, created_at, updated_at, completed_at, canceled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        taskId, project.id, number, title, text(input.description, 40_000), status, priority,
        assigneeId, actor.type, actor.id, actor.type === 'bot' ? 'owner_bot' : 'user',
        input.sourceMessageId ?? null, input.parentId ?? null,
        relations.parentTaskId, JSON.stringify(relations.blockedBy),
        Number.isFinite(Number(input.position)) ? Number(input.position) : number,
        input.dueAt ? new Date(input.dueAt).toISOString() : null,
        clampNumber(input.estimate, 0, 1000, null), timeBudgetMinutes, JSON.stringify(writeScopes),
        sandboxOverride, createdAt, createdAt,
        completedAt, canceledAt,
      )
      for (const label of Array.isArray(input.labels) ? input.labels.slice(0, 12) : []) {
        const clean = text(label, 40).toLowerCase()
        if (clean) this.store.run('INSERT OR IGNORE INTO task_labels(task_id, label) VALUES (?, ?)', taskId, clean)
      }
      for (const dependency of Array.isArray(input.dependsOn) ? input.dependsOn.slice(0, 20) : []) {
        if (dependency !== taskId && this.store.get('SELECT id FROM tasks WHERE id = ? AND project_id = ?', dependency, project.id)) {
          this.store.run('INSERT OR IGNORE INTO task_dependencies(task_id, depends_on_task_id) VALUES (?, ?)', taskId, dependency)
        }
      }
      this.addTaskEvent(taskId, 'created', actor, { status, assigneeBotId: assigneeId })
      this.audit(actor, 'task.create', 'task', taskId, { title, assigneeId, status })
    })
    if (input.postCard !== false) {
      this.insertMessage({
        projectId: project.id,
        senderType: 'system',
        senderId: 'system',
        body: `任务 ${project.key}-${number} 已创建${assigneeId ? ` → @${this.botRow(assigneeId).name}` : ''}`
          // 紧急豁免报备（DSHBOTS-126）：urgent 与在办卡共用车道时在同一条创建消息里注明，不静默并行。
          + (input.laneShareTask ? `；紧急豁免：与在办卡 ${input.laneShareTask} 共用写范围车道，立即开工` : ''),
        taskId,
      })
    }
    if (input.autoStart && assigneeId) {
      this.enqueueOutbox({
        kind: 'task_run',
        payload: { taskId, triggerType: 'task_created' },
        projectId: project.id,
        taskId,
        idempotencyKey: `task:${taskId}:task_created`,
      })
    }
    // 微信推送闭环（DSHBOTS-182 增补）：创建成功即推一条（KEY-N/标题/派给谁），
    // 与完成推送同锚定一次性事件（创建是单次 INSERT），交付节点仍不推。
    this.notifyTaskCreated(this.taskRow(taskId))
    void this.tick()
    return this.taskView(this.taskRow(taskId))
  },
  addTaskEvent(taskId, type, actor, data = {}) {
    this.store.run(
      'INSERT INTO task_events(id, task_id, type, actor_type, actor_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id('tevt'), taskId, type, actor.type, actor.id, JSON.stringify(data), nowIso(),
    )
  },
  taskView(task) {
    // attention_json 列由 attention 域自管迁移（db.js 不加行），读视图前懒迁移一次。
    // parent_task_id/blocked_by 同款：task-relations 域自管迁移 + 依赖派生字段。
    ensureAttentionSchema(this.store)
    ensureTaskRelationsSchema(this.store)
    const labels = this.store.all('SELECT label FROM task_labels WHERE task_id = ? ORDER BY label', task.id).map(row => row.label)
    // error_code='SUPERSEDED' 是管理清理冗余运行的标记，不是真实执行历史；latestRun 与 runs 历史同口径排除。
    const runs = this.store.all(
      "SELECT id, kind, status, attempt, started_at, ended_at, error_code, error_message, attention_json FROM runs WHERE task_id = ? AND COALESCE(error_code, '') <> 'SUPERSEDED' ORDER BY queued_at DESC LIMIT 10",
      task.id,
    )
    const project = this.store.get('SELECT key FROM projects WHERE id = ?', task.project_id)
    const { write_scopes: rawScopes, time_budget_minutes: rawTimeBudget, ...rest } = task
    // 阶段按事实推导（task-stage 块）：与 latestRun 同源；attention 取最近运行的待回答提问。
    const attention = runs[0] ? parseAttention(runs[0].attention_json) : null
    const stage = taskStage(task, runs[0] ?? null, attention)
    const deps = taskDepsView(this.store, task, project?.key)
    return {
      ...rest,
      identifier: `${project?.key ?? 'T'}-${task.number}`,
      labels,
      writeScopes: readWriteScopes(rawScopes),
      // 时效要求（分钟）：null=发布方未提；供 UI 展示与提示词注入共用一个口径。
      timeBudgetMinutes: Number.isFinite(rawTimeBudget) ? rawTimeBudget : null,
      attention,
      blockedBy: deps.blockedBy,
      depsSatisfied: deps.depsSatisfied,
      blockedByNames: deps.blockedByNames,
      comments: Number(this.store.get('SELECT COUNT(*) AS count FROM task_comments WHERE task_id = ?', task.id)?.count ?? 0),
      latestRun: runs[0] ?? null,
      runs,
      stage,
      stageLabel: taskStageLabel(stage),
      reviewStatus: this.taskReviewStatus(task),
      // 验收滞留同源视图（DSHBOTS-235）：锚点/阈值/最近判定由 review-watchdog 域统一供出，
      // UI badge 与后端守门同一口径（H3），面板据此展示三档判定与依据。
      reviewIdle: task.status === 'in_review' ? this.reviewIdleView(task) : null,
    }
  },

  // 核验状态（DSHBOTS-113）：none=未核验 / pending=核验中（委派运行在跑或自动委派待投递）/
  // done=本次交付已有核验结论 / failed=核验失败（运行失败或自动委派重试耗尽）。
  // 以「最近一次成功的执行运行」（本次交付）为基准，只认其后发起的核验，避免上一轮
  // 交付的旧结论被误读为本轮已核验。自动流程失败必须在 UI 可见（防静默漏审）。
  taskReviewStatus(task) {
    const delivery = this.store.get(
      "SELECT queued_at FROM runs WHERE task_id = ? AND kind = 'task' AND status = 'succeeded' AND COALESCE(error_code, '') <> 'SUPERSEDED' ORDER BY ended_at DESC LIMIT 1",
      task.id,
    )
    if (!delivery) return 'none'
    const activeRun = this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND trigger_type = 'review_delegate' AND status IN ('queued', 'running') AND queued_at >= ?",
      task.id, delivery.queued_at,
    )
    if (activeRun) return 'pending'
    const pendingSpawn = this.store.get(
      "SELECT id FROM outbox WHERE kind = 'review_delegate_auto' AND task_id = ? AND status = 'pending' AND created_at >= ?",
      task.id, delivery.queued_at,
    )
    if (pendingSpawn) return 'pending'
    const latest = this.store.get(
      "SELECT status FROM runs WHERE task_id = ? AND trigger_type = 'review_delegate' AND queued_at >= ? ORDER BY queued_at DESC LIMIT 1",
      task.id, delivery.queued_at,
    )
    if (latest) {
      if (latest.status === 'succeeded') return 'done'
      if (latest.status === 'failed') return 'failed'
      return 'none'
    }
    const failedSpawn = this.store.get(
      "SELECT id FROM outbox WHERE kind = 'review_delegate_auto' AND task_id = ? AND status = 'failed' AND created_at >= ?",
      task.id, delivery.queued_at,
    )
    if (failedSpawn) return 'failed'
    return 'none'
  },
  // options.startTriggerType：进入「进行中」时给运行用的触发类型标签（看板拖拽沿用 D-54 的 board_resume，
  // 其余路径默认 task_started）。只影响运行元数据与幂等键，不影响行为口径。
  async updateTask(taskId, patch, actor = this.actor(), options = {} as any) {
    const task = this.taskRow(taskId)
    if (patch.version !== undefined && Number(patch.version) !== Number(task.version)) {
      throw conflict('任务已被其他人更新，请刷新后重试')
    }
    const updates: any = {}
    if (patch.title !== undefined) {
      const title = text(patch.title, 240)
      if (!title) throw badRequest('任务标题不能为空')
      updates.title = title
    }
    if (patch.description !== undefined) updates.description = text(patch.description, 40_000)
    if (patch.priority !== undefined) {
      if (!TASK_PRIORITIES.has(patch.priority)) throw badRequest('优先级无效')
      updates.priority = patch.priority
    }
    if (patch.assigneeBotId !== undefined) {
      if (patch.assigneeBotId) this.assertDispatchTarget(task.project_id, patch.assigneeBotId)
      updates.assignee_bot_id = patch.assigneeBotId || null
    }
    if (patch.position !== undefined) updates.position = Number(patch.position) || 0
    if (patch.dueAt !== undefined) updates.due_at = patch.dueAt ? new Date(patch.dueAt).toISOString() : null
    if (patch.estimate !== undefined) updates.estimate = clampNumber(patch.estimate, 0, 1000, null)
    if (patch.writeScopes !== undefined) {
      updates.write_scopes = JSON.stringify(parseWriteScopes(patch.writeScopes))
    }
    if (patch.status !== undefined) {
      if (!TASK_STATUSES.has(patch.status)) throw badRequest('任务状态无效')
      this.assertTransition(task.status, patch.status)
      // 离开终态的活跃运行守卫：终态任务上可能还挂着未结束的派生运行（核验/受阻处理），
      // 直接驳回/重开会让任务状态与运行事实脱节，先要求把运行停干净。
      // 口径沿用 spawnReviewDelegate / assignTask 的活跃运行判定（queued/running 即算）。
      if (['done', 'canceled'].includes(task.status) && !['done', 'canceled'].includes(patch.status)) {
        const active = this.store.get(
          "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
          taskId,
        )
        if (active) throw conflict('任务还有运行在排队或执行，请先停止再变更状态')
      }
      updates.status = patch.status
      // 终态时间戳对称维护：进 done/canceled 各写对应列，离开任一终态即清空，两列互斥。
      updates.completed_at = patch.status === 'done' ? nowIso() : null
      updates.canceled_at = patch.status === 'canceled' ? nowIso() : null
    }
    if (Object.keys(updates).length === 0) return this.taskView(task)
    this.store.transaction(() => {
      const fields = Object.entries(updates).map(([key]) => `${key} = ?`)
      this.store.run(
        `UPDATE tasks SET ${fields.join(', ')}, version = version + 1, updated_at = ? WHERE id = ?`,
        ...Object.values(updates), nowIso(), taskId,
      )
      for (const field of Object.keys(updates)) {
        const type = field === 'status' ? 'status' : field === 'assignee_bot_id' ? 'assigned' : 'updated'
        this.addTaskEvent(taskId, type, actor, { field, from: task[field] ?? null, to: updates[field] })
      }
      if (patch.labels !== undefined && Array.isArray(patch.labels)) {
        this.store.run('DELETE FROM task_labels WHERE task_id = ?', taskId)
        for (const label of patch.labels.slice(0, 12)) {
          const clean = text(label, 40).toLowerCase()
          if (clean) this.store.run('INSERT OR IGNORE INTO task_labels(task_id, label) VALUES (?, ?)', taskId, clean)
        }
      }
      this.audit(actor, 'task.update', 'task', taskId, updates)
    })
    // 终态清理（DSHBOTS-110）：任务进入 done/canceled 时先把残留的 queued 运行置 SUPERSEDED，
    // 再释放写占用——写占用只清 mode='write' 会漏掉排队的只读运行（审查等），被调度器后续起跑执行。
    if (updates.status && updates.status !== task.status && (updates.status === 'done' || updates.status === 'canceled')) {
      this.cancelSupersededQueuedRuns(taskId)
    }
    // 写占用释放（DSHBOTS-73，用户口径）：任务状态离开「进行中」就中止它名下仍在跑/排队的写运行，
    // 写占用/锁定随之解除。单一触发点：所有任务状态变更都经过 updateTask 这一处，不在别处散着写。
    if (updates.status && updates.status !== task.status && updates.status !== 'in_progress') {
      await this.releaseTaskWriteLocks(taskId, { fromStatus: task.status, toStatus: updates.status })
    }
    if (updates.status === 'canceled') await this.cancelRunsForTask(taskId)
    // 进入「进行中」的统一联动（DSHBOTS-100）：任何路径让任务进入「进行中」且有负责人，
    // 都要通知负责人并真的开工。单一触发点：所有状态变更都经过 updateTask 这一处，
    // 看板拖拽（transition_task）、编辑表单改状态（update_task）、总监退回重做都从这里过，
    // 同一任务只会发一条消息、只入队一次运行。
    if (updates.status === 'in_progress' && task.status !== 'in_progress') {
      this.notifyTaskStarted(this.taskRow(taskId), { triggerType: options.startTriggerType ?? 'task_started' })
    }
    // 微信推送收敛（DSHBOTS-182）：只在任务真正完成（→done 转换）时推一条，
    // 全部 done 转换路径都经 updateTask 收口在此；done→done 不构成转换，天然不重复推。
    if (updates.status === 'done' && task.status !== 'done') {
      this.notifyTaskDone(this.taskRow(taskId))
    }
    // 任务卡修正闭环（DSHBOTS-232 ①）：已派单卡的卡面（标题/描述/优先级/写范围）实际变值时
    // 通知负责人修正。只认卡面字段——状态/负责人等流转字段各有自己的通知口径，不在此重复；
    // 值未变的字段（同值重写）不触发。
    if (task.assignee_bot_id) {
      const cardChanged = ['title', 'description', 'priority'].some(
        field => updates[field] !== undefined && updates[field] !== task[field],
      ) || (updates.write_scopes !== undefined
        && JSON.stringify(readWriteScopes(updates.write_scopes)) !== JSON.stringify(readWriteScopes(task.write_scopes)))
      if (cardChanged) await this.notifyTaskCardChanged(this.taskRow(taskId))
    }
    return this.taskView(this.taskRow(taskId))
  },
  // 写占用释放（DSHBOTS-73，用户口径）：写范围占用只看「进行中」的任务，
  // 任务一旦离开「进行中」就立刻解除占用/锁定——中止它名下仍在跑/排队的写运行，
  // 写槽让给同项目其他写运行（调度器侧另有 write-lock-scope 闸门兜底）。
  // 只停写运行：只读运行（验收/受阻处理/记忆复盘）不停，否则会打断验收流程。
  // 看板拖出到 todo/blocked 沿用既有暂停口径（PAUSED_BY_BOARD + board_pause 事件），其余目的地用稳定码。
  async releaseTaskWriteLocks(taskId, { fromStatus = null, toStatus = null } = {}) {
    if (fromStatus === 'in_progress' && (toStatus === 'todo' || toStatus === 'blocked')) {
      // 看板暂停路径：取消该任务全部在跑/排队运行并写 PAUSED_BY_BOARD（DSHBOTS-54 既有口径）。
      return await this.pauseRunsForBoard(taskId)
    }
    const runs = this.store.all(
      "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running') AND mode = 'write'",
      taskId,
    )
    const errorMessage = `任务离开「进行中」（${fromStatus ?? '-'} → ${toStatus ?? '-'}），写运行中止，写占用已释放`
    for (const run of runs) {
      await this.cancelRunInternal(run.id, false)
      this.store.run(
        'UPDATE runs SET error_code = ?, error_message = ? WHERE id = ?',
        'TASK_LEFT_IN_PROGRESS', errorMessage, run.id,
      )
      this.insertRunEvent(run.id, 'task_left_in_progress', errorMessage)
    }
    return runs.length
  },
  // 终态清理（DSHBOTS-110）：任务流转到 done/canceled 时，把该任务残留的 queued 运行全部置
  // canceled（SUPERSEDED + stale_superseded 事件），防止调度窗口内漏网的排队运行被起跑执行。
  // 只清 queued：running 的写运行由 releaseTaskWriteLocks 按 TASK_LEFT_IN_PROGRESS 口径处理。
  // 清理任务名下的排队运行（SUPERSEDED 口径）。体内纯同步 store 调用、无 await，
  // 因此是同步函数：调用点可直接放进事务，抛错即回滚，不会出现「事务已提交但清理失败」的静默态。
  cancelSupersededQueuedRuns(taskId) {
    const rows = this.store.all(
      "SELECT id FROM runs WHERE task_id = ? AND status = 'queued'",
      taskId,
    )
    let canceled = 0
    for (const row of rows) {
      if (this.cancelQueuedRunAsSuperseded(row.id)) canceled += 1
    }
    return canceled
  },
  assertTransition(from, to) {
    if (from === to) return
    if (!TRANSITIONS[from]?.has(to)) throw conflict(`任务不能从 ${from} 变为 ${to}`)
  },
  // 派发门禁（DSHBOTS-262）：暂停中的 Bot 不接新卡——新建派单、改派、重派一律拒绝，
  // 先恢复（bot status → active）再派；归档/移除等其余不可用态沿用 assertMember 既有口径。
  assertDispatchTarget(projectId, botId) {
    const bot = this.store.get('SELECT name, status FROM bots WHERE id = ?', botId)
    if (bot?.status === 'paused') throw badRequest(`Bot ${bot.name} 已暂停，先恢复再派卡`)
    this.assertMember(projectId, botId)
  },
  // sandboxOverride 选项（DSHBOTS-156）：undefined=不动（重派未传 sandbox 时保留旧覆盖）；
  // null=显式清掉回落 bot 配置档（重派传 sandbox='inherit'）；字符串=收紧档（派发入口已校验）。
  async assignTask(taskId, botId, actor = this.actor(), { autoStart = true, sandboxOverride } = {} as any) {
    const task = this.taskRow(taskId)
    const project = this.projectRow(task.project_id)
    this.assertDispatchTarget(project.id, botId)
    const active = this.store.get(
      "SELECT id, kind FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      taskId,
    )
    // 换负责人闸门（DSHBOTS-169）：queued 占位运行（死队列，永远不会被领取）不是执行中，
    // 不再阻断改派——事务内按 SUPERSEDED 口径清掉后放行；只有 running 的任务运行照旧阻断
    // （文案不变）。同负责人重派不走此闸，行为不变。
    const reassigning = task.assignee_bot_id !== botId
    if (reassigning && this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND kind = 'task' AND status = 'running' LIMIT 1",
      taskId,
    )) throw conflict('任务有正在执行的运行，不能更换负责人')
    const supersedeQueued = reassigning && !!this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND kind = 'task' AND status = 'queued' LIMIT 1",
      taskId,
    )
    ensureTaskSandboxSchema(this.store)
    const sandboxTouched = sandboxOverride !== undefined
    // 存量 NULL 预算卡补挂（DSHBOTS-198）：COALESCE 只补空，显式已设的卡不覆盖。
    const defaultTimeBudget = this.defaultTaskTimeBudget()
    this.store.transaction(() => {
      // queued 占位清理与改派同事务（DSHBOTS-169）：SUPERSEDED 不进任务执行历史，run 事件可审计。
      // 助手是同步函数（体内无 await），抛错会让整个事务回滚，不会留下「改派已生效但占位还在」的半成品。
      if (supersedeQueued) this.cancelSupersededQueuedRuns(taskId)
      this.store.run(
        `UPDATE tasks SET assignee_bot_id = ?, review_target = ?,
          status = CASE WHEN status IN ('backlog', 'blocked') THEN 'todo' ELSE status END,
          time_budget_minutes = COALESCE(time_budget_minutes, ?),
          version = version + 1, updated_at = ?${sandboxTouched ? ', sandbox_override = ?' : ''} WHERE id = ?`,
        ...(sandboxTouched
          ? [botId, actor.type === 'bot' ? 'owner_bot' : 'user', defaultTimeBudget, nowIso(), sandboxOverride ?? null, taskId]
          : [botId, actor.type === 'bot' ? 'owner_bot' : 'user', defaultTimeBudget, nowIso(), taskId]),
      )
      this.addTaskEvent(taskId, 'assigned', actor, {
        botId,
        ...(sandboxTouched && { sandbox: sandboxOverride ?? 'inherit' }),
      })
      this.audit(actor, 'task.assign', 'task', taskId, { botId, ...(sandboxTouched && { sandbox: sandboxOverride ?? 'inherit' }) })
    })
    // 总监bot的验收/受阻处理运行本身占用任务的唯一活动运行名额，
    // 此时由 finishRun 的收尾逻辑负责重新排队执行，这里跳过。
    // 换负责人清掉 queued 占位后名额已空：重算判定才会按新负责人重排 task_run（DSHBOTS-169）。
    // 幂等键：task_run 是先写者赢闸（ON CONFLICT DO NOTHING 且撞键不再 applyOutboxRow），
    // 稳定键 task:<id>:assigned 会在再次改派时撞上历史 delivered 行而被静默吞掉、排不出新运行
    // （不限清 queued 占位场景，无活跃运行的改派同样会写键）。凡换负责人一律带事务内单调自增
    // 的 task.version 后缀（确定性、跨改派不碰撞）；同负责人重派保持稳定键，slotHeld 已提供幂等。
    const slotHeld = supersedeQueued
      ? this.store.get(
        "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
        taskId,
      )
      : active
    if (!slotHeld) {
      const assignedVersion = reassigning ? this.taskRow(taskId).version : null
      this.enqueueOutbox({
        kind: 'task_run',
        payload: { taskId, triggerType: 'assigned' },
        projectId: task.project_id,
        taskId,
        idempotencyKey: `task:${taskId}:assigned${assignedVersion === null ? '' : `:v${assignedVersion}`}`,
      })
    }
    if (autoStart) void this.tick()
    return this.taskView(this.taskRow(taskId))
  },
  async transitionTask(taskId, status, actor = this.actor()) {
    const before = this.taskRow(taskId)
    // 离开「进行中」前的活跃运行数：运行中止已由 updateTask 内的写占用释放统一完成，
    // 这里只按中止条数决定要不要发看板暂停的系统指令消息，避免同一处中止被算两遍。
    const activeRuns = Number(this.store.get(
      "SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      taskId,
    )?.n ?? 0)
    // 看板拖拽沿用 D-54 的运行触发类型（board_resume）：拖入「执行中」的通知与开工由
    // updateTask 内的统一触发点完成（同一任务只发一条消息、只入队一次运行）。
    await this.updateTask(taskId, { status }, actor, { startTriggerType: 'board_resume' })
    await this.applyBoardDragDirective(before, status, { activeRuns })
    // 重新取数：拖拽联动可能刚入队或暂停了运行，沿用 updateTask 的返回会带过期的 latestRun。
    return this.taskView(this.taskRow(taskId))
  },

  // 看板拖拽联动（DSHBOTS-54）：拖出到 todo/blocked 自动暂停。
  // 拖入「执行中」一侧的通知与开工已收进 updateTask 内的统一触发点（DSHBOTS-100）：
  // blocked/in_review → in_progress 与编辑表单改状态同样要通知并开工，逻辑只有那一处，
  // 这里不再重复发消息、重复入队（同一任务只发一条）。
  // 指令消息由系统直接发（sender_type='system'，不触发 bot 运行）；
  // 出向 in_review/done/canceled 的写运行中止由 updateTask 内的写占用释放统一处理（DSHBOTS-73）。
  async applyBoardDragDirective(before, afterStatus, { activeRuns = 0 } = {}) {
    if (before.status === afterStatus) return
    if (before.status === 'in_progress' && (afterStatus === 'todo' || afterStatus === 'blocked')) {
      // 运行中止已由 updateTask 内的写占用释放统一完成（同一处处理），这里只按中止条数发系统指令消息。
      if (activeRuns > 0) {
        const project = this.projectRow(before.project_id)
        this.insertMessage({
          projectId: before.project_id,
          senderType: 'system',
          senderId: 'system',
          taskId: before.id,
          body: `任务 ${project.key}-${before.number} 已移出执行中，运行已暂停。`,
        })
      }
    }
  },
  // 总监强制受阻（DSHBOTS-232 ②）：把「进行中」任务强制移「受阻」并中止其名下全部
  // 排队/执行中运行。运行中止走既有 abort 链路（cancelRunInternal → runtime.cancelRun），
  // 与看板暂停（PAUSED_BY_BOARD，可续跑的暂停语义）区分：强制受阻是中止语义，
  // 稳定码 TASK_FORCE_BLOCKED + run 事件 force_blocked + 审计 task.force_blocked 留痕。
  // 先停运行再改状态：状态变更经 updateTask 单一触发点，此时活跃运行已清空，
  // 不会落进看板暂停分支造成双重口径。
  async forceBlockTask(taskId, actor = this.actor()) {
    const task = this.taskRow(taskId)
    if (task.status !== 'in_progress') throw conflict(`任务不在进行中，不能强制受阻（当前 ${task.status}）`)
    const runs = this.store.all(
      "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      taskId,
    )
    const stoppedRuns = []
    for (const run of runs) {
      await this.cancelRunInternal(run.id, false)
      this.store.run(
        'UPDATE runs SET error_code = ?, error_message = ? WHERE id = ?',
        'TASK_FORCE_BLOCKED', '总监强制移为受阻，运行中止', run.id,
      )
      this.insertRunEvent(run.id, 'force_blocked', '总监强制受阻，运行中止')
      stoppedRuns.push(run.id)
    }
    await this.updateTask(taskId, { status: 'blocked' }, actor)
    this.audit(actor, 'task.force_blocked', 'task', taskId, { stoppedRuns })
    const project = this.projectRow(task.project_id)
    this.insertMessage({
      projectId: task.project_id,
      senderType: 'system',
      senderId: 'system',
      taskId,
      body: `任务 ${project.key}-${task.number} 被总监强制移为受阻，运行已中止。`,
    })
    return this.taskView(this.taskRow(taskId))
  },
  // 总监会话入口（team_block_task 工具）：与 reviewFromBot 同款 owner 校验。
  async forceBlockFromBot(sessionId, input) {
    const { project, actor } = this.ownerContextFor(sessionId)
    const task = this.resolveBotTask(project, input.task)
    return this.forceBlockTask(task.id, actor)
  },
  async addComment(taskId, bodyInput, actor = this.actor()) {
    const task = this.taskRow(taskId)
    const body = text(bodyInput, 20_000)
    if (!body) throw badRequest('评论不能为空')
    const commentId = id('cmt')
    this.store.transaction(() => {
      this.store.run(
        'INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        commentId, taskId, actor.type, actor.id, body, nowIso(),
      )
      this.addTaskEvent(taskId, 'commented', actor, { commentId })
      this.audit(actor, 'task.comment', 'task', taskId, { commentId })
    })
    const comment = this.store.get('SELECT * FROM task_comments WHERE id = ?', commentId)
    const steered = await this.steerRunningTaskRun(task, comment, actor)
    return { ...comment, steered }
  },

  // 任务运行期间的评论直接投递给正在执行的会话，避免只能等下一次运行才被读到。
  async steerRunningTaskRun(task, comment, actor) {
    if (!this.runtime?.steer || actor.type === 'bot') return false
    const run = this.store.get(
      "SELECT * FROM runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      task.id,
    )
    if (!run?.session_id) return false
    const project = this.store.get('SELECT key FROM projects WHERE id = ?', task.project_id)
    const author = this.actorName(actor)
    try {
      await this.runtime.steer(
        run.session_id,
        `New comment on ${project?.key ?? 'TASK'}-${task.number} from ${author}:\n${comment.body}\n\nIf this changes the plan, adjust the work in progress; otherwise keep going and mention it in the delivery report.`,
      )
      this.store.run(
        'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
        id('evt'), run.id, 'steered', `评论直通（${author}）`, nowIso(),
      )
      return true
    } catch (error) {
      this.logger.warn?.('dsh-team: steer run %s failed: %s', run.id, error)
      return false
    }
  },
  enqueueTaskRun(task, triggerType, actor) {
    if (!task.assignee_bot_id) throw badRequest('任务没有负责人')
    if (task.status === 'done' || task.status === 'canceled') throw conflict('已完成或取消的任务不能运行')
    const active = this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      task.id,
    )
    if (active) return active.id
    const runId = id('run')
    const createdAt = nowIso()
    // 写范围在入队时快照：任务后续改声明不影响已排队的运行。
    const writeScopes = JSON.stringify(readWriteScopes(task.write_scopes))
    // DSHBOTS-241：额度耗尽期内派发不撞墙——主 provider 耗尽时直接走备用模型；
    // 未配备用或备用同样耗尽则留 queued 等恢复（调度器按额度状态放行，恢复后自动回主模型）。
    const bot = this.store.get(
      'SELECT id, status, provider, fallback_provider, fallback_model, fallback_effort FROM bots WHERE id = ?',
      task.assignee_bot_id,
    )
    // 暂停/归档的负责人不创建任务运行（DSHBOTS-262）：派发入口已拒绝，这里兜住
    // 「入队后负责人被暂停」的 pending task_run 补投——静默丢弃，口径同 chat_run 的 apply 闸门。
    if (!bot || bot.status !== 'active') return null
    const routing = this.quotaRoutingForBot(bot)
    const fallbackProvider = routing.mode === 'fallback' ? routing.provider : null
    const fallbackModel = routing.mode === 'fallback' ? routing.model : null
    const fallbackEffort = routing.mode === 'fallback' ? routing.effort : null
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, write_scopes, model_provider, model_model, model_effort, queued_at)
       VALUES (?, ?, ?, ?, 'task', 'write', ?, ?, 'queued', 1, ?, ?, ?, ?, ?, ?)`,
      runId, task.project_id, task.assignee_bot_id, task.id, triggerType, task.id,
      `task:${task.id}:${Date.now()}:${runId}`, writeScopes, fallbackProvider, fallbackModel, fallbackEffort, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'queued', `由 ${actor.type}:${actor.id} 触发`, createdAt,
    )
    if (routing.mode === 'fallback') {
      this.insertRunEvent(
        runId,
        'quota_fallback',
        `主 provider 额度耗尽，本次直接走备用模型 ${routing.ref}（预计 ${this.botQuotaState(bot.id, bot.provider)?.resetAt ?? '未知'} 恢复）`,
      )
    } else if (routing.mode === 'wait') {
      this.insertRunEvent(
        runId,
        'quota_wait',
        `主 provider 额度耗尽且无可用备用模型，排队等待至 ${routing.resetAt ?? '恢复'}`,
      )
    }
    if (triggerType === 'board_resume') {
      this.insertRunEvent(runId, 'board_resume', '看板拖入执行中，系统指令自动开工')
    }
    return runId
  },
  enqueueOwnerTaskRun(task, kind) {
    const project = this.projectRow(task.project_id)
    const owner = project.owner_bot_id
      ? this.store.get("SELECT * FROM bots WHERE id = ? AND status = 'active'", project.owner_bot_id)
      : null
    if (!owner) return null
    const active = this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      task.id,
    )
    if (active) return active.id
    const runId = id('run')
    const createdAt = nowIso()
    const triggerType = kind === 'review' ? 'review_requested' : 'blocked_handoff'
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, ?, ?, 'read', ?, ?, 'queued', 1, ?, ?)`,
      runId, project.id, owner.id, task.id, kind, triggerType, task.id,
      `${kind}:${task.id}:${Date.now()}:${runId}`, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'queued',
      kind === 'review' ? '任务交付，转总监验收' : '任务受阻，转总监处理',
      createdAt,
    )
    void this.tick()
    return runId
  },
  resolveBotTask(project, ref) {
    const raw = String(ref ?? '').trim()
    if (!raw) throw badRequest('缺少任务编号')
    let task
    if (raw.startsWith('task_')) {
      task = this.store.get('SELECT * FROM tasks WHERE id = ? AND project_id = ?', raw, project.id)
    } else {
      const match = raw.match(/^(?:([A-Za-z][A-Za-z0-9]*)-)?(\d+)$/)
      if (match && (!match[1] || match[1].toLowerCase() === project.key.toLowerCase())) {
        task = this.store.get('SELECT * FROM tasks WHERE project_id = ? AND number = ?', project.id, Number(match[2]))
      }
    }
    if (!task) throw notFound(`找不到任务 ${raw}`)
    return task
  },
  ownerContextFor(sessionId) {
    const binding = this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
    if (!binding) throw forbidden('只有项目群中的 Bot 可以执行该操作')
    if (!binding.project_id) throw forbidden('单聊会话不在项目中，无法管理任务')
    const project = this.projectRow(binding.project_id)
    if (project.owner_bot_id !== binding.bot_id) throw forbidden('只有项目总监 Bot 可以执行该操作')
    return { binding, project, actor: { type: 'bot', id: binding.bot_id } }
  },
  // 派单侧同写范围重复检测（DSHBOTS-82）：同一文件上叠 N 张小卡时，各卡各立各排，
  // 后面的卡只能等前一张跑完，形成排队空转。这里在派单入口找「写范围完全一致」的同项目在办卡。
  // 只比完全一致（集合相等，顺序无关）；相交但不同的放行——那属于正常的串行依赖，
  // 正确性由调度器写范围闸门保证，不在派单入口拦截。
  findDuplicateScopeTask(projectId, scopes) {
    const target = new Set(scopes)
    if (!target.size) return null
    const candidates = this.store.all(
      `SELECT id, number, title, write_scopes FROM tasks
        WHERE project_id = ? AND status IN ('todo', 'in_progress', 'blocked')`,
      projectId,
    )
    for (const row of candidates) {
      const other = readWriteScopes(row.write_scopes)
      if (other.length !== target.size) continue
      if ([...target].every(scope => other.includes(scope))) return row
    }
    return null
  },
  // 派单清洗（DSHBOTS-168）：写范围声明的程序化质量闸门，三入口共用——
  // createTask（owner 派单路径权威清洗）、assignFromBot（经 createTask 同一清洗）、
  // taskUpdateScopes（改卡入口）。两步：
  // ① ignored 机械移除——命中项目 .gitignore 的条目没有写保护价值，剔除并落审计
  //   task.scopes_normalize（removed=[...]）；全部被移除后调用方各自的「必须声明写
  //   范围」闸门自然接管（清单为空）。非 git 目录 / git 不可用时保守放行不清洗。
  // ② 一级目录驳回——清洗后仍不含 / 的条目（src、tests 这类整目录声明）直接拒绝：
  //   整目录会把同项目全部写运行判为冲突锁死并发，这不是清洗能救的，必须改卡。
  normalizeDispatchScopes(project, scopes, { actor, taskId }) {
    const { kept, removed } = filterIgnoredWriteScopes(scopes, this.projectWorkDir(project))
    if (removed.length) this.audit(actor, 'task.scopes_normalize', 'task', taskId, { removed })
    const bare = kept.filter(scope => !scope.includes('/'))
    if (bare.length) {
      throw badRequest(
        `写范围不能声明整目录：${bare.join('、')} —— 写范围必须声明到二级路径或具体文件，`
        + '整目录声明会锁死同项目全部写运行。',
      )
    }
    return kept
  },
  async assignFromBot(sessionId, input) {
    const { project, actor } = this.ownerContextFor(sessionId)
    const member = this.membersOf(project.id).find(bot => bot.name.toLowerCase() === String(input.assignee ?? '').toLowerCase())
    if (!member) throw badRequest(`项目中没有 Bot ${input.assignee}`)
    // 派发沙箱覆盖（DSHBOTS-156）：可选 sandbox 只收紧不放大，校验对准承接 bot 的配置档；
    // 缺省 = 跟随 bot 配置（新卡 NULL/重派保留旧值），'inherit' 显式回落 bot 配置（重派清覆盖）。
    const sandboxOverride = input.sandbox === undefined
      ? undefined
      : resolveSandboxOverride(this.botRow(member.id), input.sandbox)
    if (input.taskId || input.task) {
      const task = this.resolveBotTask(project, input.taskId ?? input.task)
      if (['done', 'canceled'].includes(task.status)) throw conflict(`任务 ${project.key}-${task.number} 已结束，不能重派`)
      // 任务卡修正闭环（DSHBOTS-232 ①）：重派可同时改卡面（标题/描述/优先级）——先经
      // updateTask 落卡，卡面变化由其统一触发点通知负责人修正，再走原重派链路。
      // 写范围不在此口改：入队运行快照与调度闸门消费的不是同一份数据，
      // 改范围走工作台 taskUpdateScopes（含排队运行快照同步），不在这里开第二入口。
      const patch: any = {}
      if (input.title !== undefined) patch.title = input.title
      if (input.description !== undefined) patch.description = input.description
      if (input.priority !== undefined) patch.priority = input.priority
      if (Object.keys(patch).length) await this.updateTask(task.id, patch, actor)
      const updated = await this.assignTask(task.id, member.id, actor, { autoStart: false, sandboxOverride })
      void this.tick()
      return updated
    }
    // 派单必须声明写范围（程序化闸门，不靠派单方自觉）：未声明写范围的任务其写运行会与
    // 同项目所有写运行判为冲突并保守串行，一条空范围任务就能把整队堵死。这里直接拒绝，
    // 而不是留到调度器里把并发能力悄悄吃掉。
    const parsedScopes = input.write_scopes === undefined || input.write_scopes === null
      ? parseWriteScopesFromDescription(input.description)
      : parseWriteScopes(input.write_scopes)
    // 闸门按清洗后清单预判（DSHBOTS-168）：全部命中忽略规则 = 实际未声明，落上面的
    // 拒绝。原清单透传 createTask 做权威清洗+审计（审计需真实 taskId），此处只预览不落账。
    const scopes = filterIgnoredWriteScopes(parsedScopes, this.projectWorkDir(project)).kept
    if (!scopes.length) {
      throw badRequest(
        '派单必须声明写范围：传 write_scopes 路径数组，或在描述里写一行「写范围：a, b」。'
        + '未声明会让该任务的写运行与同项目其他写运行全部串行，一条任务即可堵死队列。',
      )
    }
    // 同写范围重复卡拦截（DSHBOTS-82）：同项目已有「写范围完全一致」的在办卡时直接拒绝，
    // 避免同一文件上叠 N 张排队卡空转。force_duplicate 是逃生口：跳过检测，但留审计痕迹。
    // 紧急豁免（DSHBOTS-126）：priority='urgent' 的新卡放行——紧急任务无视排队立即施工，
    // 但创建消息报备与哪张在办卡共用车道，不静默并行。
    const duplicate = this.findDuplicateScopeTask(project.id, scopes)
    const forceDuplicate = input.force_duplicate === true
    const urgentExempt = input.priority === 'urgent'
    if (duplicate && !forceDuplicate && !urgentExempt) {
      throw conflict(
        `已存在同写范围任务 ${project.key}-${duplicate.number} ${duplicate.title}，请勿重复派单；`
        + '若需合并多张小卡，请在原任务描述追加清单后重派原任务。'
        + '紧急任务（priority=urgent）豁免此拦截，可立即派单施工。',
      )
    }
    const task = await this.createTask({
      projectId: project.id,
      title: input.title,
      description: input.description,
      assigneeBotId: member.id,
      priority: input.priority,
      // 透传原始清单（DSHBOTS-168）：清洗+审计由 createTask 统一做（审计挂真实 taskId）。
      writeScopes: parsedScopes,
      // 总监派单可带父子/依赖关系（snake_case 透传，createTask 内统一校验与落库）。
      parentTaskId: input.parent_task_id,
      blockedBy: input.blocked_by,
      // 时效要求（新任务 only）：重派已有任务（上面 input.taskId/input.task 分支）不更新该字段。
      timeBudgetMinutes: input.time_budget_minutes ?? input.timeBudgetMinutes,
      // 紧急豁免共用车道报备（DSHBOTS-126）：urgent 放行同写范围派单时，创建消息注明与哪张在办卡共用车道。
      laneShareTask: urgentExempt && duplicate ? `${project.key}-${duplicate.number}` : null,
      sandboxOverride,
      autoStart: true,
      postCard: true,
    }, actor)
    if (forceDuplicate) {
      this.audit(actor, 'dispatch_force_duplicate', 'task', task.id, {
        writeScopes: scopes,
        duplicateTaskId: duplicate?.id ?? null,
        duplicateIdentifier: duplicate ? `${project.key}-${duplicate.number}` : null,
      })
    }
    return task
  },
  resolveTaskByIdentifier(identifier) {
    const match = TASK_ID_PATTERN.exec(String(identifier ?? '').trim())
    if (!match) throw badRequest('任务号格式应为 <项目key>-<序号>，如 web-3')
    const project = this.store.get('SELECT * FROM projects WHERE key = ? COLLATE NOCASE', match[1])
    if (!project) throw notFound(`没有 key 为 ${match[1]} 的项目`)
    const task = this.store.get(
      'SELECT * FROM tasks WHERE project_id = ? AND number = ?',
      project.id, Number(match[2]),
    )
    if (!task) throw notFound(`项目 ${project.key} 没有任务 ${match[2]}`)
    return { project, task }
  },

  /** 微信管理员指令：按 <key-N> 取任务卡片（含最近评论）。 */
  taskViewByIdentifier(identifier) {
    const { task } = this.resolveTaskByIdentifier(identifier)
    return {
      ...this.taskView(task),
      // 指派者名（DSHBOTS-257）：/detail 卡片直读 assigneeName，在此按 assignee_bot_id
      // 解析（同 task-notify 口径），不进 taskView 列表热路径（每卡一次 bots 查询）。
      assigneeName: task.assignee_bot_id ? this.botRow(task.assignee_bot_id)?.name ?? null : null,
      comments: this.store.all(
        'SELECT author_type, author_id, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 3',
        task.id,
      ).reverse(),
    }
  },
  async taskDetail(taskId) {
    const task = this.taskRow(taskId)
    const project = this.projectRow(task.project_id)
    const comments = this.store.all('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at', taskId)
    const events = this.store.all('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at', taskId)
    const runs = this.store.all("SELECT * FROM runs WHERE task_id = ? AND COALESCE(error_code, '') <> 'SUPERSEDED' ORDER BY queued_at DESC", taskId)
    const dependencies = this.store.all(
      'SELECT t.id, t.number, t.title, t.status FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id WHERE d.task_id = ?',
      taskId,
    )
    // 任务级 usage 口径（DSHBOTS-212）：usage = 本卡全部运行（成功交付 + 失败重试 + 核验/受阻
    // 派生运行）端到端 token/成本，缓存读写分列；usageTotal = 本卡 + 全部后代子卡，
    // 拆分划算判定（C_removed > C_introduced）拿它与同类整卡任务的 usage 对比。
    // 只挂 taskDetail 单卡详情，不进 taskView 列表热路径（每卡一次聚合会放大列表查询）。
    const subtreeIds = taskSubtreeIds(this.store, taskId)
    const budgetCurrency = this.budgetCurrency()
    return {
      ...this.taskView(task),
      projectKey: project.key,
      usage: {
        own: taskUsageTotals(this.store, taskId, budgetCurrency),
        total: taskTreeUsageTotals(this.store, taskId, budgetCurrency),
        subtaskCount: subtreeIds.length - 1,
      },
      comments: comments.map(comment => ({
        ...comment,
        authorName: comment.author_type === 'bot'
          ? this.store.get('SELECT name FROM bots WHERE id = ?', comment.author_id)?.name ?? 'Bot'
          : this.actorName({ type: 'user', id: comment.author_id }),
      })),
      events,
      runs: runs.map(run => this.runView(run)),
      dependencies,
    }
  },
}
