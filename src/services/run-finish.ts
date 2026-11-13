// src/services/run-finish.ts —— 运行收尾与交付派发域
// 运行结束后的用量记账、限流退避、attention 落库，以及按运行类别分发的后续动作
// （任务交付与退回重派、私信回信、群聊/单聊回复、模型备用切换、失败转总监处理）。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.ts 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { runUsageTotals } from '../usage.js'
import { id, nowIso, parseMentions, text } from '../util.js'
import { rolloverSummaryKey } from '../config.js'
import {
  isQuotaExhausted,
  isRateLimitError,
  isRetryChainError,
  isTransientNetworkError,
  MAX_RATE_LIMIT_RETRIES,
  needsSynthesizedBackoff,
  needsTransientBackoff,
  rateLimitBackoffMs,
  transientBackoffMs,
} from './backoff.js'
import { ensureAttentionSchema, normalizeAttention } from './attention-schema.js'
import { completeVisionRun, maybeSpawnVisionAfterFailure } from './vision-proxy.js'
import { chatReply } from '../wechat/format.js'

// ── 失败终态白名单分类（DSHBOTS-267）──────────────────────────────────────
// run 失败终态进入群聊/微信回推前，先按结构化信号归入有限白名单类别，对外只透出
// 「类别+一句话摘要」；原始错误串、文件路径、请求正文不整段透传（完整信息仍落
// runs.error_message 与 run_events，供 owner 查询）。分类信号复用 D-266 的
// isTransientNetworkError（TRANSIENT_PATTERN）与既有限流/额度分类，不重复造。
// 优先级：配额 > 限流 > 沙箱拒绝 > 超时 > 网络 > 内部错误 > 未知。
const SANDBOX_DENIED_PATTERN = /(EPERM|EACCES|sandbox|file access denied|access denied)/i
const TIMEOUT_PATTERN = /timed[\s_-]?out|timeout|超时/i
const INTERNAL_PATTERN = /(internal error|EINTERNAL|INTERNAL_ERROR)/i
const FAILURE_CATEGORY_NOTICES = {
  quota: { label: '配额', summary: '模型额度耗尽，已按额度策略切换备用或转受阻。' },
  rate_limited: { label: '限流', summary: '上游限流，已按退避策略自动处理。' },
  sandbox_denied: { label: '沙箱拒绝', summary: '文件或命令操作被沙箱策略拒绝。' },
  timeout: { label: '超时', summary: '上游响应超时。' },
  network: { label: '网络', summary: '网络瞬态失败，已按退避策略自动重试。' },
  blocked: { label: '会话受阻', summary: '宿主拒绝执行该会话（可能已被归档），未产生任何模型输出。' },
  internal: { label: '内部错误', summary: '服务内部错误。' },
  unknown: { label: '未知', summary: '运行失败，完整原因见运行日志。' },
}
export function classifyFailure(error) {
  const raw = `${String(error?.code ?? '')} ${String(error?.message ?? '')}`
  if (isQuotaExhausted(error)) return FAILURE_CATEGORY_NOTICES.quota
  if (isRateLimitError(error)) return FAILURE_CATEGORY_NOTICES.rate_limited
  if (SANDBOX_DENIED_PATTERN.test(raw)) return FAILURE_CATEGORY_NOTICES.sandbox_denied
  if (TIMEOUT_PATTERN.test(raw)) return FAILURE_CATEGORY_NOTICES.timeout
  if (isTransientNetworkError(error)) return FAILURE_CATEGORY_NOTICES.network
  if (error?.code === 'SESSION_BLOCKED') return FAILURE_CATEGORY_NOTICES.blocked
  if (INTERNAL_PATTERN.test(raw)) return FAILURE_CATEGORY_NOTICES.internal
  return FAILURE_CATEGORY_NOTICES.unknown
}


export const runFinishMethods = {
  // 自动核验委派（DSHBOTS-113）：交付迁移 in_review 的同一事务内调用。开关关闭或
  // 迁移未生效（任务已终态）时静默跳过；项目无可用总监属结构性前提缺失，审计留痕后
  // 跳过（不进重试队列）。满足条件则排 review_delegate_auto outbox（立即投递一次），
  // 后续守卫冲突的退避重试与耗尽可见性由 outbox 侧统一负责。返回是否已排队。
  queueAutoReviewDelegate(task, project, run, attentionPending) {
    if (!this.autoReviewDelegateEnabled()) return false
    // 交付带提问（attention）时先让 owner 答话：核验结论会因方向未定而过时，
    // 且派生运行会顶掉 taskView 的「等待你回答」阶段；退位手动委派。
    // attentionPending 是本次完成时新落库的提问标记（run 行是完成前取的，已过期）。
    if (attentionPending) return false
    const current = this.taskRow(task.id)
    if (current.status !== 'in_review') return false
    const owner = project.owner_bot_id
      ? this.store.get("SELECT id FROM bots WHERE id = ? AND status = 'active'", project.owner_bot_id)
      : null
    if (!owner) {
      this.audit({ type: 'system', id: 'system' }, 'review.auto_delegate', 'task', task.id, { skipped: 'no_owner' })
      return false
    }
    this.enqueueOutbox({
      kind: 'review_delegate_auto',
      payload: { taskId: task.id },
      projectId: project.id,
      taskId: task.id,
      sourceId: run.id,
      // 幂等键取任务级：同一任务反复交付（被打回重交等）合并到同一行，经 coalescing 白名单
      // 刷新为最新状态复活重投；不双派由投递侧复看闸（spawnReviewDelegate 复核 in_review）保证。
      idempotencyKey: `review_auto:${task.id}`,
    })
    return true
  },
  async finishRun({ runId, status, output, error, attention }: { runId: string; status: 'succeeded' | 'failed'; output: string; error?: { code?: string; message?: string; retryAfterMs?: number }; attention?: { question?: string; options?: string[] } }) {
    const run = this.runRow(runId)
    if (!['running', 'queued'].includes(run.status)) return
    ensureAttentionSchema(this.store)
    const bot = this.store.get('SELECT * FROM bots WHERE id = ?', run.bot_id)
    const project = this.store.get('SELECT * FROM projects WHERE id = ?', run.project_id)
    this.auditReadRunWrites(run, project)
    const usage = runUsageTotals(this.store, runId, this.budgetCurrency())
    const cleanOutput = this.maskSecretValues(text(output, 120_000))
    const artifactsJson = status === 'succeeded' && run.mode === 'write' && project
      ? this.captureRunArtifacts(run, project)
      : null
    const endedAt = nowIso()
    // DSHBOTS-38：限流失败且 provider 未给 Retry-After 时合成指数退避，写进 retry_after_ms，
    // plan_wait 状态与到期派生随之自动生效。真 Retry-After 永远优先，不被合成值覆盖。
    // DSHBOTS-99：额度耗尽（已达到限额）不合成指数退避——额度窗口用尽，退避重打撞同一堵墙。
    const attemptNo = Math.max(1, Number(run.attempt) || 1)
    const quotaExhausted = isQuotaExhausted(error)
    // DSHBOTS-266：网络瞬态失败（ECONNRESET/5xx/408 等过性错误）同判合成退避，
    // 与限流共用同一 retry_after_ms 落库与 plan_wait 派生链；真 Retry-After 仍优先。
    const transientBackoff = needsTransientBackoff(error)
    const synthesizedMs = needsSynthesizedBackoff(error)
      ? rateLimitBackoffMs(attemptNo)
      : transientBackoff
        ? transientBackoffMs(attemptNo)
        : null
    // 额度耗尽时 provider 真给的重置时间照样保留（信息不丢，供 UI 显示额度恢复时间），
    // 但它不再触发对主模型的自动重试（见下方失败分支与 scheduler.retryExpiredPlanWaits）。
    const retryAfterMs = Number(error?.retryAfterMs) > 0 ? Number(error.retryAfterMs) : synthesizedMs
    this.store.run(
      `UPDATE runs SET status = ?, output = ?, artifacts = ?, error_code = ?, error_message = ?, retry_after_ms = ?, ended_at = ?,
       usage_input = ?, usage_cache_read = ?, usage_cache_write = ?, usage_output = ?, usage_cost = ?
       WHERE id = ? AND status IN ('running', 'queued')`,
      status, cleanOutput, artifactsJson, error?.code ?? null, error?.message ?? null, retryAfterMs, endedAt,
      usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens, usage.cost,
      runId,
    )
    this.store.run(
      'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      id('evt'), runId, status, error?.message ?? (status === 'succeeded' ? '完成' : ''), endedAt,
    )
    // DSHBOTS-241：撞 provider 额度墙时记录该 bot 的额度状态（含恢复时间），
    // 供派发前路由（耗尽期走备用模型/排队）与 UI 手动解除；审计 bot.quota_exhausted。
    // DSHBOTS-246：事件与状态记录同条件——只有真撞墙才写「额度耗尽」，成功运行或
    // 非额度失败一律不记，否则每个 run 收尾都污染一条额度耗尽时间线。
    if (quotaExhausted && run.bot_id && bot) {
      const effectiveProvider = run.model_provider || bot.provider
      if (effectiveProvider) {
        const quotaRecorded = this.recordBotQuotaExhaustion({
          botId: run.bot_id,
          provider: effectiveProvider,
          errorCode: error?.code ?? null,
          errorMessage: error?.message ?? '',
          retryAfterMs: Number(error?.retryAfterMs) > 0 ? Number(error.retryAfterMs) : null,
        })
        if (quotaRecorded) {
          const resetNote = quotaRecorded.resetAt ? `，预计 ${quotaRecorded.resetAt} 恢复` : ''
          this.insertRunEvent(
            runId,
            'quota_exhausted',
            `额度耗尽（${quotaRecorded.provider}）${resetNote}，耗尽期内新任务改走备用模型或排队等待`,
          )
        }
      }
    }
    // DSHBOTS-172 代码卫生：每轮运行结束扫一次项目工作区行数约定，超标即发系统指令告警
    // （去重与阈值见 hygiene.js）；扫描自身全量兜错，不阻塞收尾主流程。
    this.runCodeHygieneScan(project, runId)
    // DSHBOTS-106 一次性密钥：项目内 task 运行一结束（成功/失败都算）即焚该项目的运行时
    // 密钥文件。放在分派主体之前，不受下方任何提前 return 影响。
    if (run.kind === 'task' && run.project_id) {
      this.burnProjectSecretsRuntime(run.project_id, 'run_finish')
    }
    if (synthesizedMs) {
      const suffix = attemptNo < MAX_RATE_LIMIT_RETRIES ? '后重试' : '后转总监处理'
      this.insertRunEvent(
        runId,
        transientBackoff ? 'transient_backoff' : 'rate_limit_backoff',
        transientBackoff
          ? `网络瞬态失败（${String(error?.code ?? error?.message ?? '未知错误').slice(0, 60)}），第 ${attemptNo} 次退避，约 ${Math.round(synthesizedMs / 1000)} 秒${suffix}`
          : `上游限流（${error?.code}）未返回 Retry-After，第 ${attemptNo} 次退避，约 ${Math.round(synthesizedMs / 1000)} 秒${suffix}`,
      )
    }
    // 结构化提问（attention）：只在 bot 显式给出时落库，规范超长/超量后写入；
    // 不从 output 自由文本做任何推断（正则猜问号被明确禁止）。
    const attentionJson = JSON.stringify(normalizeAttention(attention) ?? null) === 'null'
      ? null
      : JSON.stringify(normalizeAttention(attention))
    if (attentionJson) {
      this.store.run('UPDATE runs SET attention_json = ? WHERE id = ?', attentionJson, runId)
    }
    const refreshed = this.runRow(runId)
    // DSHBOTS-112 读图代理收尾：转写成功 →「[图片转写] …」system 消息写回原消息
    // 所在会话并审计 vision.transcribe；失败/空产出 → 只审计 vision.fallback（原
    // 对话已按现状报过模型无视觉，不插消息不重试）。写回后即结束，不走下方分支。
    if (run.kind === 'vision') {
      await completeVisionRun(this, { run: refreshed, bot, status, output: cleanOutput, error })
      if (run.project_id && this.rate[run.project_id]) delete this.rate[run.project_id]
      return
    }
    if (run.kind === 'dm') {
      const message = run.trigger_ref
        ? this.store.get('SELECT * FROM bot_messages WHERE id = ?', run.trigger_ref)
        : null
      if (message) {
        if (status === 'succeeded') {
          this.store.run(
            "UPDATE bot_messages SET status = 'replied', reply = ?, replied_at = ? WHERE id = ?",
            cleanOutput || '（对方未返回文本）',
            endedAt,
            message.id,
          )
        } else {
          this.store.run(
            "UPDATE bot_messages SET status = 'failed', reply = ?, replied_at = ? WHERE id = ?",
            `私信运行失败：${error?.message ?? '未知错误'}`,
            endedAt,
            message.id,
          )
        }
        this.enqueueOutbox({
          kind: 'dm_reply',
          payload: { messageId: message.id },
          projectId: message.project_id,
          idempotencyKey: `dm_reply:${message.id}`,
        })
        void this.tick()
      }
      if (this.rate[run.project_id]) delete this.rate[run.project_id]
      return
    }
    if (run.kind === 'dm_reply') {
      // 投递运行本身无后续动作；回信内容已由 dm 运行写入 bot_messages，投递提示词在 runtime.promptFor。
      if (this.rate[run.project_id]) delete this.rate[run.project_id]
      return
    }
    if (run.kind === 'memory_review') {
      // DSHBOTS-358：记忆审查撞 provider 额度墙时切备用模型重跑同一条审查链，
      // 规则沉淀兜底留到备用链也失败时再做，避免同一次交付落两份记忆。
      const fallback = status === 'failed'
        ? this.spawnModelFallback({ run: refreshed, bot, error })
        : null
      if (fallback) {
        this.insertMessage({
          projectId: run.project_id,
          senderType: 'bot',
          senderId: bot.id,
          body: `已达限额（${error?.code ?? '未知错误'}），已切换备用模型 ${fallback.fallback.ref} 继续记忆审查。`,
          runId,
        })
      } else {
        await this.completeMemoryReview(run, status === 'succeeded' ? cleanOutput : '', error)
      }
      if (this.rate[run.project_id]) delete this.rate[run.project_id]
      return
    }
    if (run.kind === 'rollover_summary') {
      // 结转摘要（DSHBOTS-145）：成功且有正文 → 落 settings（键按 bot + 上下文），
      // 下一次会话复用时据此开新会话并注入；失败/空产出 → 只留痕，旧会话继续用，
      // 阈值仍在，后续每次复用都会重试补排（active 检查保证不重复排队）。
      if (status === 'succeeded' && cleanOutput) {
        this.store.setSetting(rolloverSummaryKey(run.bot_id, run.project_id), cleanOutput)
        this.insertRunEvent(runId, 'rollover_summary_ready', '交接摘要已就绪，下次复用将开新会话')
      } else {
        this.insertRunEvent(
          runId,
          'rollover_summary_failed',
          `交接摘要未生成：${error?.message ?? '模型未返回文本'}`,
        )
      }
      if (this.rate[run.project_id]) delete this.rate[run.project_id]
      return
    }
    if (run.kind === 'session_compact') {
      // 闲时总结压缩（DSHBOTS-286）：成功留痕即可——压缩 ≠ 结转，会话不换、不写
      // rollover 槽；总结正文留在运行产出里，窗口标记已在入队时推进，失败由下一窗口再补。
      this.insertRunEvent(
        runId,
        status === 'succeeded' && cleanOutput ? 'session_compact_done' : 'session_compact_failed',
        status === 'succeeded' && cleanOutput ? '会话总结压缩完成，留原会话继续' : `会话总结压缩未生成：${error?.message ?? '模型未返回文本'}`,
      )
      // 宿主历史折叠（单轮上下文治理 P1）：总结轮入史后把旧区间真正折叠掉（compactNow），
      // 会话前缀才实际缩小；不await收尾（折叠自带幂等锁与忙碌让路），结果按事件留痕。
      // 降级路径：宿主无 compaction 缝隙时保持仅总结轮（skipped 留痕可见，不静默）；
      // 可选调用兼容测试 StubRuntime（无该方法时静默跳过折叠）。
      void Promise.resolve(this.runtime?.compactHostSessionHistory?.(run.session_id))
        .then(outcome => {
          if (!outcome) return
          if (outcome.unavailable) {
            this.insertRunEvent(runId, 'session_compact_fold_skipped', '宿主未提供 compaction 服务，本窗口保持仅总结轮')
          } else if (outcome.folded) {
            this.insertRunEvent(
              runId,
              'session_compact_fold',
              `宿主历史折叠完成：收拢 ${outcome.shadowedItems ?? '?'} 条区间、约 ${outcome.shadowedTokens ?? '?'} token`,
            )
          } else {
            this.insertRunEvent(
              runId,
              'session_compact_fold_failed',
              `宿主历史折叠未执行（${outcome.reason}${outcome.message ? `：${outcome.message}` : ''}）`,
            )
          }
        })
        .catch(err => this.logger?.warn?.('session_compact 折叠收尾异常: %s', err?.message ?? err))
      if (this.rate[run.project_id]) delete this.rate[run.project_id]
      return
    }
    if (run.kind === 'review' || run.kind === 'handle') {
      const label = run.kind === 'review' ? '验收' : '受阻处理'
      // DSHBOTS-358：总监验收/受阻处理撞 provider 额度墙时切备用模型重跑同一条链
      // （与任务运行同口径）；派生成功就不发失败消息、不触发退回重派链。
      const fallback = status === 'failed'
        ? this.spawnModelFallback({ run: refreshed, bot, error })
        : null
      if (fallback) {
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: `已达限额（${error?.code ?? '未知错误'}），已切换备用模型 ${fallback.fallback.ref} 继续${label}。`,
          taskId: run.task_id,
          runId,
        })
      } else if (run.task_id) {
        // 委派核验运行（DSHBOTS-107）成功时，结论以任务评论写回（复用 addComment 通道：
        // 评论+事件+审计一次落全）。不改任务状态、不代为裁决——accept/return 仍归 owner。
        if (run.trigger_type === 'review_delegate' && status === 'succeeded' && cleanOutput) {
          await this.addComment(run.task_id, cleanOutput, { type: 'bot', id: bot.id })
        }
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: status === 'succeeded'
            ? (cleanOutput || `总监已完成${label}。`)
            // DSHBOTS-267：失败只透出白名单类别+摘要，不透传原始错误串。
            : `总监${label}运行失败（${classifyFailure(error).label}）：${classifyFailure(error).summary}`,
          taskId: run.task_id,
          runId,
        })
        // 验收退回或受阻重派会把任务置回 todo/in_progress；
        // 此时任务的唯一活动运行名额刚被本次运行释放，这里负责补排执行运行。
        const task = this.taskRow(run.task_id)
        if (['todo', 'in_progress'].includes(task.status) && task.assignee_bot_id) {
          this.enqueueOutbox({
            kind: 'task_run',
            payload: { taskId: task.id, triggerType: run.kind === 'review' ? 'returned' : 'redispatched' },
            projectId: task.project_id,
            taskId: task.id,
            idempotencyKey: `task:${task.id}:${run.kind === 'review' ? 'returned' : 'redispatched'}:${run.id}`,
          })
          void this.tick()
        }
        // 串联两跳（DSHBOTS-113）：委派核验运行结束后，owner_bot 卡的裁决运行在此触发——
        // 总监在尾窗读到上面写回的核验结论后 team_review_task 裁决。核验运行失败也照常触发：
        // 总监的验收运行自带子代理核验，核验跳失败不丢裁决。user 卡不裁决，维持人工验收。
        // 核验运行自身带提问时同样不排：先答话，避免裁决运行顶掉「等待你回答」阶段。
        if (run.trigger_type === 'review_delegate' && task.status === 'in_review'
          && !attentionJson
          && (task.review_target ?? 'user') === 'owner_bot') {
          this.enqueueOutbox({
            kind: 'owner_task_run',
            payload: { taskId: task.id, reviewKind: 'review' },
            projectId: task.project_id,
            taskId: task.id,
            idempotencyKey: `owner_review:${task.id}:${run.id}`,
          })
        }
      } else if (status !== 'succeeded') {
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: `总监${label}运行失败（${classifyFailure(error).label}）：${classifyFailure(error).summary}`,
          runId,
        })
      }
    } else if (status === 'succeeded') {
      if (run.task_id) {
        const task = this.taskRow(run.task_id)
        const ownerReview = (task.review_target ?? 'user') === 'owner_bot'
        let autoReviewQueued = false
        // 子代理施工硬闸已解除（原 DSHBOTS-311）：交付不再要求子代理施工账目，
        // 施工方式由 bot 自选（亲做或派「bot 名+任务号」子代理），账本（D-294）仍照记。
        this.store.transaction(() => {
          this.setTaskStatus(task.id, 'in_review', { type: 'bot', id: bot.id })
          this.store.run(
            'INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            id('cmt'), task.id, 'bot', bot.id,
            cleanOutput || '运行完成，但模型未返回文本。',
            endedAt,
          )
          this.addTaskEvent(task.id, 'run_succeeded', { type: 'bot', id: bot.id }, { runId, identifier: `${project.key}-${task.number}` })
          // 自动核验委派（DSHBOTS-113）：与 in_review 迁移同一事务触发留痕；实际派生由
          // review_delegate_auto outbox 承接（幂等键绑定本次交付运行），守卫冲突的退避重试
          // 与耗尽可见性都在 outbox 侧，任何失败都不回滚本次迁移。
          autoReviewQueued = this.queueAutoReviewDelegate(task, project, run, Boolean(attentionJson))
        })
        const summary = this.chatSummary(cleanOutput)
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: ownerReview
            ? `任务 ${project.key}-${task.number} 已交付，待总监验收。\n\n${summary}\n\n（完整记录见任务评论）`
            : `任务 ${project.key}-${task.number} 已交付，待验收。\n\n${summary}\n\n（完整记录见任务评论）`,
          taskId: task.id,
          runId,
        })
        // 微信推送不锚交付节点（DSHBOTS-182）：只在任务真正完成（→done 转换）时推一条，
        // 统一落点见 tasks.js 的 notifyTaskDone；交付后的群消息与验收指令不受影响。
        this.enqueueOutbox({
          kind: 'memory_review',
          payload: { taskId: task.id, sourceRunId: runId },
          projectId: project.id,
          taskId: task.id,
          sourceId: runId,
          idempotencyKey: `memory_review:${runId}`,
        })
        if (ownerReview && !autoReviewQueued && !attentionJson) {
          // 自动委派未接管时维持原链路（开关关 / 无可用总监）：交付后直接触发总监验收。
          // 带提问的交付同样不排——派生运行会顶掉「等待你回答」阶段，先答话再验收。
          const ownerBot = project.owner_bot_id
            ? this.store.get("SELECT id FROM bots WHERE id = ? AND status = 'active'", project.owner_bot_id)
            : null
          if (ownerBot) {
            this.enqueueOutbox({
              kind: 'owner_task_run',
              payload: { taskId: task.id, reviewKind: 'review' },
              projectId: project.id,
              taskId: task.id,
              idempotencyKey: `owner_review:${task.id}:${runId}`,
            })
          } else {
            this.insertMessage({
              projectId: project.id,
              senderType: 'system',
              senderId: 'system',
              body: `项目未配置可用的总监 Bot，任务 ${project.key}-${task.number} 请用户直接验收。`,
              taskId: task.id,
            })
          }
        }
      } else if (run.kind === 'chat') {
        const replyMessageId = this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: cleanOutput || '模型未返回文本。',
          runId,
        })
        // DSHBOTS-252：chat 运行成功回复正文与用户消息同语义解析 @mention 并派发 chat_run
        // 唤醒目标 bot。触发面仅此一处（验收/受阻摘要、失败提示、通知、任务卡、solo/dm
        // 落库一律不触发）；剥空不落库的回复（insertMessage 返回 null）同样不派发。
        const wokenBotIds = this.dispatchBotMentionRuns(project, run, bot, replyMessageId)
        if (wokenBotIds.length > 0) void this.tick()
        this.notifyWechatChat(bot, run, cleanOutput || '模型未返回文本。')
        // 群聊回复后的自动记忆审查（可在设置关闭；与任务交付审查同一队列同一幂等键规则）。
        if (this.chatMemoryReviewEnabled()) {
          this.enqueueMemoryReview(project, bot, null, runId)
        }
      } else if (run.kind === 'solo_chat') {
        const reply = cleanOutput || '模型未返回文本。'
        this.insertSoloMessage({
          botId: bot.id,
          senderType: 'bot',
          senderId: bot.id,
          body: reply,
          runId,
        })
        // DSHBOTS-258：微信通道投的项目外 director 单聊（trigger_type='wechat'），
        // 回复同样推回微信管理员；普通 UI 单聊（mention）不推。
        this.notifyWechatChat(bot, run, reply)
      }
    } else {
      // DSHBOTS-112：无视觉模型收图失败的兜底信号——错误表明模型无视觉且消息带图时补派生
      // 读图代理（幂等，与主动派生不重复）；代理未配置只审计 vision.fallback，错误按现状已报。
      if (run.kind === 'chat' || run.kind === 'solo_chat') {
        maybeSpawnVisionAfterFailure(this, { run: refreshed, bot, error })
      }
      // DSHBOTS-38：限流失败（provider 真发 Retry-After 或 finishRun 合成的指数退避）在等待期内
      // 禁止立刻重打上游——不切备用模型（备用可能走同一网关），也不立刻排总监处理运行。
      // DSHBOTS-99：额度耗尽（已达到限额）不走这条路径——不指数退避、无条件先试备用模型；
      // 瞬时限流的等待语义原样保留。
      // DSHBOTS-266：网络瞬态失败（ECONNRESET/5xx/408 等）进同一退避链——等待期内同样
      // 不切备用不排 handle，plan_retry 到期派生接管重试；attempt≤3，第 4 次照常转 blocked。
      const backoffWaitMs = isRetryChainError(error) && retryAfterMs > 0 ? retryAfterMs : 0
      // 额度耗尽不做自动重试：重置时间只当信息留着，不据此重打主模型。
      const willRetry = !quotaExhausted && backoffWaitMs > 0 && attemptNo < MAX_RATE_LIMIT_RETRIES
      // 主 provider 不可用：临时切备用模型继续跑这条任务。派生成功后任务不置 blocked、
      // 也不转总监处理——备用运行接手的是同一条任务链。
      // 瞬时限流等待中不切，等 plan_retry 到期重试；额度耗尽无条件先切备用。
      const fallback = quotaExhausted || backoffWaitMs === 0
        ? this.spawnModelFallback({ run: refreshed, bot, error })
        : null
      // provider 给的额度重置时间（仅额度耗尽时可能带）。
      const quotaResetNote = quotaExhausted && retryAfterMs > 0
        ? `（额度预计 ${Math.max(1, Math.round(retryAfterMs / 60_000))} 分钟后恢复）`
        : ''
      if (fallback) {
        this.addTaskEvent(run.task_id, 'model_fallback', { type: 'bot', id: bot.id }, {
          runId,
          fallbackRunId: fallback.runId,
          errorCode: error?.code ?? null,
          fallbackRef: fallback.fallback.ref,
        })
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: quotaExhausted
            ? `已达限额（${error?.code ?? '未知错误'}），已切换备用模型 ${fallback.fallback.ref} 继续执行。${quotaResetNote}`
            : `主模型不可用（${error?.code ?? '未知错误'}），已临时切换到备用模型 ${fallback.fallback.ref} 继续执行。`,
          taskId: run.task_id,
          runId,
        })
      } else if (run.task_id) {
        this.setTaskStatus(run.task_id, 'blocked', { type: 'bot', id: bot.id })
        this.addTaskEvent(run.task_id, 'run_failed', { type: 'bot', id: bot.id }, { runId, error })
        // 额度耗尽没有「退避后自动重试」这回事：主备都限额就是终点，任务转受阻。
        const quotaNote = quotaExhausted
          ? `\n已达限额（${error?.code ?? '未知错误'}），主备模型均不可用，任务转为受阻${quotaResetNote}。`
          : ''
        // 退避提示按失败类别措辞：瞬态抖动与限流都是「退避后自动重试」，不混用限流文案。
        const backoffKind = isTransientNetworkError(error) ? '网络瞬态失败' : '上游限流'
        const backoffVerb = isTransientNetworkError(error) ? '退避' : '指数退避'
        const backoffNote = backoffWaitMs > 0
          ? (willRetry
              ? `\n${backoffKind}，第 ${attemptNo} 次${backoffVerb}，约 ${Math.round(backoffWaitMs / 1000)} 秒后自动重试。`
              : `\n${backoffKind}，已达自动重试上限，约 ${Math.round(backoffWaitMs / 1000)} 秒后转总监处理。`)
          : ''
        // DSHBOTS-267：失败只透出白名单类别+摘要；原始错误串不进群聊（完整信息已落
        // runs.error_message 与 run_events）。quotaNote/backoffNote 仅含结构化错误码。
        const failure = classifyFailure(error)
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: `任务执行失败（${failure.label}）：${failure.summary}\n运行 ID：${runId}${quotaNote}${backoffNote}`,
          taskId: run.task_id,
          runId,
        })
        // attempt<MAX：不排 owner handle——plan_retry 到期派生接管重试，handle 运行会占住任务把派生挤掉。
        // 链耗尽（attempt>=MAX）转总监处理，但仍按退避延迟投递，到点才打上游；非限流失败照旧立即投递。
        // 额度耗尽不排 handle：主备都限额时再派总监运行只会再撞一次额度，任务留受阻等人工介入。
        if (!willRetry && !quotaExhausted) {
          this.enqueueOutbox({
            kind: 'owner_task_run',
            payload: { taskId: run.task_id, reviewKind: 'handle' },
            projectId: run.project_id,
            taskId: run.task_id,
            idempotencyKey: `owner_handle:${run.task_id}:${run.id}`,
            availableAt: backoffWaitMs > 0 ? new Date(Date.now() + backoffWaitMs) : null,
          })
        }
      } else if (run.kind === 'chat') {
        // DSHBOTS-267：群聊与微信回推共用同一份分类文案，不含原始错误串。
        const failureBody = `运行失败（${classifyFailure(error).label}）：${classifyFailure(error).summary}`
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: failureBody,
          runId,
        })
        this.notifyWechatChat(bot, run, failureBody, true)
      } else if (run.kind === 'solo_chat') {
        const failureBody = `运行失败（${classifyFailure(error).label}）：${classifyFailure(error).summary}`
        this.insertSoloMessage({
          botId: bot.id,
          senderType: 'bot',
          senderId: bot.id,
          body: failureBody,
          runId,
        })
        // DSHBOTS-258：微信通道的 solo 直达失败提示同样推回（notifyWechatChat 内部按
        // trigger_type='wechat' 门禁，普通 UI 单聊不推）。
        this.notifyWechatChat(bot, run, failureBody, true)
      }
    }
    if (run.project_id && this.rate[run.project_id]) delete this.rate[run.project_id]
  },

  // 通道直达对话回程（DSHBOTS-208/258/329）：trigger_type='wechat'/'feishu' 的运行
  // （项目群聊直达、项目外 director 专属工作区 solo 直达）结束时，把 bot 回复（或失败提示）
  // 推回来源通道管理员，出站走通道既有合批/重试治理；只推通道触发的运行，工作台群聊回复不受影响。
  // 排版（头部标记/分隔线）集中在 wechat/format.js 的 chatReply（DSHBOTS-211）。
  // DSHBOTS-326：出站经 channelNotify 扇出到各已启用通道（微信/飞书），单通道失败只留痕不阻断另一通道。
  // DSHBOTS-329：飞书触发运行同款回程——推回飞书管理员，目标会话由飞书通道的
  // store.reply_message_id 锚点决定（卡②入站时落锚，见 src/feishu/channel.ts 的 saveReplyMessageId）。
  notifyWechatChat(bot, run, body, failed = false) {
    const trigger = run?.trigger_type
    if (trigger !== 'wechat' && trigger !== 'feishu') return
    this.channelNotify?.(chatReply(bot?.name ?? 'Bot', body, failed))
  },

  // ── Bot 群聊回复 mention 唤醒（DSHBOTS-252）────────────────────────────
  // 与用户消息同语义（chat.ts sendMessage）：@xxx 用 parseMentions 解析 active 成员、
  // 显式 @ 优先（bot 路径无引用兜底道）、目标 slice(0,3)；派发走既有 chat_run outbox →
  // enqueueChatRun，串行车道经 DSHBOTS-289 收敛为 claimKey=bot:<bot>（bot 级串行），
  // 不新建串行道。防循环三护栏：
  //   ① 禁自唤醒——解析结果剔除回复 bot 自身；
  //   ② 链路深度 ≤2——chatMentionChainDepth 回溯来源链，本回复链深达 2 即不再派发；
  //   ③ 任务卡双保险——taskId 非空的消息不参与派发（群聊 messages 表无 kind 列，
  //     「kind 恒为 text」由结构保证；带 kind 的 solo 落库点不触发本派发）。
  chatMentionChainDepth(run) {
    let depth = 0
    let ref = run?.trigger_ref
    const seen = new Set()
    while (depth < 2 && ref && !seen.has(ref)) {
      seen.add(ref)
      const message = this.store.get('SELECT sender_type, run_id FROM messages WHERE id = ?', ref)
      // 人发消息与结构化 bot 落库（notify 等无 run_id 的 bot 消息）都是链根，回溯到此为止。
      if (!message || message.sender_type !== 'bot' || !message.run_id) break
      const parent = this.store.get('SELECT kind, trigger_ref FROM runs WHERE id = ?', message.run_id)
      if (!parent || parent.kind !== 'chat' || !parent.trigger_ref) break
      depth += 1
      ref = parent.trigger_ref
    }
    return depth
  },

  // 对 bot 回复正文解析 @mention 并派发 chat_run；返回被唤醒的 bot id 列表。
  // 解析对象是落库行正文（已过剥残片+密钥掩码两道清洗），与所有成员读到的转录一致。
  dispatchBotMentionRuns(project, run, bot, messageId) {
    if (!messageId) return []
    // 护栏三双保险：唯一调用点不带 taskId，这里按落库行复核，兜未来调用面扩张。
    const message = this.store.get('SELECT id, task_id, body FROM messages WHERE id = ?', messageId)
    if (!message || message.task_id) return []
    const members = this.membersOf(project.id).filter(member => member.status === 'active')
    // 护栏一：禁自唤醒——剔除回复 bot 自身。
    const targets = parseMentions(message.body, members).filter(member => member.id !== bot.id)
    if (targets.length === 0) return []
    // mentions_json 记录过滤后的全部 @ 目标（对齐用户路径的 UI mention 渲染口径），
    // 与实际派发数（slice(0,3)）允许在 >3 目标时不同。
    this.store.run(
      'UPDATE messages SET mentions_json = ? WHERE id = ?',
      JSON.stringify(targets.map(member => member.id)), messageId,
    )
    // 护栏二：链路深度 ≤2——深度达 2 的 bot 回复不再派发。
    if (this.chatMentionChainDepth(run) >= 2) return []
    // DSHBOTS-267 防循环上限（chat 路径）：每次 @ 唤醒即一条伙伴提醒，与 notify 路径
    // 共用同一 run_events 配额流；超限目标静默丢弃（allowPartnerNotice 内 warn 留痕）。
    const dispatched = targets.slice(0, 3).filter(target => this.allowPartnerNotice(run.id, target.id))
    for (const target of dispatched) {
      this.recordPartnerNotice(run.id, target.id)
      this.enqueueOutbox({
        kind: 'chat_run',
        payload: { projectId: project.id, botId: target.id, messageId, origin: null },
        projectId: project.id,
        sourceId: messageId,
        // 幂等键与用户路径（chat:<id>:<bot>）前缀区分，outbox 一眼可辨唤醒来源。
        idempotencyKey: `chat_bot:${messageId}:${target.id}`,
      })
    }
    return dispatched.map(member => member.id)
  },
}
