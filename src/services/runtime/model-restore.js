// src/services/runtime/model-restore.js —— 默认模型恢复
// 宿主 sessionController.selectModel 会把本次下发的模型写成宿主默认模型，
// bot 运行结束后必须恢复成运行前的默认值，否则原生界面的默认模型会被最后一次
// 运行「偷走」。
//
// 恢复经 configEditor.edit → hmr.runExclusive 落地，而 runExclusive 用宿主 HMR
// 服务实例上的 AsyncLocalStorage（executing）标记事务：只要调用点还留在某个
// HMR 事务的异步上下文里，就直接 reject「HMR transactions cannot be nested」。
//
// 逃逸口径（DSHBOTS-175）：
// ① executing 存在且 getStore() 为真 → executing.exit(fn)。exit 的实现就是
//    run(undefined, fn)，把回调及其全部 async 延续的 store 置为 undefined，
//    runExclusive 因此看到干净上下文正常执行；逃逸只作用于回调内部，回调返回
//    后调用方的事务上下文原样保留。
// ② executing 存在且 store 为空 → 直接调用，当前上下文本就干净。
// ③ 拿不到 hmr/executing → 兜底走模块级 restoreScope.runInAsyncScope，用模块
//    评估期捕获的上下文把恢复切出污染的调用链。
// 不再使用「撞嵌套就重捕 scope」的自愈：AsyncResource 在已被污染的调用链里创建
// 只会捕获到同样污染的上下文，重试只会反复撞同一面墙，还会把模块级原本干净
// 的 restoreScope 覆盖成污染的，永久破坏退路。

import { AsyncResource } from 'node:async_hooks'

// 兜底用：模块评估期捕获的上下文。仅在拿不到 hmr 时才依赖它；此时无法判定它
// 是否被污染，故有 hmr 的 ①② 路径优先。
let restoreScope = new AsyncResource('dsh-team:model-restore')

// 首次尝试 + 两次退避重试；退避基数 250ms，第 1/2 次重试分别等 250ms、750ms，
// 三次尝试整体覆盖 ≥1s，越过常见 HMR 事务窗口。
export const RESTORE_MAX_ATTEMPTS = 3
export const RESTORE_RETRY_BASE_MS = 250

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// 返回是否恢复成功。失败必须可见：重试穷尽后 warn 一次并写审计 model_restore_failed，
// 审计自身异常只 warn，不把失败抛回 selectModel 的串行链。
// hooks.hmr：宿主 HMR 服务实例（ctx.get('hmr')），用于拿到 executing 做事务逃逸。
export async function restoreDefaultModel(defaults, before, hooks = {}) {
  const {
    logger,
    audit,
    hmr,
    maxAttempts = RESTORE_MAX_ATTEMPTS,
    retryBaseMs = RESTORE_RETRY_BASE_MS,
  } = hooks
  if (typeof defaults?.saveSelection !== 'function') return false
  const executing = hmr?.executing
  const canEscape = typeof executing?.exit === 'function' && typeof executing?.getStore === 'function'
  let lastError = null
  let escape = 'scope'
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await delay(retryBaseMs * (attempt * 2 - 1))
    try {
      if (canEscape && executing.getStore()) {
        // 事务上下文里：exit 把回调及其全部 async 延续的 store 置为 undefined，
        // runExclusive 由此看到干净上下文正常执行。
        escape = 'hmr-exit'
        await executing.exit(() => defaults.saveSelection(before))
      } else if (canEscape) {
        // 事务外：当前上下文干净，直接恢复。
        escape = 'direct'
        await defaults.saveSelection(before)
      } else {
        // 兜底：模块级干净 scope（若有）。
        escape = 'scope'
        await restoreScope.runInAsyncScope(() => defaults.saveSelection(before))
      }
      return true
    } catch (error) {
      lastError = error
    }
  }
  try {
    logger?.warn?.('dsh-team: restore default model failed: %s', lastError)
  } catch {}
  try {
    // escape 落审计：便于事后判断实际走了哪条路（hmr-exit / direct / scope）。
    audit?.(lastError, { escape })
  } catch (error) {
    try {
      logger?.warn?.('dsh-team: model restore audit failed: %s', error)
    } catch {}
  }
  return false
}
