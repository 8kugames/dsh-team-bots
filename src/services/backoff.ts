// src/services/backoff.js —— 上游限流退避域（DSHBOTS-38）
// provider 限流（424 rate_limit_error 等）常不返回 Retry-After 头，直接重打会把网关打停。
// 这里按指数退避合成等待时间：1 分钟起步、每次翻倍、30 分钟封顶；确定性无 jitter，便于断言。
// 合成值只写进 runs.retry_after_ms，复用 plan_wait 等待与到期派生既有机制，不新建并行重试通道。

// 视为「等得起的限流」的错误码：缺 Retry-After 时按指数退避合成。
export const RATE_LIMIT_CODES = new Set(['RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA'])

// ── 额度耗尽（DSHBOTS-99）──────────────────────────────────────────────────
// 「达到限额」与「瞬时限流」是两类失败：前者额度窗口用尽，重打多少次都一样，
// 只能换模型；后者是网关节流，短时间内会自己恢复，退避后重打即可。
// 额度耗尽一律不做指数退避，改走「切备用模型 → 主备都限额才受阻」。

// 额度耗尽错误码：1308 是网关的「5 小时使用上限」，2056 是「Token Plan 用量上限」。
export const QUOTA_EXHAUSTED_CODES = new Set(['ACCOUNT_QUOTA', 'QUOTA', '1308', '2056'])

// provider 给的 Retry-After ≥ 该阈值 = 长窗口额度重置（不是几秒钟的抖动）。
export const QUOTA_RESET_THRESHOLD_MS = 5 * 60_000

// 错误正文里的额度语义。
// 注意：provider 会改文案（「使用上限」写成「用量上限」），所以语义词要覆盖多种措辞，
// 且不能只靠措辞——判定必须同时具备「码锚点 + 多语义词」两类信号，见下方内嵌码锚点。
const QUOTA_EXHAUSTED_PATTERN = /(使用上限|用量上限|已达上限|限额|额度|quota)/i

// 网关节流标记：瞬时抖动，不属于「提示达到限额」，保留原退避路径。
const THROTTLE_PATTERN = /(bili_throttle_hold|bili_throttle_terminal)/i

// 网关内嵌码锚点：provider 把额度语义埋进正文——JSON 里的 "code":"1308"，
// 或消息尾部的括号码 "(2056)"。这类正文里的码同样是额度耗尽的硬信号，
// 不依赖中文措辞（英文文案如 "Usage limit reached for 5 hour." 也靠它兜住）。
// 匹配到的值还要再过一遍额度码集合，避免把 "bili_throttle_terminal" 之类的
// 非数字 code 误当成额度锚点。
const EMBEDDED_CODE_PATTERN = /"code"\s*:\s*"([^"]{1,16})"|\(\s*(\d{4})\s*\)/g

// 限流链的自动重试上限：attempt 1→2→3，第 3 次失败后不再派生，转常规失败处置。
export const MAX_RATE_LIMIT_RETRIES = 3

// 指数退避时长：1min / 2 / 4 / 8 / 16 / 30min（封顶）。attempt 缺失或非法按 1 计。
export function rateLimitBackoffMs(attempt) {
  const n = Math.max(1, Number(attempt) || 1)
  return Math.min(60_000 * 2 ** (n - 1), 30 * 60_000)
}

// 这次失败是不是上游限流（RATE_LIMIT / QUOTA / ACCOUNT_QUOTA）。
export function isRateLimitError(error) {
  return RATE_LIMIT_CODES.has(String(error?.code ?? '').toUpperCase())
}

// 这次失败是不是「额度耗尽」（已达到限额），而不是瞬时限流。
// 判定顺序：
// 1) 网关节流标记（bili_throttle_*）直接排除——那是瞬时抖动，重打会打停网关；
// 2) 错误码命中额度码（ACCOUNT_QUOTA / QUOTA / 1308 / 2056）→ 是额度耗尽；
// 3) 错误正文出现额度语义（使用上限/用量上限/已达上限/限额/额度/quota）→ 是额度耗尽；
// 4) 正文里出现额度码锚点（"code":"1308" / "(2056)"）→ 是额度耗尽；
// 5) provider 给的 Retry-After ≥ 5 分钟（长窗口额度）→ 是额度耗尽。
// 短 Retry-After（秒级）不构成额度耗尽信号——它本身没说「达到限额」。
export function isQuotaExhausted(error) {
  const code = String(error?.code ?? '').toUpperCase()
  const message = String(error?.message ?? '')
  if (THROTTLE_PATTERN.test(message)) return false
  if (QUOTA_EXHAUSTED_CODES.has(code)) return true
  if (QUOTA_EXHAUSTED_PATTERN.test(message)) return true
  if (hasEmbeddedQuotaCode(message)) return true
  const resetMs = Number(error?.providerRetryAfterMs ?? error?.retryAfterMs)
  return Number.isFinite(resetMs) && resetMs >= QUOTA_RESET_THRESHOLD_MS
}

// 正文里有没有额度码锚点（"code":"1308" 或 "(2056)" 形态的内嵌码）。
export function hasEmbeddedQuotaCode(message) {
  const text = String(message ?? '')
  if (!text) return false
  EMBEDDED_CODE_PATTERN.lastIndex = 0
  let match
  while ((match = EMBEDDED_CODE_PATTERN.exec(text)) !== null) {
    const value = String(match[1] ?? match[2] ?? '').toUpperCase()
    if (QUOTA_EXHAUSTED_CODES.has(value)) return true
  }
  return false
}

// 这次失败是不是网关节流（瞬时抖动）——优先级最高的排除项：
// 那是抖动不是限额，重打会打停网关，任何情况下都不该切备用模型。
export function isThrottleError(error) {
  return THROTTLE_PATTERN.test(String(error?.message ?? ''))
}

// 限流但 provider 没给可用的 Retry-After（缺失/非正数）→ 需要合成指数退避。
// 额度耗尽不合成：额度窗口用尽，重打多少次都撞同一堵墙，改走切备用模型。
export function needsSynthesizedBackoff(error) {
  if (isQuotaExhausted(error)) return false
  return isRateLimitError(error) && !(Number(error?.retryAfterMs) > 0)
}
