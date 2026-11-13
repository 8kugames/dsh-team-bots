// src/services/task-runs.js —— 任务运行入队、写占用与评论交互域
// 覆盖：任务运行入队（enqueueTaskRun / enqueueOwnerTaskRun）、写占用释放（releaseTaskWriteLocks）、
// 终态排队运行清理（cancelSupersededQueuedRuns）、任务评论与运行中继（addComment / steerRunningTaskRun）。
// 任务建档、状态流转与视图见 ./tasks.js；派单/改派见 ./task-dispatch.js。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用）。

import { badRequest, conflict } from '../errors.js'
import { id, nowIso, text } from '../util.js'
import { readWriteScopes } from './write-scopes.js'

export const taskRunMethods = {
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
    // 单 bot 多任务并行（任务运行豁免 bot 串行域）：任务运行直插 queued，不再查 bot 忙
    // 挂待处理队列——重复施工由 one_active_run_per_task 唯一索引兜底（上方 active 预检 +
    // 下方 catch 合并），写安全由调度器写范围闸门兜底。消息族/owner_task 照旧走 busy 闸。
    try {
      this.store.run(
        `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
          attempt, idempotency_key, write_scopes, model_provider, model_model, model_effort, queued_at)
         VALUES (?, ?, ?, ?, 'task', 'write', ?, ?, 'queued', 1, ?, ?, ?, ?, ?, ?)`,
        runId, task.project_id, task.assignee_bot_id, task.id, triggerType, task.id,
        `task:${task.id}:${Date.now()}:${runId}`, writeScopes, fallbackProvider, fallbackModel, fallbackEffort, createdAt,
      )
    } catch (error: any) {
      // 查后插竞态撞 one_active_run_per_task（bot 维度索引已不含 task 运行）——双投胜利方
      // 的同任务 active 运行已在→合并返回其 id 消算，不抛不挂起（D-304 口径沿用到任务维度）。
      if (this.activeRunByTaskId(task.id)) return this.activeRunByTaskId(task.id)
      throw error
    }
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
    // 验收竞态收敛（DSHBOTS-275）：入队前终态预检——任务已 done/canceled 时直接跳过，
    // 不产生 review/handle run 行（GS 实测交付排队与 owner 关单竞态空跑约 1/8）。
    // 以库内最新状态为准（调用方传入的 task 行可能已过期）；入队后才到终态的残留排队运行
    // 仍由 cancelSupersededQueuedRuns「任务已结束，排队运行被清理」兜底清理，语义不变。
    const current = this.taskRow(task.id)
    if (!current || current.status === 'done' || current.status === 'canceled') return null
    const project = this.projectRow(current.project_id)
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
    // busy 闸（DSHBOTS-290）：owner 忙时 review/handle 运行同样不落 runs 行（撞
    // one_active_run_per_bot），挂待处理队列空闲建回——与 enqueueTaskRun 同口径。
    // DSHBOTS-300：挂起项提为 hold 闭包，busy 分支与查后插竞态兜底共用。
    // DSHBOTS-358：额度路由（与任务运行同口径）——主 provider 耗尽时走备用模型，
    // 无可用备用则留 queued 等恢复；路由快照写进运行行的 model_* 三列。
    // 路由在 busy 闸之前算好：挂起项要带同一份快照，空闲建回时列面与直插一致。
    const routing = this.quotaRoutingForBot(owner)
    const routeProvider = routing.mode === 'fallback' ? routing.provider : null
    const routeModel = routing.mode === 'fallback' ? routing.model : null
    const routeEffort = routing.mode === 'fallback' ? routing.effort : null
    const hold = () => this.holdPendingMessage(owner.id, project.id, {
      kind: 'owner_task', messageId: `owner_task:${current.id}:${kind}`, taskId: current.id,
      projectId: project.id, runKind: kind, triggerType, queuedAt: createdAt,
      routing: routing.mode === 'fallback'
        ? { mode: 'fallback', provider: routing.provider, model: routing.model, effort: routing.effort, ref: routing.ref }
        : routing.mode === 'wait'
          ? { mode: 'wait', resetAt: routing.resetAt }
          : { mode: 'primary' },
    })
    if (this.botBusy(owner.id, project.id)) {
      hold()
      return null
    }
    try {
      this.store.run(
        `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
          attempt, idempotency_key, model_provider, model_model, model_effort, queued_at)
         VALUES (?, ?, ?, ?, ?, 'read', ?, ?, 'queued', 1, ?, ?, ?, ?, ?)`,
        runId, project.id, owner.id, task.id, kind, triggerType, task.id,
        `${kind}:${task.id}:${Date.now()}:${runId}`,
        routeProvider, routeModel, routeEffort, createdAt,
      )
    } catch (error: any) {
      // DSHBOTS-304：双投胜利方同任务 active 运行已在→合并返回其 id 消算（同 enqueueTaskRun）。
      if (this.isRunBotUniqueViolation(error)) {
        const merged = this.activeRunByTaskId(task.id)
        if (merged) return merged
        hold()
        return null
      }
      throw error
    }
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'queued',
      kind === 'review' ? '任务交付，转总监验收' : '任务受阻，转总监处理',
      createdAt,
    )
    // DSHBOTS-358：内部运行同样接额度路由——主 provider 耗尽时直接走备用模型；
    // 无可用备用则留 queued 等恢复（调度器额度闸门兜底），不再照常下发撞墙。
    if (routing.mode === 'fallback') {
      this.insertRunEvent(
        runId,
        'quota_fallback',
        `主 provider 额度耗尽，本次直接走备用模型 ${routing.ref}（预计 ${this.botQuotaState(owner.id, owner.provider)?.resetAt ?? '未知'} 恢复）`,
      )
    } else if (routing.mode === 'wait') {
      this.insertRunEvent(
        runId,
        'quota_wait',
        `主 provider 额度耗尽且无可用备用模型，排队等待至 ${routing.resetAt ?? '恢复'}`,
      )
    }
    void this.tick()
    return runId
  },
}
