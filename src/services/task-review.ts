// src/services/task-review.js —— 任务验收、退回与核验委派域
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。
// 覆盖：owner/总监验收与退回（applyReview）、机器人会话验收入口（reviewFromBot）、
// 核验委派（taskReviewDelegate / spawnReviewDelegate / autoReviewDelegateEnabled）、
// 写范围编辑（taskUpdateScopes）。任务建档、状态流转与视图仍在 ./tasks.js。

import { badRequest, conflict, forbidden } from '../errors.js'
import { bool } from '../config.js'
import { id, nowIso, text } from '../util.js'
import { parseWriteScopes, readWriteScopes } from './write-scopes.js'

export const taskReviewMethods = {
  async reviewFromBot(sessionId, input) {
    const { project, actor } = this.ownerContextFor(sessionId)
    if (!['accept', 'return'].includes(input.decision)) throw badRequest('验收结果只能是 accept 或 return')
    const task = this.resolveBotTask(project, input.task)
    // 验收机械闸（DSHBOTS-318）只拦真验收动作（in_review 卡）：非待验收状态保持既有
    // 校验顺序，仍由 applyReview 抛 in_review conflict，闸不抢跑。
    if (task.status === 'in_review') this.assertReviewSubagentVerified(sessionId, input.comment)
    return this.applyReview(task, project, input.decision, input.comment, actor)
  },

  // 验收机械闸（DSHBOTS-318）：把「验收必须经由子代理」从提示约束升级为机械约束——
  // owner bot 的 team_review_task 前置校验调用方当前活跃运行的子代理账目
  // （run_events 的 subagent_spawned），无账目即拒绝；comment 显式注明「兜底验收」
  // 放行（对应 router 硬流程第 4 条：子代理失败重试一次仍失败时 director 兜底）。
  // 仅机器人路径：微信管理员/看板 owner 走 applyReview，不经过本闸。
  assertReviewSubagentVerified(sessionId, comment) {
    if (comment?.includes('兜底验收')) return
    const run = this.store.get(
      "SELECT id FROM runs WHERE session_id = ? AND status IN ('running', 'queued') ORDER BY queued_at DESC LIMIT 1",
      sessionId,
    )
    const ledger = run && this.store.get(
      "SELECT id FROM run_events WHERE run_id = ? AND type = 'subagent_spawned' LIMIT 1",
      run.id,
    )
    if (ledger) return
    // DSHBOTS-269 失败语义引导：拒绝文案 = 原因 + 正确下一步。
    throw badRequest(
      '当前运行没有子代理账目（subagent_spawned），验收必须先经子代理核验：'
      + '先派验收子代理（subagent/subagent_fork）做范围比对/目标测试/红线预测，把结论作为 comment；'
      + '如需 director 兜底，在 comment 里注明「兜底验收」。',
    )
  },

  /** 验收/退回的共用流程：owner Bot 会话与微信管理员共用。 */
  async applyReview(task, project, decision, comment, actor) {
    const identifier = `${project.key}-${task.number}`
    // DSHBOTS-269 失败语义引导：拒绝文案 = 原因 + 替代命令/正确下一步（工具调用返回层，
    // 与 run-finish 群聊/微信失败终态白名单契约不同层，互不影响）。
    if (task.status !== 'in_review') {
      throw conflict(
        `任务 ${identifier} 不在待验收状态（当前 ${task.status}）：`
        + 'team_review_task 只验收已交付（in_review）的卡，请先等负责人交付；'
        + '若卡面或目标有误，用 team_assign_task 重派原任务（task=原任务号，附 title/description 即改卡）修正。',
      )
    }
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

  // 写范围修改（DSHBOTS-151）：owner-only 编辑任务的写范围声明，并把排队中的写运行快照一并刷新——
  // 调度闸门消费的是入队时的运行快照（enqueueTaskRun），只改任务表不改快照对下一拍调度无效。
  // running 写运行拒改：其快照正被闸门与执行中的会话消费，强改会制造「声明与执行不符」。
  async taskUpdateScopes(taskId, writeScopesInput, actor = this.actor()) {
    if (actor.type !== 'user') throw forbidden('只有工作台 owner 可以修改写范围')
    const task = this.taskRow(taskId)
    if (task.status === 'done' || task.status === 'canceled') throw conflict('任务已结束，不能修改写范围')
    const parsedScopes = parseWriteScopes(writeScopesInput)
    // 派单清洗（DSHBOTS-168）：与派单入口同口径——ignored 机械移除（审计挂本任务）、
    // 一级目录驳回；清洗后为空落下方既有「写范围不能为空」拒绝。
    const scopes = this.normalizeDispatchScopes(this.projectRow(task.project_id), parsedScopes, { actor, taskId })
    if (!scopes.length) throw badRequest('写范围不能为空：未声明的写运行会与同项目所有写运行保守串行')
    const runningWrite = this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND status = 'running' AND mode = 'write'",
      taskId,
    )
    if (runningWrite) throw badRequest('任务有运行中的写运行，先等运行结束或取消，再修改写范围')
    const queuedWrites = this.store.all(
      "SELECT id FROM runs WHERE task_id = ? AND status = 'queued' AND mode = 'write'",
      taskId,
    )
    const from = readWriteScopes(task.write_scopes)
    const serialized = JSON.stringify(scopes)
    this.store.transaction(() => {
      this.store.run(
        'UPDATE tasks SET write_scopes = ?, version = version + 1, updated_at = ? WHERE id = ?',
        serialized, nowIso(), taskId,
      )
      for (const run of queuedWrites) {
        this.store.run('UPDATE runs SET write_scopes = ? WHERE id = ?', serialized, run.id)
        this.insertRunEvent(run.id, 'scopes_updated', `写范围修改同步快照：${from.join('、') || '未声明'} → ${scopes.join('、')}`)
      }
      this.addTaskEvent(taskId, 'scopes_updated', actor, { from, to: scopes })
      this.audit(actor, 'task.scopes_update', 'task', taskId, { from, to: scopes })
    })
    return this.taskView(this.taskRow(taskId))
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
    // busy 闸（DSHBOTS-290）：总监忙时不落 runs 行（撞 one_active_run_per_bot），挂待
    // 处理队列空闲建回（insertHeldMessageRun 的 owner_task 分支）；返回 deferred 让
    // 手动入口与 outbox 自动入口都能感知「已挂起」而非失败。
    if (this.botBusy(owner.id, project.id)) {
      this.holdPendingMessage(owner.id, project.id, {
        kind: 'owner_task', messageId: `owner_task:${task.id}:review_delegate`, taskId: task.id,
        projectId: project.id, runKind: 'review', triggerType: 'review_delegate', queuedAt: nowIso(),
      })
      return { runId: null, deferred: true }
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
}
