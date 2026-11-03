// src/services/model-fallback.js —— 备用模型域
// 主 provider 不可用时，临时切到 Bot 配置的备用模型继续执行任务。
// 派生运行只服务于这一条链：它结束后由「下一条运行按 Bot 主模型重新下发」实现自动回退，
// 因此本文件不写任何回退代码——回退是默认路径的自然结果。
// 方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { id, nowIso } from '../util.js'
import { isQuotaExhausted } from './backoff.js'

// 「主 provider 不可用」白名单：这些失败码换模型/换 provider 有意义。
export const PROVIDER_UNAVAILABLE_CODES = new Set([
  'AUTH',
  'ACCOUNT_QUOTA',
  'QUOTA',
  '1308',
  'RATE_LIMIT',
  'SERVER',
  'OVERLOADED',
  'UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'TIMEOUT',
  'TRANSPORT',
  'NETWORK',
  'CONNECTION',
  'MODEL_ERROR',
  'MODEL_NOT_FOUND',
  'INVALID_MODEL',
])

// 等得起的限流：带 provider 退避时间时交给 DSHBOTS-24 的 plan_wait 等待路径，不切模型。
// 额度耗尽不在此列——它没有可等的短窗口，必须换模型。
const WAITABLE_CODES = new Set(['RATE_LIMIT', 'QUOTA'])

export function isProviderUnavailableCode(code) {
  return Boolean(code) && PROVIDER_UNAVAILABLE_CODES.has(String(code).toUpperCase())
}

// 这次失败是否该切备用模型：码在白名单里，且不是「等得起」的限流。
// 额度耗尽（已达到限额）是例外：额度窗口用尽，退避重打没有意义，直接切备用模型。
export function shouldFallbackOn(error) {
  const code = String(error?.code ?? '').toUpperCase()
  if (!isProviderUnavailableCode(code)) return false
  if (isQuotaExhausted(error)) return true
  if (WAITABLE_CODES.has(code) && Number(error?.retryAfterMs) > 0) return false
  return true
}

export const modelFallbackMethods = {
  // Bot 配置的备用模型；未配置返回 null。
  botFallbackModel(bot) {
    if (!bot?.fallback_provider || !bot?.fallback_model) return null
    return {
      provider: bot.fallback_provider,
      model: bot.fallback_model,
      effort: bot.fallback_effort || null,
      ref: `${bot.fallback_provider}/${bot.fallback_model}`,
    }
  },

  // 这条运行链是否已经用过备用模型（每条链只切一次）。
  fallbackUsedInChain(run) {
    if (run?.model_provider) return true
    if (!run?.task_id) return false
    const row = this.store.get(
      'SELECT id FROM runs WHERE task_id = ? AND model_provider IS NOT NULL LIMIT 1',
      run.task_id,
    )
    return Boolean(row)
  },

  // 派生备用运行；不满足条件返回 null。调用方负责把结果告诉用户。
  spawnModelFallback({ run, bot, error }) {
    const fallback = this.botFallbackModel(bot)
    if (!fallback) return null
    if (!shouldFallbackOn(error)) return null
    // 只对任务运行派生：私信/群聊/单聊自动重跑会重复发消息、打扰用户。
    if (run.kind !== 'task' || !run.task_id) return null
    if (this.fallbackUsedInChain(run)) return null
    const task = this.store.get('SELECT * FROM tasks WHERE id = ?', run.task_id)
    if (!task || ['done', 'canceled'].includes(task.status)) return null
    // 任务已有排队/运行中的运行（唯一索引 one_active_run_per_task）就不再派生。
    const active = this.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
      run.task_id,
    )
    if (active) return null
    const runId = id('run')
    const createdAt = nowIso()
    const attempt = (Number(run.attempt) || 1) + 1
    try {
      this.store.transaction(() => {
        this.store.run(
          `INSERT INTO runs(id, project_id, bot_id, task_id, parent_run_id, kind, mode, write_scopes, trigger_type,
            trigger_ref, status, attempt, idempotency_key, model_provider, model_model, model_effort, queued_at)
           VALUES (?, ?, ?, ?, ?, 'task', ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
          runId, run.project_id, run.bot_id, run.task_id, run.id,
          run.mode ?? 'write', run.write_scopes ?? null,
          run.trigger_type, run.trigger_ref, attempt, `model_fallback:${run.id}`,
          fallback.provider, fallback.model, fallback.effort, createdAt,
        )
        this.store.run(
          'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
          id('evt'), run.id, 'model_fallback',
          isQuotaExhausted(error)
            ? `主模型已达限额（${error?.code ?? '未知错误'}），派生备用模型运行 ${runId}（${fallback.ref}）`
            : `主模型不可用（${error?.code ?? '未知错误'}），派生备用模型运行 ${runId}（${fallback.ref}）`,
          createdAt,
        )
      })
    } catch (insertError) {
      // idempotency_key UNIQUE 撞车 = 已派生过；任务活跃运行唯一索引冲突同理。
      if (String(insertError).includes('UNIQUE')) return null
      throw insertError
    }
    return { runId, fallback, attempt }
  },
}
