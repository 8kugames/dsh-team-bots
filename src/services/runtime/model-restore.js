// src/services/runtime/model-restore.js —— 默认模型恢复
// 宿主 sessionController.selectModel 会把本次下发的模型写成宿主默认模型，
// bot 运行结束后必须恢复成运行前的默认值，否则原生界面的默认模型会被最后一次
// 运行「偷走」。
//
// 恢复经 configEditor.edit → hmr.runExclusive 落地，而 runExclusive 用
// AsyncLocalStorage 标记事务：只要调用点还留在某个 HMR 事务的异步上下文里，
// 就会直接 reject「HMR transactions cannot be nested」。污染源有两类：
// ① selectModel 调用链残留事务上下文（调度定时器/宿主回调的个别路径）；
// ② 插件本身经 HMR 事务加载/热更（安装、热更路径）时，模块评估期创建的
//    restoreScope 捕获到的就是被标记的上下文，此后每次 runInAsyncScope 都
//    逃不出去，重试只会反复撞同一面墙（审计 model_restore_failed 成簇）。
// 对①靠模块加载期捕获的干净 scope 逃逸；对②在撞到嵌套拒绝时丢弃污染 scope、
// 从当前调用上下文自愈重捕获——事务窗口外发起的调用链是干净的，重试即可逃逸。
// 成功过一次的 scope 即证明捕获时干净，保留复用不再重建。

import { AsyncResource } from 'node:async_hooks'

// dsh-hmr runExclusive 的嵌套拒绝文本，精确匹配。
const NESTED_TRANSACTION_MESSAGE = 'HMR transactions cannot be nested'

let restoreScope = new AsyncResource('dsh-team:model-restore')

// 首次尝试 + 两次退避重试；退避基数 250ms，第 1/2 次重试分别等 250ms、750ms，
// 三次尝试整体覆盖 ≥1s，越过常见 HMR 事务窗口。
export const RESTORE_MAX_ATTEMPTS = 3
export const RESTORE_RETRY_BASE_MS = 250

// 自愈重捕获累计次数（模块级状态）；测试经 ?query 独立实例观测自愈路径。
let scopeRecaptures = 0
export function restoreScopeRecaptures() {
  return scopeRecaptures
}

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
    if (attempt > 0) await delay(retryBaseMs * (attempt * 2 - 1))
    try {
      await restoreScope.runInAsyncScope(() => defaults.saveSelection(before))
      return true
    } catch (error) {
      lastError = error
      if (error?.message === NESTED_TRANSACTION_MESSAGE) {
        // scope 被事务窗口污染（头部注释②）：丢弃并从当前上下文重捕，下次重试逃逸。
        restoreScope = new AsyncResource('dsh-team:model-restore')
        scopeRecaptures += 1
      }
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
