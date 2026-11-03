// src/services/scheduler.js —— 调度与 outbox 域
// 出队调度、outbox 派发、僵死运行回收与运行维护。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { effectiveRunLimits } from '../config.js'
import { badRequest } from '../errors.js'
import { applyRetention, reconcileUsage } from '../usage.js'
import { id, jsonParse, nowIso, text } from '../util.js'
import { MAX_RATE_LIMIT_RETRIES, RATE_LIMIT_CODES, isQuotaExhausted } from './backoff.js'
import { ensureTaskRelationsSchema, unsatisfiedBlockedDeps } from './task-relations.js'
import { readWriteScopes, writeScopesOverlap } from './write-scopes.js'

// plan_wait 到期派生的宽限上界：退避到期超过这个时长视为时过境迁，不再自动续跑。
const PLAN_RETRY_MAX_LATE_SECONDS = 24 * 3600

// DSHBOTS-43 人的消息保底槽：人触发的运行判定。
// 现有字段口径：chat/solo_chat 的 trigger_type 是 'mention'，dm 是 'dm'，dm_reply 是 'dm_reply'；
// 用 kind 判定最稳（solo_chat 也命中），以现有字段为准不新增列。
const HUMAN_RUN_KINDS = new Set(['chat', 'solo_chat', 'dm', 'dm_reply'])
function isHumanRun(run) {
  return HUMAN_RUN_KINDS.has(run.kind)
}

// write-lock-scope:start —— 写占用判定纯函数（DSHBOTS-73，tests/write-lock-state.test.js 断言此块）。
// 用户口径：写范围占用只看「进行中」的任务——任务一旦离开「进行中」就立刻解除占用/锁定。
// 入参：运行自身的 kind/mode + 它所属任务的当前状态 taskStatus；返回该运行是否占住项目的写槽。
//   - 只读运行（mode ≠ 'write'）不占写槽。
//   - 非任务运行（chat/dm/dm_reply 等）不绑任务，按运行自身判定，照旧占槽。
//   - 任务运行（kind = 'task'）只有任务 status = 'in_progress' 时才占槽；任务不在进行中即视为已释放。
export function runHoldsWriteLock({ kind, mode, taskStatus } = {}) {
  if (mode !== 'write') return false
  if (kind !== 'task') return true
  return taskStatus === 'in_progress'
}
// write-lock-scope:end

export const schedulerMethods = {

  // outbox：把「状态变更 → 建运行」这一跳变成可重放的持久交接。
  // 写事件时立刻落库，调度器按顺序领取投递，失败退避重试，超过上限转 failed。
  enqueueOutbox({ kind, payload = {}, projectId = null, taskId = null, sourceId = null, idempotencyKey = null, availableAt = null }) {
    const now = nowIso()
    const outboxId = id('out')
    // availableAt：延迟投递（限流退避等场景），到点前不算可领取。
    const availableIso = availableAt ? new Date(availableAt).toISOString() : now
    this.store.run(
      `INSERT INTO outbox(id, kind, project_id, task_id, source_id, idempotency_key, payload_json,
        status, attempts, available_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      outboxId, kind, projectId, taskId, sourceId, idempotencyKey,
      JSON.stringify(payload), availableIso, now,
    )
    if (idempotencyKey) {
      const existing = this.store.get('SELECT id FROM outbox WHERE idempotency_key = ?', idempotencyKey)
      if (existing && existing.id !== outboxId) return existing.id
    }
    // 事务性 outbox：记录先落库，再立即投递；投递失败留 pending，由调度器重试。
    // 延迟投递（availableAt 在未来）不立即投，由 dispatchOutbox 到点领取。
    if (availableIso <= now) this.applyOutboxRow(this.store.get('SELECT * FROM outbox WHERE id = ?', outboxId))
    return outboxId
  },

  // 单条投递：成功标记 delivered，失败按退避重试，超过上限转 failed。
  applyOutboxRow(row) {
    if (!row) return null
    try {
      const result = this.applyOutbox(row)
      this.store.run(
        "UPDATE outbox SET status = 'delivered', delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?",
        nowIso(), row.id,
      )
      return result
    } catch (error) {
      const attempts = Number(row.attempts ?? 0) + 1
      const permanent = error?.permanent === true
      const exhausted = permanent || attempts >= 5
      this.store.run(
        `UPDATE outbox SET status = ?, attempts = ?, last_error = ?, available_at = ? WHERE id = ?`,
        exhausted ? 'failed' : 'pending',
        attempts,
        text(error?.message ?? String(error), 500),
        exhausted ? row.available_at : new Date(Date.now() + Math.min(60_000, 1000 * 2 ** attempts)).toISOString(),
        row.id,
      )
      this.logger.warn?.('dsh-team: outbox %s (%s) failed: %s', row.id, row.kind, error?.message ?? error)
      return null
    }
  },

  // outbox 可见性：投递概况与失败明细（运维排查用）。
  outboxView() {
    const failed = this.store.all(
      "SELECT id, kind, task_id, source_id, attempts, last_error, created_at FROM outbox WHERE status = 'failed' ORDER BY created_at DESC LIMIT 20",
    )
    return { ...this.outboxCounts(), failed }
  },
  outboxCounts() {
    const row = this.store.get(
      `SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered
         FROM outbox`,
    )
    return {
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0),
      delivered: Number(row?.delivered ?? 0),
    }
  },

  // 领取并投递 outbox 记录；投递成功标记 delivered，失败按指数退避重试。
  dispatchOutbox() {
    const rows = this.store.all(
      "SELECT * FROM outbox WHERE status = 'pending' AND available_at <= ? ORDER BY created_at LIMIT 50",
      nowIso(),
    )
    for (const row of rows) this.applyOutboxRow(row)
  },
  applyOutbox(row) {
    const payload = jsonParse(row.payload_json, {})
    if (row.kind === 'chat_run') {
      const project = this.store.get('SELECT * FROM projects WHERE id = ?', payload.projectId)
      const bot = this.store.get('SELECT * FROM bots WHERE id = ?', payload.botId)
      if (!project || !bot || project.status !== 'active' || bot.status !== 'active') return null
      return this.enqueueChatRun(project, bot, payload.messageId)
    }
    if (row.kind === 'task_run') {
      const task = this.store.get('SELECT * FROM tasks WHERE id = ?', payload.taskId)
      if (!task) return null
      if (['done', 'canceled'].includes(task.status)) return null
      if (!task.assignee_bot_id) {
        const error = badRequest('任务没有负责人')
        error.permanent = true
        throw error
      }
      return this.enqueueTaskRun(task, payload.triggerType ?? 'task_created', { type: 'system', id: 'system' })
    }
    if (row.kind === 'owner_task_run') {
      const task = this.store.get('SELECT * FROM tasks WHERE id = ?', payload.taskId)
      if (!task || ['done', 'canceled'].includes(task.status)) return null
      return this.enqueueOwnerTaskRun(task, payload.reviewKind ?? 'review')
    }
    if (row.kind === 'memory_review') {
      const sourceRun = this.store.get('SELECT * FROM runs WHERE id = ?', payload.sourceRunId)
      if (!sourceRun) return null
      const task = sourceRun.task_id ? this.store.get('SELECT * FROM tasks WHERE id = ?', sourceRun.task_id) : null
      if (!task) return null
      const project = this.projectRow(sourceRun.project_id)
      const bot = this.botRow(sourceRun.bot_id)
      const reviewRunId = this.enqueueMemoryReview(project, bot, task, sourceRun.id)
      if (!reviewRunId) {
        // 记忆审查未启用：按规则沉淀兜底，保证任务交付有沉淀。
        this.learnFromTask(project, bot, task, sourceRun.output ?? '', sourceRun.id)
      }
      return reviewRunId
    }
    if (row.kind === 'solo_chat_run') {
      const bot = this.store.get('SELECT * FROM bots WHERE id = ?', payload.botId)
      if (!bot || bot.status !== 'active') return null
      return this.enqueueSoloChatRun(bot, payload.messageId)
    }
    if (row.kind === 'dm_run') {
      const message = this.store.get('SELECT * FROM bot_messages WHERE id = ?', payload.messageId)
      if (!message || message.status !== 'pending') return null
      const target = this.store.get('SELECT * FROM bots WHERE id = ?', message.to_bot_id)
      if (!target || target.status !== 'active') {
        this.store.run(
          "UPDATE bot_messages SET status = 'failed', reply = '目标 Bot 不可用，私信未投递', replied_at = ? WHERE id = ?",
          nowIso(), message.id,
        )
        return null
      }
      return this.enqueueDmRun(message, target)
    }
    if (row.kind === 'dm_reply') {
      const message = this.store.get('SELECT * FROM bot_messages WHERE id = ?', payload.messageId)
      if (!message || message.status !== 'replied') return null
      return this.deliverBotReply(message)
    }
    const error = badRequest(`未知的 outbox 类型 ${row.kind}`)
    error.permanent = true
    throw error
  },

  // 同一条会话上的运行必须串行；任务运行独占自己的会话，可与群聊回复并行。
  claimKey(run) {
    return run.kind === 'task' && run.task_id ? `task:${run.task_id}` : `bot:${run.bot_id}`
  },

  // 运行超时由 runtime 的定时器负责；这里补充“还活着但没有任何进展”的判定。
  async reapStalledRuns() {
    // 每次现算：全局配置页改值后无需重启，下一次巡检即用新看门狗时效。
    const stallMs = effectiveRunLimits(this.config, key => this.store.setting(key)).stallTimeoutMs
    if (!stallMs) return
    const cutoff = new Date(Date.now() - stallMs).toISOString()
    const stalled = this.store.all(
      `SELECT id, kind, started_at, last_progress_at FROM runs
       WHERE status = 'running' AND COALESCE(last_progress_at, started_at) < ?`,
      cutoff,
    )
    for (const run of stalled) {
      this.logger.warn?.('dsh-team: run %s made no progress since %s', run.id, run.last_progress_at ?? run.started_at)
      try {
        await this.runtime?.cancelRun?.(run.id)
      } catch (error) {
        this.logger.warn?.('dsh-team: cancel stalled run %s failed: %s', run.id, error)
      }
      await this.finishRun({
        runId: run.id,
        status: 'failed',
        output: '',
        error: {
          code: 'RUN_STALLED',
          message: `超过 ${Math.round(stallMs / 60_000)} 分钟没有任何进展，已中止`,
        },
      })
    }
  },
  // 限流失败的自动重试（DSHBOTS-24；DSHBOTS-38 放开到 3 次并支持合成退避）：
  // 失败 run 带 retry_after_ms（provider 真发过 Retry-After，或限流无头时 finishRun 合成的指数退避），
  // 到期派生一次新运行。限流码链最多跑到 attempt=3（1→2→3），之后转常规失败处置；
  // 非 RATE_LIMIT_CODES 的错误码不进本路径（维持只认限流码的原状）。
  // 只针对任务运行——solo/私信运行显示 plan_wait 状态但不自动派生，避免对同一个对话者重复发信。
  // 过期超过 24h 视为时过境迁不派生（服务停摆/长期搁置后不补跑旧任务）。
  // 幂等闸：task_id 非空 + 原 run 无 plan_retry 事件；idempotency_key UNIQUE 兜底并发 tick。
  // DSHBOTS-99：额度耗尽类运行（已达限额）与备用链上的运行不派生——受阻后不自己空转重试。
  retryExpiredPlanWaits() {
    const expired = this.store.all(
      `SELECT r.* FROM runs r
       WHERE r.status = 'failed' AND r.retry_after_ms IS NOT NULL
         AND r.task_id IS NOT NULL AND r.attempt < ${MAX_RATE_LIMIT_RETRIES}
         AND r.error_code IN (${[...RATE_LIMIT_CODES].map(() => '?').join(', ')})
         AND CAST(strftime('%s', COALESCE(r.ended_at, r.queued_at)) AS REAL) + r.retry_after_ms / 1000.0
             <= CAST(strftime('%s', 'now') AS REAL)
         AND CAST(strftime('%s', COALESCE(r.ended_at, r.queued_at)) AS REAL) + r.retry_after_ms / 1000.0
             > CAST(strftime('%s', 'now') AS REAL) - ${PLAN_RETRY_MAX_LATE_SECONDS}
         AND NOT EXISTS(SELECT 1 FROM run_events e WHERE e.run_id = r.id AND e.type = 'plan_retry')`,
      ...RATE_LIMIT_CODES,
    )
    for (const run of expired) {
      // DSHBOTS-99：额度耗尽（已达到限额）的运行不再自动派生重试——额度窗口用尽时重打主模型
      // 只会再撞一次额度，任务已经转受阻，不能让它自己空转。
      // 备用链上的运行同理：每条链只切一次备用，plan_retry 派生出来的是主模型运行，等于绕开限额口径。
      if (run.model_provider) continue
      // 只看错误码与错误正文：retry_after_ms 在库里既可能是 provider 的重置时间，
      // 也可能是限流链的合成退避（既有测试用 10 分钟退避当到期样本），拿它判额度会误伤 D-24/D-38 的退避派生。
      if (isQuotaExhausted({ code: run.error_code, message: run.error_message })) continue
      const task = this.store.get('SELECT * FROM tasks WHERE id = ?', run.task_id)
      if (!task || ['done', 'canceled'].includes(task.status)) continue
      // 任务已有排队/运行中的 run（如用户手动重试过）就不重复派生。
      const active = this.store.get(
        "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
        run.task_id,
      )
      if (active) continue
      const runId = id('run')
      const createdAt = nowIso()
      try {
        this.store.run(
          `INSERT INTO runs(id, project_id, bot_id, task_id, parent_run_id, kind, mode, trigger_type, trigger_ref, status,
            attempt, idempotency_key, write_scopes, queued_at)
           VALUES (?, ?, ?, ?, ?, 'task', 'write', 'plan_retry', ?, 'queued', ?, ?, ?, ?)`,
          runId, run.project_id, run.bot_id, run.task_id, run.id, run.task_id,
          (run.attempt ?? 1) + 1, `plan_retry:${run.id}`, run.write_scopes, createdAt,
        )
        this.store.run(
          'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
          id('evt'), run.id, 'plan_retry',
          `限流重试到期，派生新运行 ${runId}（attempt ${(run.attempt ?? 1) + 1}）`, createdAt,
        )
      } catch (error) {
        // idempotency_key UNIQUE 撞车 = 另一个 tick 已派生过，跳过即可。
        if (String(error).includes('UNIQUE')) continue
        throw error
      }
    }
  },

  // 陈旧排队运行守卫（DSHBOTS-110）：任务已进终态（done/canceled）后残留的 queued 运行不得再被
  // 起跑执行。统一置 canceled + error_code='SUPERSEDED'（管理清理标记，不进任务执行历史），
  // 并按 run_id EXISTS 去重写 stale_superseded 事件，重复触发不重复留痕。
  cancelQueuedRunAsSuperseded(runId) {
    const changed = this.store.run(
      `UPDATE runs SET status = 'canceled', ended_at = ?, cancel_requested = 1,
        error_code = 'SUPERSEDED', error_message = ?
       WHERE id = ? AND status = 'queued'`,
      nowIso(), '任务已结束，排队运行被清理',
      runId,
    )
    if (Number(changed?.changes ?? 0) !== 1) return false
    const alreadyNoted = this.store.get(
      "SELECT 1 AS ok FROM run_events WHERE run_id = ? AND type = 'stale_superseded'",
      runId,
    )
    if (!alreadyNoted) {
      this.store.run(
        'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
        id('evt'), runId, 'stale_superseded', '任务已结束，排队运行被清理（SUPERSEDED）', nowIso(),
      )
    }
    return true
  },
  // tick 前置清理：任务已终态（done/canceled）的 queued 任务运行直接置 canceled（SUPERSEDED），
  // 避免陈旧排队运行被起跑执行。只处理 kind='task' 的运行——非任务运行（chat/dm/审查等）不受影响。
  cancelStaleQueuedTaskRuns() {
    const rows = this.store.all(
      `SELECT r.id FROM runs r JOIN tasks t ON t.id = r.task_id
        WHERE r.status = 'queued' AND r.kind = 'task' AND t.status IN ('done', 'canceled')`,
    )
    let canceled = 0
    for (const row of rows) {
      if (this.cancelQueuedRunAsSuperseded(row.id)) canceled += 1
    }
    return canceled
  },

  async tick() {
    if (this.ticking || !this.started) return
    this.ticking = true
    try {
      // tasks 的依赖列由 task-relations 域自管迁移（db.js 不加行），闸门读列前懒迁移一次。
      ensureTaskRelationsSchema(this.store)
      // 一次性密钥 TTL 巡检（DSHBOTS-106）：内部 15s 节流，首个 tick 顺带全项目旧残留清理。
      this.sweepSecretsRuntime()
      this.runMaintenance()
      this.dispatchOutbox()
      await this.reapStalledRuns()
      this.retryExpiredPlanWaits()
      // 陈旧排队运行守卫（DSHBOTS-110）：先于候选查询清掉任务已终态的 queued 任务运行。
      this.cancelStaleQueuedTaskRuns()
      const activeRows = this.store.all(
        // 写占用只看「进行中」的任务（DSHBOTS-73，用户口径）：join tasks 取任务当前状态，
        // 任务不在 in_progress 的写运行不再占槽——离开进行中即释放占用/锁定。
        // 非任务运行 LEFT JOIN 出的 task_status 为空，按运行自身判定，不受这条闸门影响。
        `SELECT r.bot_id, r.kind, r.task_id, r.project_id, r.mode, r.write_scopes, r.trigger_type,
                t.status AS task_status
           FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
          WHERE r.status = 'running'`,
      )
      const activeKeys = new Set(activeRows.map(row => this.claimKey(row)))
      // 同项目在跑的写运行：按写范围判定能否并行。写范围为空 = 未声明 = 保守串行。
      const activeWriteScopes = new Map()
      for (const row of activeRows) {
        if (row.mode !== 'write' || !row.project_id) continue
        // 任务不在「进行中」就不占写槽（DSHBOTS-73）：写占用随任务离开进行中即时释放。
        if (!runHoldsWriteLock({ kind: row.kind, mode: row.mode, taskStatus: row.task_status })) continue
        const list = activeWriteScopes.get(row.project_id) ?? []
        list.push(readWriteScopes(row.write_scopes))
        activeWriteScopes.set(row.project_id, list)
      }
      let activeTotal = activeRows.length
      // DSHBOTS-43 人的消息保底槽：并发上限之外额外留 1 条，专给人触发的运行
      // （kind ∈ chat/solo_chat/dm/dm_reply）用——人的追问不能被机器任务队列挤死。
      // 额外槽同一时刻只放行 1 条；写范围冲突闸门照旧生效，绝不绕过。
      const maxRuns = Number(this.config.maxConcurrentRuns)
      let humanSlotTaken = activeRows.filter(isHumanRun).length > maxRuns
      if (activeTotal >= maxRuns + 1) return
      // 出队顺序：任务运行按任务优先级（urgent 先），其余运行视同 high——用户交互不能被任务积压拖死；
      // 同优先级按入队时间，保证 FIFO 不饿死老运行。
      // 候选过滤（DSHBOTS-110）：任务已终态（done/canceled）的 queued 任务运行不再领取；
      // 只排 kind='task'，非任务运行不受影响。LEFT JOIN 出 NULL 的孤儿任务运行不过滤。
      const candidates = this.store.all(
        `SELECT r.* FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
         WHERE r.status = 'queued'
           AND NOT (r.kind = 'task' AND COALESCE(t.status, '') IN ('done', 'canceled'))
         ORDER BY CASE
           WHEN r.kind <> 'task' OR t.priority IS NULL THEN 1
           WHEN t.priority = 'urgent' THEN 0
           WHEN t.priority = 'high' THEN 1
           WHEN t.priority = 'medium' THEN 2
           WHEN t.priority = 'low' THEN 3
           ELSE 4
         END, r.queued_at
         LIMIT 50`,
      )
      for (const run of candidates) {
        const human = isHumanRun(run)
        if (activeTotal >= maxRuns + (human && !humanSlotTaken ? 1 : 0)) break
        const claimKey = this.claimKey(run)
        if (activeKeys.has(claimKey)) continue
        // 同一项目共享一个工作目录：写运行之间按「声明的写范围」判定能否并行——
        // 两侧都声明了写范围且路径前缀互不重叠才放行；任一未声明（空集合）按保守串行，
        // 不降低既有安全边界。只读运行不受影响。
        // 单聊运行 project_id 为空，写锁落在各自独立的 _the_bots/<dir>，不占项目锁。
        const writeScopes = run.mode === 'write' ? readWriteScopes(run.write_scopes) : []
        if (run.mode === 'write' && run.project_id) {
          const runningScopes = activeWriteScopes.get(run.project_id) ?? []
          if (runningScopes.some(other => writeScopesOverlap(writeScopes, other))) continue
        }
        // DSHBOTS-112：单聊读图代理运行与 solo_chat 同样不带 project_id，豁免项目闸门。
        const needsProject = run.kind !== 'solo_chat' && !(run.kind === 'vision' && !run.project_id)
        const project = run.project_id ? this.store.get('SELECT * FROM projects WHERE id = ?', run.project_id) : null
        const bot = this.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
        if (!bot || (needsProject && !project)) {
          await this.finishRun({ runId: run.id, status: 'failed', output: '', error: { code: 'MISSING_CONTEXT', message: '项目或 Bot 已删除' } })
          continue
        }
        if (bot.status !== 'active' || (needsProject && project.status !== 'active')) {
          await this.finishRun({ runId: run.id, status: 'failed', output: '', error: { code: 'UNAVAILABLE', message: '项目或 Bot 不可用' } })
          continue
        }
        const budgetError = this.budgetError(needsProject ? project : null)
        if (budgetError) {
          await this.finishRun({ runId: run.id, status: 'failed', output: '', error: { code: 'BUDGET_EXCEEDED', message: budgetError } })
          continue
        }
        // 依赖闸门（DSHBOTS-59）：任务带 blocked_by 且任一依赖未 done/canceled 时不出队，
        // run 留 queued，依赖完结后下一拍自然放行（依赖满足与否由调度器判断，不进状态流转）。
        // 同一 run 只记一条 task_blocked_dep 事件（EXISTS 去重，防止每拍刷屏）。
        // 只拦 kind='task' 的任务运行：总监 review/handle 等运行不受依赖影响。
        if (run.kind === 'task' && run.task_id) {
          const taskRow = this.store.get('SELECT * FROM tasks WHERE id = ?', run.task_id)
          const blockers = unsatisfiedBlockedDeps(this.store, taskRow)
          if (blockers.length) {
            const alreadyNoted = this.store.get(
              "SELECT 1 AS ok FROM run_events WHERE run_id = ? AND type = 'task_blocked_dep'",
              run.id,
            )
            if (!alreadyNoted) {
              const projectKeyRow = this.store.get('SELECT key FROM projects WHERE id = ?', run.project_id)
              this.store.run(
                'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
                id('evt'), run.id, 'task_blocked_dep',
                `依赖未完结，暂缓领取：${blockers.map(row => `${projectKeyRow?.key ?? 'T'}-${row.number}`).join('、')}`,
                nowIso(),
              )
            }
            continue
          }
        }
        const claimed = this.store.run(
          "UPDATE runs SET status = 'running', started_at = ?, last_progress_at = ? WHERE id = ? AND status = 'queued'",
          nowIso(), nowIso(), run.id,
        )
        if (Number(claimed.changes) !== 1) continue
        // 借用了人的消息保底槽（超出并发上限放行）：记事件并占住额外槽，下一次归还前不再放第二条。
        if (human && activeTotal >= maxRuns) {
          humanSlotTaken = true
          this.store.run(
            'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
            id('evt'), run.id, 'human_slot', '并发已满，借人的消息保底槽放行', nowIso(),
          )
        }
        activeTotal += 1
        activeKeys.add(claimKey)
        if (run.mode === 'write' && run.project_id) {
          const list = activeWriteScopes.get(run.project_id) ?? []
          // 与同项目在跑的写运行写范围不重叠：记一条并行放行事件，便于事后排查。
          // 刚领取的运行本拍就占住写槽（下方随即把任务切到 in_progress）；
          // 任务已不在进行中的老运行由 write-lock-scope 块在下一拍释放，本拍不提前放行。
          const parallel = list.length > 0 && writeScopes.length > 0
          list.push(writeScopes)
          activeWriteScopes.set(run.project_id, list)
          if (parallel) {
            this.store.run(
              'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
              id('evt'), run.id, 'run_parallel', '写范围与同项目在跑的写运行不重叠，并行放行', nowIso(),
            )
          }
        }
        if (run.task_id && run.kind === 'task') {
          this.store.run(
            "UPDATE tasks SET status = 'in_progress', version = version + 1, updated_at = ? WHERE id = ? AND status NOT IN ('done', 'canceled')",
            nowIso(), run.task_id,
          )
          this.addTaskEvent(run.task_id, 'run_started', { type: 'system', id: 'system' }, { runId: run.id })
        }
        void this.executeRun(run.id)
      }
    } catch (error) {
      this.logger.error?.('dsh-team: scheduler tick failed: %s', error)
    } finally {
      this.ticking = false
    }
  },

  // 定期维护：用量对账 + 数据保留清理。
  runMaintenance({ force = false } = {}) {
    const now = Date.now()
    if (!force && now - this.lastMaintenanceAt < 10 * 60 * 1000) return null
    this.lastMaintenanceAt = now
    // 先清理再对账：被保留期清掉的明细不该再被算成「用量丢失」。
    const retention = applyRetention(this.store, {
      usageDays: Number(this.store.setting('retention_usage_days', '0') || 0),
      runEventDays: Number(this.store.setting('retention_run_event_days', '0') || 0),
      messageDays: Number(this.store.setting('retention_message_days', '0') || 0),
      reconciliationDays: Number(this.store.setting('retention_reconciliation_days', '30') || 0),
    })
    const reconciliation = reconcileUsage(this.store, { days: 30, expiredBefore: retention.usage.before })
    const reapedMessages = this.reapStuckMessages()
    return { reconciliation, retention, reapedMessages }
  },

  // 私信卡死回收：消息停在 pending 说明入队或投递链路断了。
  // 没有 outbox 行的补一条，终态 failed 的行重置后重排，
  // 免得一条私信永远停在「已入库但没人投递」的状态。
  reapStuckMessages({ minAgeMs = 60_000, limit = 50 } = {}) {
    const cutoff = new Date(Date.now() - minAgeMs).toISOString()
    const rows = this.store.all(
      "SELECT id, project_id FROM bot_messages WHERE status = 'pending' AND created_at <= ? LIMIT ?",
      cutoff, limit,
    )
    let recovered = 0
    for (const row of rows) {
      const outboxRow = this.store.get('SELECT * FROM outbox WHERE idempotency_key = ?', `dm_run:${row.id}`)
      if (!outboxRow) {
        this.enqueueOutbox({
          kind: 'dm_run',
          payload: { messageId: row.id },
          projectId: row.project_id,
          sourceId: row.id,
          idempotencyKey: `dm_run:${row.id}`,
        })
        recovered += 1
        continue
      }
      if (outboxRow.status === 'failed') {
        this.store.run(
          "UPDATE outbox SET status = 'pending', attempts = 0, available_at = ?, last_error = NULL WHERE id = ?",
          nowIso(), outboxRow.id,
        )
        recovered += 1
      }
    }
    if (recovered) this.logger.warn?.('dsh-team: 回收卡住的私信 %s 条', recovered)
    return recovered
  },
}
