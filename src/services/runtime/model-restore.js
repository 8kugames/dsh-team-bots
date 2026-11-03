// src/services/runtime/model-restore.js —— 默认模型恢复
// 宿主 sessionController.selectModel 会把本次下发的模型写成宿主默认模型，
// bot 运行结束后必须恢复成运行前的默认值，否则原生界面的默认模型会被最后一次
// 运行「偷走」。
//
// 恢复经 configEditor.edit → hmr.runExclusive 落地，而 runExclusive 用
// AsyncLocalStorage 标记事务：只要调用点还留在某个 HMR 事务的异步上下文里，
// 就会直接 reject「HMR transactions cannot be nested」。插件的 selectModel 由
// 调度定时器与宿主回调触发，个别路径的上下文会跨 await 残留，因此恢复必须切到
// 干净上下文执行。本文件在模块加载期（早于任何事务）创建 AsyncResource，
// runInAsyncScope 把恢复动作切出残留上下文；setTimeout 等 timer 无法做到这点。

import { AsyncResource } from 'node:async_hooks'

const RESTORE_SCOPE = new AsyncResource('dsh-team:model-restore')

// 首次尝试 + 两次退避重试；退避基数 200ms，第 1/2 次重试分别等 200ms、400ms。
export const RESTORE_MAX_ATTEMPTS = 3
export const RESTORE_RETRY_BASE_MS = 200

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// 返回是否恢复成功。失败必须可见：重试穷尽后 warn 一次并写审计 model_restore_failed，
// 审计自身异常只 warn，不把失败抛回 selectModel 的串行链。
export async function restoreDefaultModel(defaults, before, hooks = {}) {
  const {
    logger,
    audit,
    maxAttempts = RESTORE_MAX_ATTEMPTS,
    retryBaseMs = RESTORE_RETRY_BASE_MS,
  } = hooks
  if (typeof defaults?.saveSelection !== 'function') return false
  let lastError = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await delay(retryBaseMs * attempt)
    try {
      await RESTORE_SCOPE.runInAsyncScope(() => defaults.saveSelection(before))
      return true
    } catch (error) {
      lastError = error
    }
  }
  try {
    logger?.warn?.('dsh-team: restore default model failed: %s', lastError)
  } catch {}
  try {
    audit?.(lastError)
  } catch (error) {
    try {
      logger?.warn?.('dsh-team: model restore audit failed: %s', error)
    } catch {}
  }
  return false
}
