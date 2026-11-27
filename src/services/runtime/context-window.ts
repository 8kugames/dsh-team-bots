// src/services/runtime/context-window.js —— 语境窗域
// 增量尾窗常量、无信息量系统通知过滤与水位推进。
// 本文件只放方法体，方法挂到 DshRuntime 原型上（见 src/runtime.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

// 增量尾窗：无水位（新会话或进程重启）回退尾 12 条全量窗给足上下文；
// 有水位只注入其后的新消息；上限 24 条兜住多运行并发共用会话时的积压。
export const RECENT_FALLBACK_LIMIT = 12
export const RECENT_INCREMENTAL_LIMIT = 24

// 无信息量的系统短状态通知：状态已由 Open tasks 与任务评论通道覆盖，
// 不进尾窗（命中即整条跳过，不占窗位）。
export const NOISE_SYSTEM_BODY = /^(已写入.+记忆。|任务 \S+ 验收通过。|密钥 \S+ 的请求被拒绝。)$/

// 记忆快照召回量：memoryContextFor 由宿主渲染成历史尾部的用户快照，文本一变就追加一条，
// 条数 × 字符数直接决定每次记忆写入往活跃会话追加的体积。按更新时间取最近 8 条完整条目，
// 总长 3.5k 字符封顶，不做条内截断。
export const MEMORY_CONTEXT_LIMIT = 8
export const MEMORY_CONTEXT_MAX_CHARS = 3_500

// 审查清单的主题清单预算：memoryDigest 的主题
// 清单每轮审查都会带上，而存量条数没有上限，不设预算就会随库增长一直膨胀。
export const MEMORY_DIGEST_TOPIC_CHARS = 2_000

export const contextMethods = {
  // 增量水位尾窗：每会话维护已注入的 rowid 水位，此后每轮只注入水位之后的新消息。语义：
  // - 无水位（新会话或进程重启）→ 回退尾 RECENT_FALLBACK_LIMIT 条全量窗；
  // - 有水位 → 取 rowid > 水位的新消息（rowid 单调递增，与 created_at 排序一致）；
  // - 水位推进到取窗时刻该表 scope 内最大 rowid，只进不退；空窗也推进（越过触发消息）；
  // - 多运行并发共用同一会话：先取窗者带走积压并前移水位，后取窗者窗口为空——
  //   两条提示词进同一宿主会话历史，消息不丢不重；
  // - excludeId 排除本轮触发消息（正文已在 # Group message / # Solo message 完整呈现，不重复注入）。
  // 无会话上下文时不读不写水位，等价旧的固定尾窗。
  // store：消息尾窗读聊天库；缺省回落顶库（测试桩/独立构造）。
  watermarkWindow({ sessionId, table, columns, where, params, excludeId, store = null }) {
    const readFrom = store ?? this.store
    const advance = readFrom.get(`SELECT MAX(rowid) AS m FROM ${table} WHERE ${where}`, ...params)?.m ?? null
    const watermark = sessionId ? this.messageWatermarks.get(sessionId) : undefined
    const rows = watermark === undefined
      ? readFrom.all(
        `SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY rowid DESC LIMIT ?`,
        ...params, RECENT_FALLBACK_LIMIT,
      ).reverse()
      : readFrom.all(
        `SELECT ${columns} FROM ${table} WHERE ${where} AND rowid > ? ORDER BY rowid DESC LIMIT ?`,
        ...params, watermark, RECENT_INCREMENTAL_LIMIT,
      ).reverse()
    if (sessionId && advance !== null) {
      const current = this.messageWatermarks.get(sessionId)
      if (current === undefined || advance > current) this.messageWatermarks.set(sessionId, advance)
    }
    return {
      rows: excludeId ? rows.filter(row => row.id !== excludeId) : rows,
      incremental: watermark !== undefined,
    }
  },
}
