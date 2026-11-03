// src/services/tasks.js —— 任务与审批域
// 任务建档、状态流转、派单、评论与交付验收/退回。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { bool } from '../config.js'
import { clampNumber, id, nowIso, projectKey, TASK_ID_PATTERN, text } from '../util.js'
import { parseWriteScopes, parseWriteScopesFromDescription, readWriteScopes } from './write-scopes.js'
import { ensureAttentionSchema, parseAttention } from './attention-schema.js'
import {
  ensureTaskRelationsSchema, normalizeBlockedByInput, taskDepsView, validateTaskRelations,
} from './task-relations.js'
// 任务工单七态派生与标签口径的唯一来源：task-stage 纯函数域（tests/task-stage.test.js 断言其判定表）。
import { taskStage, taskStageLabel } from './task-stage.js'

export const TASK_STATUSES = new Set(['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled'])

export const TASK_PRIORITIES = new Set(['urgent', 'high', 'medium', 'low', 'none'])

export const TRANSITIONS = {
  backlog: new Set(['todo', 'canceled']),
  todo: new Set(['backlog', 'in_progress', 'blocked', 'canceled']),
  in_progress: new Set(['todo', 'blocked', 'in_review', 'canceled']),
  blocked: new Set(['todo', 'in_progress', 'canceled']),
  in_review: new Set(['in_progress', 'done', 'canceled']),
  done: new Set(['todo']),
  canceled: new Set(['todo']),
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
  async createTask(input, actor = this.actor()) {
    const project = this.projectRow(input.projectId)
    if (project.status !== 'active') throw conflict('项目已归档')
    const title = text(input.title, 240)
    if (!title) throw badRequest('任务标题不能为空')
    const assigneeId = input.assigneeBotId || null
    if (assigneeId) this.assertMember(project.id, assigneeId)
    const status = input.status && TASK_STATUSES.has(input.status) ? input.status : (assigneeId ? 'todo' : 'backlog')
    const priority = TASK_PRIORITIES.has(input.priority) ? input.priority : 'medium'
    // 写范围：显式传参优先（含空数组 = 明确不声明）；未传时从描述的「写范围：」行兜底解析。
    const writeScopes = input.writeScopes === undefined || input.writeScopes === null
      ? parseWriteScopesFromDescription(input.description)
      : parseWriteScopes(input.writeScopes)
    // 时效要求（DSHBOTS-125）：发布方可传交付时限（分钟）；未传/非法 = NULL，提示词不注入。
    // 钳制到 1..10080（一分钟到一周）：只挡垃圾值，不替发布方做取舍；0/负数视为未提。
    // DSHBOTS-131：该任务派生运行的超时上限取 min(本字段, 全局 runTimeoutMs)，到期即超时中止。
    const rawTimeBudget = input.timeBudgetMinutes ?? input.time_budget_minutes
    const timeBudgetMinutes = Number(rawTimeBudget) > 0 ? clampNumber(rawTimeBudget, 1, 10_080, null) : null
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
    let number
    this.store.transaction(() => {
      const relations = validateTaskRelations({ store: this.store, projectId: project.id, taskId, parentTaskId, blockedBy })
      number = Number(this.store.get('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE project_id = ?', project.id)?.n ?? 1)
      this.store.run(
        `INSERT INTO tasks(id, project_id, number, title, description, status, priority, assignee_bot_id,
          creator_type, creator_id, review_target, source_message_id, parent_id, parent_task_id, blocked_by, position, due_at, estimate,
          time_budget_minutes, write_scopes, version, created_at, updated_at, completed_at, canceled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        taskId, project.id, number, title, text(input.description, 40_000), status, priority,
        assigneeId, actor.type, actor.id, actor.type === 'bot' ? 'owner_bot' : 'user',
        input.sourceMessageId ?? null, input.parentId ?? null,
        relations.parentTaskId, JSON.stringify(relations.blockedBy),
        Number.isFinite(Number(input.position)) ? Number(input.position) : number,
        input.dueAt ? new Date(input.dueAt).toISOString() : null,
        clampNumber(input.estimate, 0, 1000, null), timeBudgetMinutes, JSON.stringify(writeScopes), createdAt, createdAt,
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
  async updateTask(taskId, patch, actor = this.actor(), options = {}) {
    const task = this.taskRow(taskId)
    if (patch.version !== undefined && Number(patch.version) !== Number(task.version)) {
      throw conflict('任务已被其他人更新，请刷新后重试')
    }
    const updates = {}
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
      if (patch.assigneeBotId) this.assertMember(task.project_id, patch.assigneeBotId)
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
      await this.cancelSupersededQueuedRuns(taskId)
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
    return this.taskView(this.taskRow(taskId))
  },
  // 任务开始通知与开工入队（DSHBOTS-100）：「任务进入进行中」的唯一落点。
  // 幂等口径：已有活跃运行时不重复入队、不重复发消息（不能对已经在跑的任务再喊一次开始）；
  // 没有负责人时不发消息也不入队（没人可通知、也没人可开工）。
  // 先入队后发消息：入队失败时宁可没有消息，也不留一条指向空转的「开始」。
  notifyTaskStarted(task, { triggerType = 'task_started' } = {}) {
    const assigneeId = task.assignee_bot_id
    if (!assigneeId) return null
    const active = this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      task.id,
    )
    if (active) return null
    // 负责人 bot 行缺失（数据异常）时整体跳过：通知与开工都指不到人，
    // 也不能让通知失败反过来把已经落库的状态变更顶掉。
    const bot = this.store.get('SELECT name FROM bots WHERE id = ?', assigneeId)
    if (!bot) return null
    const project = this.projectRow(task.project_id)
    const identifier = `${project.key}-${task.number}`
    try {
      this.enqueueOutbox({
        kind: 'task_run',
        payload: { taskId: task.id, triggerType },
        projectId: task.project_id,
        taskId: task.id,
        idempotencyKey: `task:${task.id}:${triggerType}:${Date.now()}`,
      })
      this.insertMessage({
        projectId: task.project_id,
        senderType: 'system',
        senderId: 'system',
        taskId: task.id,
        body: `任务 ${identifier} 已开始（${bot.name}）。`,
        mentions: [assigneeId],
      })
    } catch (error) {
      // 状态变更已经落库，通知/开工失败不能反过来把整次 update_task 打挂（用户会看到报错但状态已变）。
      this.logger.warn?.('dsh-team: 任务开始通知失败 %s: %s', identifier, error?.message ?? error)
      return null
    }
    void this.tick()
    return { taskId: task.id, triggerType }
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
  async cancelSupersededQueuedRuns(taskId) {
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
  async assignTask(taskId, botId, actor = this.actor(), { autoStart = true } = {}) {
    const task = this.taskRow(taskId)
    const project = this.projectRow(task.project_id)
    this.assertMember(project.id, botId)
    const active = this.store.get(
      "SELECT id, kind FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      taskId,
    )
    if (active && active.kind === 'task' && task.assignee_bot_id !== botId) throw conflict('任务有正在执行的运行，不能更换负责人')
    this.store.transaction(() => {
      this.store.run(
        `UPDATE tasks SET assignee_bot_id = ?, review_target = ?,
          status = CASE WHEN status IN ('backlog', 'blocked') THEN 'todo' ELSE status END,
          version = version + 1, updated_at = ? WHERE id = ?`,
        botId, actor.type === 'bot' ? 'owner_bot' : 'user', nowIso(), taskId,
      )
      this.addTaskEvent(taskId, 'assigned', actor, { botId })
      this.audit(actor, 'task.assign', 'task', taskId, { botId })
    })
    // 总监bot的验收/受阻处理运行本身占用任务的唯一活动运行名额，
    // 此时由 finishRun 的收尾逻辑负责重新排队执行，这里跳过。
    if (!active) {
      this.enqueueOutbox({
        kind: 'task_run',
        payload: { taskId, triggerType: 'assigned' },
        projectId: task.project_id,
        taskId,
        idempotencyKey: `task:${taskId}:assigned`,
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
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, write_scopes, queued_at)
       VALUES (?, ?, ?, ?, 'task', 'write', ?, ?, 'queued', 1, ?, ?, ?)`,
      runId, task.project_id, task.assignee_bot_id, task.id, triggerType, task.id, `task:${task.id}:${Date.now()}:${runId}`, writeScopes, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'queued', `由 ${actor.type}:${actor.id} 触发`, createdAt,
    )
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
  async assignFromBot(sessionId, input) {
    const { project, actor } = this.ownerContextFor(sessionId)
    const member = this.membersOf(project.id).find(bot => bot.name.toLowerCase() === String(input.assignee ?? '').toLowerCase())
    if (!member) throw badRequest(`项目中没有 Bot ${input.assignee}`)
    if (input.taskId || input.task) {
      const task = this.resolveBotTask(project, input.taskId ?? input.task)
      if (['done', 'canceled'].includes(task.status)) throw conflict(`任务 ${project.key}-${task.number} 已结束，不能重派`)
      const updated = await this.assignTask(task.id, member.id, actor, { autoStart: false })
      void this.tick()
      return updated
    }
    // 派单必须声明写范围（程序化闸门，不靠派单方自觉）：未声明写范围的任务其写运行会与
    // 同项目所有写运行判为冲突并保守串行，一条空范围任务就能把整队堵死。这里直接拒绝，
    // 而不是留到调度器里把并发能力悄悄吃掉。
    const scopes = input.write_scopes === undefined || input.write_scopes === null
      ? parseWriteScopesFromDescription(input.description)
      : parseWriteScopes(input.write_scopes)
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
      writeScopes: scopes,
      // 总监派单可带父子/依赖关系（snake_case 透传，createTask 内统一校验与落库）。
      parentTaskId: input.parent_task_id,
      blockedBy: input.blocked_by,
      // 时效要求（新任务 only）：重派已有任务（上面 input.taskId/input.task 分支）不更新该字段。
      timeBudgetMinutes: input.time_budget_minutes ?? input.timeBudgetMinutes,
      // 紧急豁免共用车道报备（DSHBOTS-126）：urgent 放行同写范围派单时，创建消息注明与哪张在办卡共用车道。
      laneShareTask: urgentExempt && duplicate ? `${project.key}-${duplicate.number}` : null,
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
  async reviewFromBot(sessionId, input) {
    const { project, actor } = this.ownerContextFor(sessionId)
    if (!['accept', 'return'].includes(input.decision)) throw badRequest('验收结果只能是 accept 或 return')
    const task = this.resolveBotTask(project, input.task)
    return this.applyReview(task, project, input.decision, input.comment, actor)
  },

  /** 验收/退回的共用流程：owner Bot 会话与微信管理员共用。 */
  async applyReview(task, project, decision, comment, actor) {
    const identifier = `${project.key}-${task.number}`
    if (task.status !== 'in_review') throw conflict(`任务 ${identifier} 不在待验收状态`)
    if (decision === 'accept') {
      await this.updateTask(task.id, { status: 'done' }, actor)
      if (comment) await this.addComment(task.id, comment, actor)
      this.insertMessage({
        projectId: project.id,
        senderType: 'system',
        senderId: 'system',
        body: `任务 ${identifier} 验收通过。`,
        taskId: task.id,
      })
    } else {
      const reason = text(comment, 20_000)
      if (!reason) throw badRequest('退回任务必须说明原因')
      if (!task.assignee_bot_id) throw conflict(`任务 ${identifier} 没有负责人，无法退回重做`)
      // 退回重做回到「进行中」：走 updateTask 内的统一触发点（DSHBOTS-100）——
      // 通知负责人并入队重跑，运行触发类型沿用 returned；
      // 总监验收运行仍在进行时触发点会跳过（不重复开工），由其结束时的收尾逻辑补排。
      await this.updateTask(task.id, { status: 'in_progress' }, actor, { startTriggerType: 'returned' })
      await this.addComment(task.id, `退回重做：${reason}`, actor)
      void this.tick()
      this.insertMessage({
        projectId: project.id,
        senderType: 'system',
        senderId: 'system',
        body: `任务 ${identifier} 被总监退回重做。`,
        taskId: task.id,
      })
    }
    return this.taskView(this.taskRow(task.id))
  },

  // 验收核验委派（DSHBOTS-107）：待验收任务上，owner 一键把核验工作派给总监 Bot，
  // 由其会话内的 subagent/subagent_fork 并行完成（提示词见 runtime/prompt.js 的
  // review-verification 模板）。核验结论以任务评论写回（finishRun 复用 addComment 通道），
  // 裁决权不变：accept/return 仍由 owner 经 team_review_task 或看板执行，本方法不碰任务状态。
  async taskReviewDelegate(taskId, actor = this.actor()) {
    if (actor.type !== 'user') throw forbidden('只有工作台 owner 可以委派子代理核验')
    const task = this.taskRow(taskId)
    const { runId } = this.spawnReviewDelegate(task, { actor, origin: 'manual' })
    return this.runView(this.runRow(runId))
  },

  // 核验委派共享入口（DSHBOTS-113）：手动按钮（taskReviewDelegate）与交付后自动委派
  // （review_delegate_auto outbox）走同一实现，守卫（待验收状态 / 可用总监 / one_active
  // 幂等复看）与运行形态（kind='review', mode='read', trigger='review_delegate'）完全一致。
  // 返回 { runId, reused }；不满足守卫时抛 conflict，由调用方决定阻塞还是留痕重试。
  spawnReviewDelegate(task, { actor, origin = 'manual' }) {
    const project = this.projectRow(task.project_id)
    const identifier = `${project.key}-${task.number}`
    if (task.status !== 'in_review') throw conflict(`任务 ${identifier} 不在待验收状态`)
    const owner = project.owner_bot_id
      ? this.store.get("SELECT * FROM bots WHERE id = ? AND status = 'active'", project.owner_bot_id)
      : null
    if (!owner) throw conflict(`项目 ${project.name} 没有可用的总监 Bot，无法委派核验`)
    const active = this.store.get(
      "SELECT id, trigger_type FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      task.id,
    )
    // 幂等：已有委派核验运行在跑时直接复看该运行；其他活动运行（如自动验收运行）占着
    // 任务的运行位时拒绝，避免同任务上两种验收语义叠跑。
    if (active) {
      if (active.trigger_type === 'review_delegate') return { runId: active.id, reused: true }
      throw conflict(`任务 ${identifier} 已有运行在排队或执行，请先停止再委派核验`)
    }
    const runId = id('run')
    const createdAt = nowIso()
    this.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
        attempt, idempotency_key, queued_at)
       VALUES (?, ?, ?, ?, 'review', 'read', 'review_delegate', ?, 'queued', 1, ?, ?)`,
      runId, project.id, owner.id, task.id, task.id, `review_delegate:${task.id}:${Date.now()}:${runId}`, createdAt,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'queued',
      `${origin === 'auto' ? '交付后自动' : 'owner'}委派子代理核验（${actor.type}:${actor.id}）`, createdAt,
    )
    this.audit(actor, origin === 'auto' ? 'review.auto_delegate' : 'task.review_delegate', 'task', task.id, { runId })
    void this.tick()
    return { runId, reused: false }
  },

  // 自动委派开关（DSHBOTS-113）：默认开，DSH_TEAM_AUTO_REVIEW_DELEGATE=0 关闭回到纯手动。
  autoReviewDelegateEnabled() {
    return bool(this.config.autoReviewDelegate, true)
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
    return {
      ...this.taskView(task),
      projectKey: project.key,
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
