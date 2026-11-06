// src/services/tasks.js —— 任务核心域（建档、状态流转与视图）
// 派单/改派/看板联动见 ./task-dispatch.js；运行入队、写占用释放与评论见 ./task-runs.js；
// 交付验收/退回与核验委派见 ./task-review.js。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { badRequest, conflict, notFound } from '../errors.js'
import { clampNumber, id, nowIso, projectKey, TASK_ID_PATTERN, text } from '../util.js'
import { parseWriteScopes, parseWriteScopesFromDescription, readWriteScopes } from './write-scopes.js'
import { ensureAttentionSchema, parseAttention } from './attention-schema.js'
import { SANDBOX_OVERRIDES } from './file-policy.js'
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

// 任务级死线 schema（DSHBOTS-274）：tasks.budget_updated_at 记最近一次 time_budget_minutes
// 实改时刻，是延期阀的重算基准锚点。外置自管迁移（tasks_canceled_at 同款先例，db.js 不再加行）。
export function ensureTaskDeadlineSchema(store) {
  if (store.get('SELECT 1 AS ok FROM schema_migrations WHERE name = ?', 'tasks_budget_updated_at')) return
  const columns = store.all('PRAGMA table_info(tasks)').map(row => row.name)
  if (!columns.includes('budget_updated_at')) {
    store.exec('ALTER TABLE tasks ADD COLUMN budget_updated_at TEXT')
  }
  store.run('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING', 'tasks_budget_updated_at', nowIso())
}

// 允许轮数（DSHBOTS-274）：整卡死线 = 派发基准 + time_budget_minutes × TASK_BUDGET_ROUNDS。
export const TASK_BUDGET_ROUNDS = 2

// 任务级死线纯计算（DSHBOTS-274，tests/task-deadline.test.js 守门）：
// 治「time_budget_minutes 只约束单运行、多轮派发各自重置预算、累计耗时无上限」。
// - 派发基准：改过预算（延期阀）取最近一次改预算之后的首个派发（无则退回首次派发）；
//   未改过预算取首次派发——多轮派发自身不重置窗口；
// - owner 改 time_budget_minutes 延期后重派，新派发即新基准，拿到完整新窗口；
// - 无预算（NULL/≤0）或无派发记录返回 null，死线不约束（与 D-131 无时效口径一致）。
export const taskDeadlineMs = ({ budgetMinutes, firstDispatchAt, firstDispatchSinceBudgetChangeAt }) => {
  const minutes = Number(budgetMinutes)
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  const baseRaw = firstDispatchSinceBudgetChangeAt ?? firstDispatchAt
  const base = baseRaw ? Date.parse(baseRaw) : NaN
  if (!Number.isFinite(base)) return null
  return base + minutes * TASK_BUDGET_ROUNDS * 60_000
}

// 任务级死线信息（DSHBOTS-274）：派发时刻口径 = runs 表 kind='task' 的 queued_at
// （入队即派发；started_at 领取后才写，未被领取过的派发拿不到时刻，故不用 started_at）。
// review/handle 等派生运行 kind!=='task' 天然不计入派发史。
export function taskDeadlineInfo(store, task) {
  ensureTaskDeadlineSchema(store)
  const firstDispatchAt = store.get(
    "SELECT MIN(queued_at) AS v FROM runs WHERE task_id = ? AND kind = 'task'",
    task.id,
  )?.v ?? null
  const firstDispatchSinceBudgetChangeAt = task.budget_updated_at
    ? store.get(
      "SELECT MIN(queued_at) AS v FROM runs WHERE task_id = ? AND kind = 'task' AND queued_at >= ?",
      task.id, task.budget_updated_at,
    )?.v ?? null
    : null
  return {
    deadlineMs: taskDeadlineMs({
      budgetMinutes: task.time_budget_minutes,
      firstDispatchAt,
      firstDispatchSinceBudgetChangeAt,
    }),
    firstDispatchAt,
    firstDispatchSinceBudgetChangeAt,
  }
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
      // 共享板无主卡声明闸门（DSHBOTS-270）：无主卡经编辑表单获得 owner，与 assignTask
      // 领取是同一条「获得 owner 即将进施工」链路，同口径过闸；同一次 patch 里补的
      // write_scopes / 描述「写范围：」行一并纳入判定——补声明后放行。
      if (patch.assigneeBotId && !task.assignee_bot_id) {
        this.assertClaimScopes({
          ...task,
          write_scopes: patch.writeScopes === undefined
            ? task.write_scopes
            : JSON.stringify(parseWriteScopes(patch.writeScopes)),
          description: patch.description === undefined ? task.description : text(patch.description, 40_000),
        }, this.projectRow(task.project_id))
      }
      updates.assignee_bot_id = patch.assigneeBotId || null
    }
    if (patch.position !== undefined) updates.position = Number(patch.position) || 0
    if (patch.dueAt !== undefined) updates.due_at = patch.dueAt ? new Date(patch.dueAt).toISOString() : null
    if (patch.estimate !== undefined) updates.estimate = clampNumber(patch.estimate, 0, 1000, null)
    if (patch.writeScopes !== undefined) {
      updates.write_scopes = JSON.stringify(parseWriteScopes(patch.writeScopes))
    }
    // 延期阀（DSHBOTS-274）：update_task 实改 time_budget_minutes 后整卡死线按新预算重算——
    // 记 budget_updated_at，死线基准切到「改预算之后的首个派发」（无则退回首次派发），
    // owner 延期后重派即拿到完整新窗口（计算见 taskDeadlineMs）。
    if (patch.timeBudgetMinutes !== undefined || patch.time_budget_minutes !== undefined) {
      const rawBudget = patch.timeBudgetMinutes ?? patch.time_budget_minutes
      const budget = Number(rawBudget) > 0 ? clampNumber(rawBudget, 1, 10_080, null) : null
      if (budget !== task.time_budget_minutes) {
        ensureTaskDeadlineSchema(this.store)
        updates.time_budget_minutes = budget
        updates.budget_updated_at = nowIso()
      }
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
  assertTransition(from, to) {
    if (from === to) return
    if (!TRANSITIONS[from]?.has(to)) throw conflict(`任务不能从 ${from} 变为 ${to}`)
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
