// src/services/model-fallback.js —— 备用模型域
// 主 provider 不可用时，临时切到 Bot 配置的备用模型继续执行任务。
// 派生运行只服务于这一条链：它结束后由「下一条运行按 Bot 主模型重新下发」实现自动回退，
// 因此本文件不写任何回退代码——回退是默认路径的自然结果。
// 方法挂到 TeamService 原型上（见 src/service.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

import { id, nowIso } from '../util.js'
import { isQuotaExhausted, isThrottleError } from './backoff.js'

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

// 可派生备用运行的内部运行种类（DSHBOTS-358）：任务运行 + 总监验收/受阻处理 + 记忆审查。
// 这些运行都在项目工作台内部流转，重跑不会重复打扰用户，因此与任务运行同口径切备用模型。
// 聊天类（chat / solo_chat / dm / vision 等）不在此列：自动重跑会重复发消息、打扰用户。
export const INTERNAL_FALLBACK_KINDS = new Set(['task', 'review', 'handle', 'memory_review'])

// 运行链标识：任务链按 task_id，记忆审查链按来源运行 id（memory_review 不挂任务）。
function fallbackChainKey(run: any) {
  if (!run) return null
  if (run.kind === 'memory_review') {
    return run.trigger_ref ? { scope: 'memory', sourceRunId: run.trigger_ref } : null
  }
  if (run.task_id) return { scope: 'task', taskId: run.task_id }
  return null
}

export function isProviderUnavailableCode(code) {
  return Boolean(code) && PROVIDER_UNAVAILABLE_CODES.has(String(code).toUpperCase())
}

// 这次失败是否该切备用模型：
// 1) 网关节流（bili_throttle_*）最高优先排除——瞬时抖动，重打会打停网关，绝不切备用；
// 2) 额度耗尽（已达到限额）直接返回 true，且不受错误码白名单限制——
//    白名单外的额度码（如 LIMIT_REACHED）额度窗口同样用尽，必须切备用；
// 3) 其余失败看白名单，且带短 Retry-After 的限流仍等待不切。
export function shouldFallbackOn(error) {
  if (isThrottleError(error)) return false
  if (isQuotaExhausted(error)) return true
  const code = String(error?.code ?? '').toUpperCase()
  if (!isProviderUnavailableCode(code)) return false
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
  // 链按运行种类分桶（DSHBOTS-358）：任务链、验收链、受阻处理链、记忆审查链各自独立——
  // 施工轮用过备用不代表总监验收轮不能再切，反之亦然。
  fallbackUsedInChain(run) {
    if (run?.model_provider) return true
    const chain = fallbackChainKey(run)
    if (!chain) return false
    if (chain.scope === 'memory') {
      const row = this.store.get(
        `SELECT id FROM runs WHERE kind = 'memory_review' AND trigger_ref = ? AND model_provider IS NOT NULL LIMIT 1`,
        chain.sourceRunId,
      )
      return Boolean(row)
    }
    const row = this.store.get(
      'SELECT id FROM runs WHERE kind = ? AND task_id = ? AND model_provider IS NOT NULL LIMIT 1',
      run.kind, chain.taskId,
    )
    return Boolean(row)
  },

  // 派生备用运行；不满足条件返回 null。调用方负责把结果告诉用户。
  spawnModelFallback({ run, bot, error }) {
    const fallback = this.botFallbackModel(bot)
    if (!fallback) return null
    if (!shouldFallbackOn(error)) return null
    // 只对内部运行派生（DSHBOTS-358）：私信/群聊/单聊自动重跑会重复发消息、打扰用户。
    if (!INTERNAL_FALLBACK_KINDS.has(run.kind)) return null
    const chain = fallbackChainKey(run)
    if (!chain) return null
    if (this.fallbackUsedInChain(run)) return null
    if (chain.scope === 'task') {
      const task = this.store.get('SELECT * FROM tasks WHERE id = ?', chain.taskId)
      if (!task || ['done', 'canceled'].includes(task.status)) return null
      // 任务已有排队/运行中的运行（唯一索引 one_active_run_per_task）就不再派生。
      const active = this.store.get(
        "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')",
        chain.taskId,
      )
      if (active) return null
    } else {
      // 记忆审查链：同一条来源运行已有排队/运行中的审查运行就不再派生。
      const active = this.store.get(
        "SELECT id FROM runs WHERE kind = 'memory_review' AND trigger_ref = ? AND status IN ('queued', 'running')",
        chain.sourceRunId,
      )
      if (active) return null
    }
    const runId = id('run')
    const createdAt = nowIso()
    const attempt = (Number(run.attempt) || 1) + 1
    // 派生运行沿用原运行的种类与形态（DSHBOTS-358）：验收/受阻处理/记忆审查各自保持
    // 原有语义与提示词通道，只是换一套模型重跑同一条链。
    const kind = run.kind
    const mode = run.mode ?? (kind === 'task' ? 'write' : 'read')
    try {
      this.store.transaction(() => {
        this.store.run(
          `INSERT INTO runs(id, project_id, bot_id, task_id, parent_run_id, kind, mode, write_scopes, trigger_type,
            trigger_ref, status, attempt, idempotency_key, model_provider, model_model, model_effort, queued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
          runId, run.project_id, run.bot_id, run.task_id, run.id,
          kind, mode, run.write_scopes ?? null,
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
