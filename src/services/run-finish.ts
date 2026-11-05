// src/services/run-finish.js —— 运行收尾与交付派发域
// 运行结束后的用量记账、限流退避、attention 落库，以及按运行类别分发的后续动作
// （任务交付与退回重派、私信回信、群聊/单聊回复、模型备用切换、失败转总监处理）。
// 本文件只放方法体，方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { runUsageTotals } from '../usage.js'
import { id, nowIso, text } from '../util.js'
import { rolloverSummaryKey } from '../config.js'
import {
  isQuotaExhausted,
  isRateLimitError,
  MAX_RATE_LIMIT_RETRIES,
  needsSynthesizedBackoff,
  rateLimitBackoffMs,
} from './backoff.js'
import { ensureAttentionSchema, normalizeAttention } from './attention-schema.js'
import { completeVisionRun, maybeSpawnVisionAfterFailure } from './vision-proxy.js'

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
    const synthesizedMs = needsSynthesizedBackoff(error) ? rateLimitBackoffMs(attemptNo) : null
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
        'rate_limit_backoff',
        `上游限流（${error?.code}）未返回 Retry-After，第 ${attemptNo} 次退避，约 ${Math.round(synthesizedMs / 1000)} 秒${suffix}`,
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
      await this.completeMemoryReview(run, status === 'succeeded' ? cleanOutput : '', error)
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
    if (run.kind === 'review' || run.kind === 'handle') {
      const label = run.kind === 'review' ? '验收' : '受阻处理'
      if (run.task_id) {
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
            : `总监${label}运行失败：${error?.message ?? '未知错误'}`,
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
          body: `总监${label}运行失败：${error?.message ?? '未知错误'}`,
          runId,
        })
      }
    } else if (status === 'succeeded') {
      if (run.task_id) {
        const task = this.taskRow(run.task_id)
        const ownerReview = (task.review_target ?? 'user') === 'owner_bot'
        let autoReviewQueued = false
        this.store.transaction(() => {
          this.store.run(
            `UPDATE tasks SET status = 'in_review', version = version + 1, updated_at = ?
             WHERE id = ? AND status NOT IN ('done', 'canceled')`,
            endedAt, task.id,
          )
          this.store.run(
            'INSERT INTO task_comments(id, task_id, author_type, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            id('cmt'), task.id, 'bot', bot.id, cleanOutput || '运行完成，但模型未返回文本。', endedAt,
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
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: cleanOutput || '模型未返回文本。',
          runId,
        })
        // 群聊回复后的自动记忆审查（可在设置关闭；与任务交付审查同一队列同一幂等键规则）。
        if (this.chatMemoryReviewEnabled()) {
          this.enqueueMemoryReview(project, bot, null, runId)
        }
      } else if (run.kind === 'solo_chat') {
        this.insertSoloMessage({
          botId: bot.id,
          senderType: 'bot',
          senderId: bot.id,
          body: cleanOutput || '模型未返回文本。',
          runId,
        })
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
      const backoffWaitMs = isRateLimitError(error) && retryAfterMs > 0 ? retryAfterMs : 0
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
        this.store.run(
          "UPDATE tasks SET status = 'blocked', version = version + 1, updated_at = ? WHERE id = ? AND status NOT IN ('done', 'canceled')",
          endedAt, run.task_id,
        )
        this.addTaskEvent(run.task_id, 'run_failed', { type: 'bot', id: bot.id }, { runId, error })
        // 额度耗尽没有「退避后自动重试」这回事：主备都限额就是终点，任务转受阻。
        const quotaNote = quotaExhausted
          ? `\n已达限额（${error?.code ?? '未知错误'}），主备模型均不可用，任务转为受阻${quotaResetNote}。`
          : ''
        const backoffNote = backoffWaitMs > 0
          ? (willRetry
              ? `\n上游限流，第 ${attemptNo} 次指数退避，约 ${Math.round(backoffWaitMs / 1000)} 秒后自动重试。`
              : `\n上游限流，已达自动重试上限，约 ${Math.round(backoffWaitMs / 1000)} 秒后转总监处理。`)
          : ''
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: `任务执行失败：${error?.message ?? '未知错误'}\n运行 ID：${runId}${quotaNote}${backoffNote}`,
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
        this.insertMessage({
          projectId: project.id,
          senderType: 'bot',
          senderId: bot.id,
          body: `运行失败：${error?.message ?? '未知错误'}`,
          runId,
        })
      } else if (run.kind === 'solo_chat') {
        this.insertSoloMessage({
          botId: bot.id,
          senderType: 'bot',
          senderId: bot.id,
          body: `运行失败：${error?.message ?? '未知错误'}`,
          runId,
        })
      }
    }
    if (run.project_id && this.rate[run.project_id]) delete this.rate[run.project_id]
  },
}
