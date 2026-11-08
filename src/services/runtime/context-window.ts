// src/services/runtime/context-window.js —— 语境窗域
// 增量尾窗常量、无信息量系统通知过滤与水位推进。
// 本文件只放方法体，方法挂到 DshRuntime 原型上（见 src/runtime.js 的 defineMethods 调用），
// 因此方法体内的 this 与拆分前完全一致。

// 增量尾窗（DSHBOTS-96 P1-1）：无水位（新会话或进程重启）回退尾 12 条全量窗给足上下文；
// 有水位只注入其后的新消息；上限 24 条兜住多运行并发共用会话时的积压。
export const RECENT_FALLBACK_LIMIT = 12
export const RECENT_INCREMENTAL_LIMIT = 24

// 无信息量的系统短状态通知（DSHBOTS-96 P3-1）：状态已由 Open tasks 与任务评论通道覆盖，
// 不再重复进尾窗（命中即整条跳过，不占窗位）。
export const NOISE_SYSTEM_BODY = /^(已写入.+记忆。|任务 \S+ 验收通过。|密钥 \S+ 的请求被拒绝。)$/

// 记忆快照召回量（单轮上下文治理 P4）：memoryContextFor 由宿主渲染成历史尾部的用户
// 快照，文本一变就追加一条——live 实测条均 ~400 字符，16 条恰好顶满 7k 截断，等于每次
// 记忆写入都往活跃会话追加约 3.5k token 的近似快照。降为 8 条 + 3.5k 封顶（按更新时间
// 取最近 8 条完整条目，不做条内截断），单次追加体积减半；历史侧增长由 P1 折叠兜底。
export const MEMORY_CONTEXT_LIMIT = 8
export const MEMORY_CONTEXT_MAX_CHARS = 3_500

export const contextMethods = {
  // 增量水位尾窗（DSHBOTS-96 P1-1）：每会话维护已注入的 rowid 水位，此后每轮只注入
  // 水位之后的新消息，替代旧的「尾 12 条×240 摘录每轮重烧」。语义：
  // - 无水位（新会话或进程重启）→ 回退尾 RECENT_FALLBACK_LIMIT 条全量窗；
  // - 有水位 → 取 rowid > 水位的新消息（rowid 单调递增，与 created_at 排序一致）；
  // - 水位推进到取窗时刻该表 scope 内最大 rowid，只进不退；空窗也推进（越过触发消息）；
  // - 多运行并发共用同一会话：先取窗者带走积压并前移水位，后取窗者窗口为空——
  //   两条提示词进同一宿主会话历史，消息不丢不重；
  // - excludeId 排除本轮触发消息（正文已在 # Group message / # Solo message 完整呈现，不再双份）。
  // 无会话上下文时不读不写水位，等价旧的固定尾窗。
  watermarkWindow({ sessionId, table, columns, where, params, excludeId }) {
    const advance = this.store.get(`SELECT MAX(rowid) AS m FROM ${table} WHERE ${where}`, ...params)?.m ?? null
    const watermark = sessionId ? this.messageWatermarks.get(sessionId) : undefined
    const rows = watermark === undefined
      ? this.store.all(
        `SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY rowid DESC LIMIT ?`,
        ...params, RECENT_FALLBACK_LIMIT,
      ).reverse()
      : this.store.all(
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
