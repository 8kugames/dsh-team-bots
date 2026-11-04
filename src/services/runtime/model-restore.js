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
//
// 超时护栏：宿主 runExclusive 是排队执行（this.operations.then(...)），逃逸后的
// 恢复排在宿主事务队列尾。若外层事务恰好等待本次恢复，恢复永远不返回，
// selectModel 的串行链会被挂住，warn 与审计也都不会触发——比旧的「可见失败」
// 更难发现。故整个恢复过程带一个整体预算（默认 10s；hooks.timeoutMs 可覆盖，
// 但当前生产未接线——session.js 不传该参数，运行时恒为默认 10s），
// 超时按失败收口并落审计；护栏定时器不 unref，保证「这次恢复是进程唯一待办」
// 时也照常触发。
//
// 预算语义：①退避等待被截断到剩余预算内，整体阻塞不超过预算；②预算耗尽或
// 单次超时时，真实失败原因（最后一次非超时错误）作为 cause 保留在错误消息里，
// 审计与 warn 不会只看到「超时」而丢掉真正的业务错误；③超时消息里的毫秒数用
// 配置的 timeoutMs，不用剩余时间，避免审计文案抖动；④budgetExhausted 只表示
// 「因整体预算耗尽而放弃了后续尝试」，单次超时不置该标记。

import { AsyncResource } from 'node:async_hooks'

// 兜底用：模块评估期捕获的上下文。仅在拿不到 hmr 时才依赖它；此时无法判定它
// 是否被污染，故有 hmr 的 ①② 路径优先。
let restoreScope = new AsyncResource('dsh-team:model-restore')

// 首次尝试 + 两次退避重试；退避基数 250ms，第 1/2 次重试分别等 250ms、750ms，
// 三次尝试整体覆盖 ≥1s，越过常见 HMR 事务窗口。
export const RESTORE_MAX_ATTEMPTS = 3
export const RESTORE_RETRY_BASE_MS = 250

// 单次尝试的超时上限：正常路径毫秒级完成，10s 足以覆盖宿主 HMR 事务队列排队。
export const RESTORE_TIMEOUT_MS = 10_000

// 有效预算：非法值（≤0 / NaN）一律退回默认上限，不给「完全无保护」留口子。
export const resolveRestoreBudget = (timeoutMs) => (
  Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : RESTORE_TIMEOUT_MS
)

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// 失败原因的可读形态：Error 取 message，非 Error 的抛出值（字符串等）取其字面量；
// 没有原因时返回 undefined（不凭空造一个「未知原因」）。
const describeCause = (error) => {
  if (error === undefined || error === null) return undefined
  const message = error?.message
  return message === undefined ? String(error) : message
}

// 宿主唯一发出嵌套事务拒绝的地方（dsh-hmr 的 runExclusive guard）用的原文。
// 只有整句一致才算「嵌套事务拒绝」：子串匹配会把别的业务错误误判成污染。
const HOST_NESTED_REJECTION = /^HMR transactions cannot be nested$/

// 超时错误单独标记，便于与业务失败区分（超时不再重试：重试只会再排一次队）。
// cause 保留最后一次真实失败原因：超时/预算耗尽只是「没等到」，不是失败本身，
// 审计与 warn 必须同时看得见真正的业务错误。
class RestoreTimeoutError extends Error {
  constructor(ms, cause) {
    const detail = describeCause(cause)
    super(`restore default model timed out after ${ms}ms${detail ? ` (last error: ${detail})` : ''}`)
    this.name = 'RestoreTimeoutError'
    this.timedOut = true
    if (cause !== undefined && cause !== null) this.cause = cause
  }
}

// 迟到回调契约固化：被放弃的那条链迟到落地时只补一条日志，回调自身抛错也不许
// 冒泡成 unhandled rejection（work.then 派生出的 promise 无人接管）。
// 该兜底目前靠代码自证：withTimeout 未导出，外部无法注入一个会抛错的 onLate。
const notifyLate = (onLate, error) => {
  try {
    onLate?.(error)
  } catch {}
}

// 给一次尝试加超时护栏。race 会给两个 promise 都挂上处理器：超时后被放弃的
// 那条链即使随后 reject 也不会变成 unhandled rejection。
// 定时器不 unref：护栏必须在「这次恢复是进程唯一待办」时也照常触发，否则失败会
// 重新变成静默（进程带着 unsettled top-level await 直接退出，什么都不落）。
// finally 里 clearTimeout，不会把事件循环拖住。
// onLate：超时收口之后，被放弃的那条链迟到落地时回调，用于补一条观测日志
// （写入其实生效了，只是审计已记失败）。
// waitMs 是这次尝试实际可用的时间（通常是剩余预算）。护栏自己抛出的超时错误只
// 表示「这次尝试等不到」：对外的错误消息统一在 catch 里按配置的整体预算重建，
// 避免审计文案随剩余时间抖动。
const withTimeout = async (fn, waitMs, onLate) => {
  const wait = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : RESTORE_TIMEOUT_MS
  let timer = null
  let expired = false
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(new RestoreTimeoutError(wait))
    }, wait)
  })
  const work = Promise.resolve().then(fn)
  work.then(
    () => { if (expired) notifyLate(onLate, null) },
    (error) => { if (expired) notifyLate(onLate, error) },
  )
  try {
    return await Promise.race([work, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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
    timeoutMs = RESTORE_TIMEOUT_MS,
  } = hooks
  if (typeof defaults?.saveSelection !== 'function') return false
  const executing = hmr?.executing
  const canEscape = typeof executing?.exit === 'function' && typeof executing?.getStore === 'function'
  // 兜底 scope 是否被污染：拿到 executing 参照时用结构化判定（在 scope 内读事务
  // 标记，真假只看标记，不看错误文案）；拿不到参照时未知（null），此时才退回
  // 文案启发式。结构化判定优先，避免把「文案恰好一样」误记成污染。
  const scopePolluted = (() => {
    if (typeof executing?.getStore !== 'function') return null
    try {
      return Boolean(restoreScope.runInAsyncScope(() => executing.getStore()))
    } catch {
      return null
    }
  })()
  // 判定来源：结构化（读得到事务标记）/ 文案启发式（读不到参照但错误原文像宿主
  // 嵌套拒绝）/ 未知（既无参照也无文案线索）。审计词表不外扩，来源只进日志。
  let scopeJudgement = scopePolluted === null
    ? (hmr ? 'unknown-no-reference' : 'unknown-no-hmr')
    : (scopePolluted ? 'structured-polluted' : 'structured-clean')
  // 整体预算而非每次尝试各自计时：最坏阻塞从「3×timeoutMs + 退避」压到 timeoutMs。
  // timeoutMs 非法（≤0 / NaN）时退回默认值，不给「完全无保护」留口子。
  const budgetMs = resolveRestoreBudget(timeoutMs)
  const deadline = Date.now() + budgetMs
  let lastError = null
  // 最近一次真实的（非超时）失败原因：超时/预算耗尽只是「没等到」，审计必须同时
  // 看得见真正的业务错误。
  let realError = null
  let escape = 'scope'
  let timedOut = false
  // budgetExhausted 只表示「因整体预算耗尽而放弃了后续尝试」：单次尝试超时收口
  // （重试已无意义）不置该标记，别把它读成「整体预算没用完」。
  let budgetExhausted = false
  const onLate = (error) => {
    try {
      logger?.debug?.('dsh-team: restore default model 已超时收口，但恢复仍落地: %s', error ? String(error?.message ?? error) : 'ok')
    } catch {}
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // 退避不得越过整体预算：否则一次恢复能阻塞 selectModel 串行链远超预算。
      const backoff = retryBaseMs * (attempt * 2 - 1)
      await delay(Math.max(0, Math.min(backoff, deadline - Date.now())))
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      // 整体预算已用尽：按超时收口，不再发起新的尝试（再排一次队只会更久）。
      // 真实失败原因挂到 cause 上，审计不会只剩一句「超时」。
      lastError = new RestoreTimeoutError(budgetMs, realError)
      timedOut = true
      budgetExhausted = true
      break
    }
    try {
      if (canEscape && executing.getStore()) {
        // 事务上下文里：exit 把回调及其全部 async 延续的 store 置为 undefined，
        // runExclusive 由此看到干净上下文正常执行。
        escape = 'hmr-exit'
        await executing.exit(() => withTimeout(() => defaults.saveSelection(before), remaining, onLate))
      } else if (canEscape) {
        // 事务外：当前上下文干净，直接恢复。
        escape = 'direct'
        await withTimeout(() => defaults.saveSelection(before), remaining, onLate)
      } else {
        // 兜底：模块级 scope（干净与否取决于模块评估期落在哪儿）。
        escape = 'scope'
        await restoreScope.runInAsyncScope(() => withTimeout(() => defaults.saveSelection(before), remaining, onLate))
      }
      try {
        logger?.debug?.('dsh-team: restore default model ok via %s', escape)
      } catch {}
      return true
    } catch (error) {
      lastError = error
      if (error instanceof RestoreTimeoutError) {
        // 调用排在宿主事务队列尾且迟迟不落地：重试只会再排一次队，直接收口。
        // 超时只是「没等到」，真实失败原因挂到 cause 上保留。
        // 用 instanceof 而不是鸭子类型判别：宿主业务错误若带 timedOut 字段，不能
        // 被当成护栏超时（那会跳过重试并丢掉真实原因）。
        lastError = new RestoreTimeoutError(budgetMs, realError)
        timedOut = true
        break
      }
      realError = error
      if (escape === 'scope') {
        if (scopePolluted === true) {
          // 兜底 scope 自身被污染（模块评估期落在 HMR 事务里），与「scope 干净可用」
          // 区分开，便于事后判断是否属于已知的污染路径。
          escape = 'scope-polluted'
        } else if (scopePolluted === null && HOST_NESTED_REJECTION.test(String(error?.message ?? ''))) {
          // 没有结构化参照可判（拿不到 executing），才用宿主嵌套拒绝的原文做启发式
          // 判定；文案不完全一致一律不判污染。
          escape = 'scope-polluted'
          scopeJudgement = 'heuristic-nested-rejection'
        }
      }
    }
  }
  try {
    // 兜底路径的判定来源进日志：结构化判定 / 文案启发式 / 未知，事后可追；
    // 审计词表不外扩（escape 保持 hmr-exit / direct / scope / scope-polluted）。
    if (escape === 'scope' || escape === 'scope-polluted') {
      logger?.debug?.('dsh-team: restore default model 兜底 scope 判定来源: %s', scopeJudgement)
    }
  } catch {}
  try {
    logger?.warn?.('dsh-team: restore default model failed: %s', lastError)
  } catch {}
  try {
    // escape 落审计：便于事后判断实际走了哪条路（hmr-exit / direct / scope，
    // 兜底 scope 被污染时记 scope-polluted）；timedOut 标记是否为排队超时；
    // budgetExhausted 标记「因整体预算耗尽而放弃了后续尝试」；cause 带上真实
    // 失败原因——超时不等于失败原因，审计不能只剩一句「超时」。
    const cause = timedOut ? describeCause(realError) : undefined
    audit?.(lastError, {
      escape,
      ...(timedOut ? { timedOut: true } : {}),
      ...(budgetExhausted ? { budgetExhausted: true } : {}),
      ...(cause ? { cause } : {}),
    })
  } catch (error) {
    try {
      logger?.warn?.('dsh-team: model restore audit failed: %s', error)
    } catch {}
  }
  return false
}
