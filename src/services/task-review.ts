// src/services/task-review.js —— 任务验收、退回与核验委派域
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。
// 覆盖：owner/总监验收与退回（applyReview）、机器人会话验收入口（reviewFromBot）、
// 核验委派（taskReviewDelegate / spawnReviewDelegate / autoReviewDelegateEnabled）、
// 写范围编辑（taskUpdateScopes）。任务建档、状态流转与视图仍在 ./tasks.js。

import { badRequest, conflict, forbidden } from '../errors.js'
import { bool } from '../config.js'
import { REVIEWER_BOT_NAME } from '../seed-bots.js'
import { id, nowIso, text, jsonParse} from '../util.js'
import { parseWriteScopes, readWriteScopes } from './write-scopes.js'
import { effectiveSandbox } from './runtime/sandbox-policy.js'

export const taskReviewMethods = {
  async reviewFromBot(sessionId, input) {
    const { project, actor } = this.ownerContextFor(sessionId)
    if (!['accept', 'return'].includes(input.decision)) throw badRequest('验收结果只能是 accept 或 return')
    const task = this.resolveBotTask(project, input.task)
    // 验收机械闸（DSHBOTS-318）只拦真验收动作（in_review 卡）：非待验收状态保持既有
    // 校验顺序，仍由 applyReview 抛 in_review conflict，闸不抢跑。
    if (task.status === 'in_review') this.assertReviewSubagentVerified(sessionId, project, task, input.comment)
    return this.applyReview(task, project, input.decision, input.comment, actor)
  },

  // 验收核验分档开关：默认开，DSH_TEAM_REVIEW_READ_ONLY_SKIP=0 关闭回到全量强制核验。
  reviewReadOnlySkipEnabled() {
    return bool(this.config.reviewReadOnlySkip, true)
  },

  // 只读档交付判定（核验分档的单一口径）：交付运行的生效沙箱为 read-only（非写运行被
  // run_type 收紧，或任务覆盖/负责人配置档为只读）即视为只读交付——物理上写不了工作区，
  // 核验子代理重读一遍的边际价值最低。queueAutoReviewDelegate 跳过、验收闸门放宽、
  // taskReviewStatus 标记 skipped 三处共用本判定。
  readOnlyDelivery(run, taskRow) {
    if (!run || !this.reviewReadOnlySkipEnabled()) return false
    // 保守卫：mode 缺失的坏数据不豁免（DB 列 NOT NULL DEFAULT 'write'，正常不会缺），
    // 只有显式 read 运行或写运行被覆盖/配置收紧到只读才豁免。
    if (run.mode !== 'write' && run.mode !== 'read') return false
    const bot = this.store.get('SELECT id, file_policy FROM bots WHERE id = ?', run.bot_id)
    const task = taskRow ?? (run.task_id ? this.store.get('SELECT id, sandbox_override FROM tasks WHERE id = ?', run.task_id) : null)
    return effectiveSandbox(run, bot, task).mode === 'read-only'
  },

  // 验收机械闸（DSHBOTS-318/353）：把「验收必须经由子代理」从提示约束升级为机械约束——
  // owner bot 的 team_review_task 前置校验本评审周期内的子代理账目（run_events 的
  // subagent_spawned）。周期起点 T=最近一次交付（run_succeeded）或看板流转
  // （status→in_review）事件的 created_at 取 MAX；账目归属三条认领线：
  // 本任务的 owner 运行（task_id+bot_id）、调用方会话的任意运行、或本任务上的委派核验
  // 运行（task_id+trigger_type，DSHBOTS-365：核验承接人可能是成员 reviewer 而非总监，
  // 其子代理账目挂在自己名下）。两跳正规流程（review_delegate 派子代理 → 新运行只裁决）
  // 的账目挂在上一跳已结束运行上，按当运行有账查必漏，故按周期查。comment 显式注明
  // 「兜底验收」放行（对应 router 硬流程第 4 条：子代理失败重试一次仍失败时 director 兜底）。
  // 仅机器人路径：微信管理员/看板 owner 走 applyReview，不经过本闸。
  assertReviewSubagentVerified(sessionId, project, task, comment) {
    if (comment?.includes('兜底验收')) return
    // run_events 住各运行归属的聊天库（Phase 3）：先筛 runs 再逐运行查归属库，量级与旧「当运行」查询相同。
    const windowStart = this.groupChatStore(task.project_id).get(
      `SELECT MAX(created_at) AS t FROM task_events WHERE task_id = ?
        AND (type = 'run_succeeded' OR (type = 'status' AND json_extract(data_json, '$.to') = 'in_review'))`,
      task.id,
    )?.t ?? ''
    // 核验分档：本评审周期的交付运行为只读档（事件载荷 runId 指回交付运行）时免子代理
    // 账目——与自动委派豁免同口径；无交付运行锚（如纯看板流转）时保持强制，不放宽。
    // Phase 3：task_events 住项目聊天库（runs 仍顶库）：先取事件，再回顶库取运行行。
    const chat = this.groupChatStore(task.project_id)
    const event = chat.get(
      `SELECT data_json FROM task_events WHERE task_id = ? AND type = 'run_succeeded' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1`,
      task.id, windowStart,
    )
    const deliveredRunId = event ? (jsonParse(event.data_json, {}) ?? {}).runId : null
    const delivered = deliveredRunId
      ? this.store.get('SELECT * FROM runs WHERE id = ?', deliveredRunId)
      : null
    if (delivered && this.readOnlyDelivery(delivered, task)) return
    const candidates = this.store.all(
      `SELECT id, project_id, bot_id FROM runs
        WHERE (task_id = ? AND bot_id = ?) OR session_id = ?
          OR (task_id = ? AND trigger_type = 'review_delegate')`,
      task.id, project.owner_bot_id, sessionId, task.id,
    )
    const ledger = candidates.some(run => this.runChatStore(run).get(
      "SELECT 1 AS hit FROM run_events WHERE run_id = ? AND type = 'subagent_spawned' AND created_at >= ?",
      run.id, windowStart,
    ))
    if (ledger) return
    // DSHBOTS-269 失败语义引导：拒绝文案 = 原因 + 正确下一步。
    throw badRequest(
      '本次评审没有子代理账目（subagent_spawned），验收必须先经子代理核验：'
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
      // 验收边界沉淀提醒：落待提醒标记，负责人下次在该项目运行时搭车渲染（零额外轮次）。
      this.noteTaskAccepted(this.taskRow(task.id))
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

  // 验收核验委派（DSHBOTS-107；DSHBOTS-365 承接人默认 reviewer）：待验收任务上，owner
  // 一键委派子代理核验——承接人优先项目内种子 reviewer（reviewDelegateBotFor），无则
  // 总监 Bot 兜底，由其会话内的 subagent/subagent_fork 并行完成（提示词见
  // runtime/prompt.js 的 review-verification 模板）。核验结论以任务评论写回（finishRun
  // 复用 addComment 通道），不改任务状态、不代负责人裁决：accept/return 仍由 owner 经
  // team_review_task 或看板执行，本方法不碰任务状态。
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
    // 派单清洗：与派单入口同口径——ignored 染色（进 ignored_write_scopes，不参与并行锁）
    // + 一级目录驳回；有效与染色清单同时为空才落「写范围不能为空」拒绝。
    const { scopes, ignored } = this.normalizeDispatchScopes(this.projectRow(task.project_id), parsedScopes, { actor, taskId })
    if (!scopes.length && !ignored.length) throw badRequest('写范围不能为空：未声明的写运行会与同项目所有写运行保守串行')
    const runningWrite = this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND status = 'running' AND mode = 'write'",
      taskId,
    )
    if (runningWrite) throw badRequest('任务有运行中的写运行，先等运行结束或取消，再修改写范围')
    const queuedWrites = this.store.all(
      "SELECT id, project_id, bot_id FROM runs WHERE task_id = ? AND status = 'queued' AND mode = 'write'",
      taskId,
    )
    const from = readWriteScopes(task.write_scopes)
    const serialized = JSON.stringify(scopes)
    const ignoredSerialized = JSON.stringify(ignored)
    this.store.transaction(() => {
      this.store.run(
        'UPDATE tasks SET write_scopes = ?, ignored_write_scopes = ?, version = version + 1, updated_at = ? WHERE id = ?',
        serialized, ignoredSerialized, nowIso(), taskId,
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

  // 核验承接人（DSHBOTS-365 产品默认）：项目成员里的种子 reviewer 优先（固定名识别，
  // 改名/移除/不可用即失效），回落总监自行核验（兜底）。裁决权不变：仍归 owner。
  reviewDelegateBotFor(project) {
    if (!project.owner_bot_id) return null
    return this.store.get(
      `SELECT b.* FROM bots b
        JOIN project_members m ON m.member_type = 'bot' AND m.member_id = b.id
        WHERE m.project_id = ? AND b.name = ? AND b.status = 'active' AND b.id <> ?
        LIMIT 1`,
      project.id, REVIEWER_BOT_NAME, project.owner_bot_id,
    )
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
    // 核验承接人：优先成员 reviewer（DSHBOTS-365），无则总监兜底。
    const verifier = this.reviewDelegateBotFor(project) ?? owner
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
    // DSHBOTS-358：额度路由（与任务运行同口径）——主 provider 耗尽时走备用模型，
    // 无可用备用则留 queued 等恢复；路由快照写进运行行的 model_* 三列。
    const routing = this.quotaRoutingForBot(verifier)
    const routeProvider = routing.mode === 'fallback' ? routing.provider : null
    const routeModel = routing.mode === 'fallback' ? routing.model : null
    const routeEffort = routing.mode === 'fallback' ? routing.effort : null
    // busy 闸（DSHBOTS-290）：承接人忙时不落 runs 行（撞 one_active_run_per_bot），挂待
    // 处理队列空闲建回（insertHeldMessageRun 的 owner_task 分支）；返回 deferred 让
    // 手动入口与 outbox 自动入口都能感知「已挂起」而非失败。
    const hold = () => this.holdPendingMessage(verifier.id, project.id, {
      kind: 'owner_task', messageId: `owner_task:${task.id}:review_delegate`, taskId: task.id,
      projectId: project.id, runKind: 'review', triggerType: 'review_delegate', queuedAt: nowIso(),
      routing: routing.mode === 'fallback'
        ? { mode: 'fallback', provider: routing.provider, model: routing.model, effort: routing.effort, ref: routing.ref }
        : routing.mode === 'wait'
          ? { mode: 'wait', resetAt: routing.resetAt }
          : { mode: 'primary' },
    })
    if (this.botBusy(verifier.id, project.id)) {
      hold()
      return { runId: null, deferred: true }
    }
    const runId = id('run')
    const createdAt = nowIso()
    try {
      this.store.run(
        `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
          attempt, idempotency_key, model_provider, model_model, model_effort, queued_at)
         VALUES (?, ?, ?, ?, 'review', 'read', 'review_delegate', ?, 'queued', 1, ?, ?, ?, ?, ?)`,
        runId, project.id, verifier.id, task.id, task.id, `review_delegate:${task.id}:${Date.now()}:${runId}`,
        routeProvider, routeModel, routeEffort, createdAt,
      )
    } catch (error) {
      // 查后插竞态（DSHBOTS-300 同款）：busy 检查与 INSERT 之间承接人被占用，撞
      // one_active_run_per_bot——挂待处理队列空闲建回，同 busy 闸返回 deferred，不向上抛。
      if (this.isRunBotUniqueViolation(error)) {
        hold()
        return { runId: null, deferred: true }
      }
      throw error
    }
    this.runChatStore({ project_id: project.id, bot_id: verifier.id }).run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, 'queued',
      `${origin === 'auto' ? '交付后自动' : 'owner'}委派子代理核验（${actor.type}:${actor.id}）`, createdAt,
    )
    if (routing.mode === 'fallback') {
      const run = this.store.get('SELECT * FROM runs WHERE id = ?', runId)
      this.insertRunEvent(run.id, 'quota_fallback', `主 provider 额度耗尽，本次直接走备用模型 ${routing.ref}`)
    } else if (routing.mode === 'wait') {
      const run = this.store.get('SELECT * FROM runs WHERE id = ?', runId)
      this.insertRunEvent(run.id, 'quota_wait', `主 provider 额度耗尽且无可用备用模型，排队等待至 ${routing.resetAt ?? '恢复'}`)
    }
    this.audit(actor, origin === 'auto' ? 'review.auto_delegate' : 'task.review_delegate', 'task', task.id, { runId })
    void this.tick()
    return { runId, reused: false }
  },

  // 自动委派开关（DSHBOTS-113）：默认开，DSH_TEAM_AUTO_REVIEW_DELEGATE=0 关闭回到纯手动。
  autoReviewDelegateEnabled() {
    return bool(this.config.autoReviewDelegate, true)
  },
}
