// src/services/backoff.js —— 上游限流退避域（DSHBOTS-38）
// provider 限流（424 rate_limit_error 等）常不返回 Retry-After 头，直接重打会把网关打停。
// 这里按指数退避合成等待时间：1 分钟起步、每次翻倍、30 分钟封顶；确定性无 jitter，便于断言。
// 合成值只写进 runs.retry_after_ms，复用 plan_wait 等待与到期派生既有机制，不新建并行重试通道。

// 视为「等得起的限流」的错误码：缺 Retry-After 时按指数退避合成。
export const RATE_LIMIT_CODES = new Set(['RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA'])

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

// 限流但 provider 没给可用的 Retry-After（缺失/非正数）→ 需要合成指数退避。
export function needsSynthesizedBackoff(error) {
  return isRateLimitError(error) && !(Number(error?.retryAfterMs) > 0)
}
