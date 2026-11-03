// src/services/tasks.js —— 任务与审批域
// 任务建档、状态流转、派单、评论与交付验收/退回。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { clampNumber, id, nowIso, projectKey, TASK_ID_PATTERN, text } from '../util.js'
import { parseWriteScopes, parseWriteScopesFromDescription, readWriteScopes } from './write-scopes.js'
import { ensureAttentionSchema, parseAttention } from './attention-schema.js'
import {
  ensureTaskRelationsSchema, normalizeBlockedByInput, taskDepsView, validateTaskRelations,
} from './task-relations.js'

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

// task-stage:start —— 任务阶段纯推导 + 标签口径唯一来源（DSHBOTS-42，tests/task-stage.test.js 断言此块）。
// 阶段不落库、不新增状态位：由事实（任务终态、结构化提问、最近运行）按优先级顺序推导，第一匹配行获胜。
// 返回两层结构 {stage, action?}，中文文案由 TASK_STAGE_LABEL 查表得出，调用方不得从 latestRun.status 拼接文案。
// 优先级：ended → person/answer → working(running 且 kind='task') → working/queued → person/failed → idle。
// 终态（done/canceled）一律 ended、不渲染任何运行徽标——即使任务上还挂着遗留运行
// （线上 bug 回归锁：「已完成」列出现过「已取消/运行中」标签，DSHBOTS-37 只修了数据源，此处把口径收死）。
export function taskStage(task, latestRun, attention) {
  if (task?.status === 'done' || task?.status === 'canceled') return { stage: 'ended' }
  if (attention) return { stage: 'person', action: 'answer' }
  if (latestRun?.status === 'running' && latestRun?.kind === 'task') return { stage: 'working' }
  if (latestRun?.status === 'queued') return { stage: 'working', action: 'queued' }
  if (latestRun?.status === 'failed') return { stage: 'person', action: 'failed' }
  return { stage: 'idle' }
}

// 标签查表：key 为 stage 或 `stage/action`；ended 映射 null（不显示）。标签说「在等谁、等什么」，不露内部状态码。
export const TASK_STAGE_LABEL = {
  'person/answer': '等待你回答',
  'person/failed': '需要你处理',
  'person/review': '等待验收',
  working: '正在执行',
  'working/queued': '排队中',
  idle: '空闲',
  ended: null,
}

// stage 结构 → 标签文案：UI 只消费查表结果（taskView 已挂 stageLabel），不自行拼字符串。
export function taskStageLabel(stage) {
  if (!stage) return null
  const key = stage.action ? `${stage.stage}/${stage.action}` : stage.stage
  return TASK_STAGE_LABEL[key] ?? null
}
// task-stage:end

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
          write_scopes, version, created_at, updated_at, completed_at, canceled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        taskId, project.id, number, title, text(input.description, 40_000), status, priority,
        assigneeId, actor.type, actor.id, actor.type === 'bot' ? 'owner_bot' : 'user',
        input.sourceMessageId ?? null, input.parentId ?? null,
        relations.parentTaskId, JSON.stringify(relations.blockedBy),
        Number.isFinite(Number(input.position)) ? Number(input.position) : number,
        input.dueAt ? new Date(input.dueAt).toISOString() : null,
        clampNumber(input.estimate, 0, 1000, null), JSON.stringify(writeScopes), createdAt, createdAt,
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
        body: `任务 ${project.key}-${number}：${title}${assigneeId ? ` → @${this.botRow(assigneeId).name}` : ''}`,
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
    const { write_scopes: rawScopes, ...rest } = task
    // 阶段按事实推导（task-stage 块）：与 latestRun 同源；attention 取最近运行的待回答提问。
    const attention = runs[0] ? parseAttention(runs[0].attention_json) : null
    const stage = taskStage(task, runs[0] ?? null, attention)
    const deps = taskDepsView(this.store, task, project?.key)
    return {
      ...rest,
      identifier: `${project?.key ?? 'T'}-${task.number}`,
      labels,
      writeScopes: readWriteScopes(rawScopes),
      attention,
      blockedBy: deps.blockedBy,
      depsSatisfied: deps.depsSatisfied,
      blockedByNames: deps.blockedByNames,
      comments: Number(this.store.get('SELECT COUNT(*) AS count FROM task_comments WHERE task_id = ?', task.id)?.count ?? 0),
      latestRun: runs[0] ?? null,
      runs,
      stage,
      stageLabel: taskStageLabel(stage),
    }
  },
  async updateTask(taskId, patch, actor = this.actor()) {
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
    // 写占用释放（DSHBOTS-73，用户口径）：任务状态离开「进行中」就中止它名下仍在跑/排队的写运行，
    // 写占用/锁定随之解除。单一触发点：所有任务状态变更都经过 updateTask 这一处，不在别处散着写。
    if (updates.status && updates.status !== task.status && updates.status !== 'in_progress') {
      await this.releaseTaskWriteLocks(taskId, { fromStatus: task.status, toStatus: updates.status })
    }
    if (updates.status === 'canceled') await this.cancelRunsForTask(taskId)
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
    await this.updateTask(taskId, { status }, actor)
    await this.applyBoardDragDirective(before, status, { activeRuns })
    // 重新取数：拖拽联动可能刚入队或暂停了运行，沿用 updateTask 的返回会带过期的 latestRun。
    return this.taskView(this.taskRow(taskId))
  },

  // 看板拖拽联动（DSHBOTS-54）：拖入「执行中」自动开工，拖出到 todo/blocked 自动暂停。
  // 指令消息由系统直接发（sender_type='system'，不触发 bot 运行），实际执行靠这里入队的 task run；
  // 出向 in_review/done/canceled 的写运行中止由 updateTask 内的写占用释放统一处理（DSHBOTS-73）。
  // 已有活跃 run 或无负责人时拖入侧整体跳过：消息声称「请立即开始」就必须真的开工。
  async applyBoardDragDirective(before, afterStatus, { activeRuns = 0 } = {}) {
    if (before.status === afterStatus) return
    if (before.status === 'todo' && afterStatus === 'in_progress') {
      const active = this.store.get(
        "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
        before.id,
      )
      if (active || !before.assignee_bot_id) return
      const project = this.projectRow(before.project_id)
      const identifier = `${project.key}-${before.number}`
      const botName = this.botRow(before.assignee_bot_id).name
      // 先入队后发消息：入队失败时宁可没有消息，也不留一条指向空转的「请立即开始」。
      this.enqueueOutbox({
        kind: 'task_run',
        payload: { taskId: before.id, triggerType: 'board_resume' },
        projectId: before.project_id,
        taskId: before.id,
        idempotencyKey: `task:${before.id}:board_resume:${Date.now()}`,
      })
      this.insertMessage({
        projectId: before.project_id,
        senderType: 'system',
        senderId: 'system',
        taskId: before.id,
        body: `【系统指令】任务 ${identifier}「${before.title}」已进入执行中，请 ${botName} 立即开始。`,
        mentions: [before.assignee_bot_id],
      })
      void this.tick()
      return
    }
    if (before.status === 'in_progress' && (afterStatus === 'todo' || afterStatus === 'blocked')) {
      // 运行中止已由 updateTask 内的写占用释放统一完成（同一处处理），这里只按中止条数发系统指令消息。
      if (activeRuns > 0) {
        const project = this.projectRow(before.project_id)
        this.insertMessage({
          projectId: before.project_id,
          senderType: 'system',
          senderId: 'system',
          taskId: before.id,
          body: `【系统指令】任务 ${project.key}-${before.number} 已被移出执行中，相关运行已暂停。`,
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
    const duplicate = this.findDuplicateScopeTask(project.id, scopes)
    const forceDuplicate = input.force_duplicate === true
    if (duplicate && !forceDuplicate) {
      throw conflict(
        `已存在同写范围任务 ${project.key}-${duplicate.number} ${duplicate.title}，请勿重复派单；`
        + '若需合并多张小卡，请在原任务描述追加清单后重派原任务。',
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
      await this.updateTask(task.id, { status: 'in_progress' }, actor)
      await this.addComment(task.id, `退回重做：${reason}`, actor)
      // 若总监验收运行仍在进行，由其结束时的收尾逻辑补排；否则立即重排执行。
      const active = this.store.get(
        "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
        task.id,
      )
      if (!active) {
        this.enqueueOutbox({
          kind: 'task_run',
          payload: { taskId: task.id, triggerType: 'returned' },
          projectId: task.project_id,
          taskId: task.id,
          idempotencyKey: `task:${task.id}:returned:${Date.now()}`,
        })
      }
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
