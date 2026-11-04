// 排队气泡的乐观渲染与终态驻留（DSHBOTS-150）。
// DSHBOTS-159 从 ui/app.js 的 typing-linger 标记块外迁：纯逻辑 + 模块级短命台账，不碰滚动。
// 反向依赖 app.js 的 runStatusLabel（调用期解析：函数声明已提升，无 TDZ）。
import { state } from './state.js'
import { attr, avatar, botById, duration, esc } from './util.js'
import { t } from './i18n.js'
import { runStatusLabel } from '../app.js'

// typing-linger:start —— 排队气泡的乐观渲染与终态驻留（DSHBOTS-150）
// 场景：bot 被 @ 触发的 chat 运行从入队到完成常短于 2.8s 轮询周期，气泡肉眼看不见。
// 两段式：①发送成功后本地立刻为被 @ 的目标 bot 立一条排队气泡（不等下一拍轮询）；
//         ②真实运行进入终态后气泡再驻留几秒淡出移除，同拍已有真实回复则跳过驻留。
// 本块是纯逻辑（不碰 DOM）：台账合并与渲染行计算都在这里，测试按本标记块抽取断言。
// 台账是时间戳驱动的短命数据——乐观气泡有 TTL、驻留气泡有到期时刻，到期即丢弃，不留全局长驻状态。

// 终态气泡的总驻留时长（3–5s 区间取 4s）：末段 TYPING_LINGER_FADE_MS 走淡出。
const TYPING_LINGER_MS = 4000
// 淡出时长：驻留末段线性淡出到 0 后移除。
const TYPING_LINGER_FADE_MS = 1500
// 乐观气泡最长存活：真实运行迟迟不进列表（派单失败等）则丢弃，气泡不长期挂着。
const TYPING_OPTIMISTIC_TTL_MS = 20000
const TYPING_TERMINAL_STATUS = ['succeeded', 'failed', 'canceled']

// 气泡主键：kind + 会话 scope + bot——一个 bot 在一个会话里同时只有一条气泡。
function typingBubbleKey(kind, scope, botId) {
  return `${kind}:${scope}:${botId}`
}

// 运行的会话归属：单聊运行按 bot、群聊运行按项目。
function typingScopeOf(run) {
  if (run?.kind === 'solo_chat') return `solo:${run.bot_id ?? ''}`
  return `group:${run.project_id ?? ''}`
}

// 运行视图缺 project_id 时按同类型放行（不因字段缺失丢掉真实运行的接管）。
function typingScopeMatches(run, scope) {
  const runScope = typingScopeOf(run)
  return runScope.endsWith(':') ? true : runScope === scope
}

// 同一 bot 可能同时挂着排队中与运行中的旧运行：只取最近一条（queued_at 最大）。
function latestTypingRuns(runs, scope) {
  const latest = new Map()
  for (const run of runs ?? []) {
    if (run?.kind !== 'chat' && run?.kind !== 'solo_chat') continue
    if (!typingScopeMatches(run, scope)) continue
    const key = typingBubbleKey(run.kind, scope, run.bot_id)
    const prev = latest.get(key)
    if (!prev || String(run.queued_at ?? '') >= String(prev.queued_at ?? '')) latest.set(key, run)
  }
  return latest
}

// 消息按 kind 分桶：群聊消息与单聊消息不同源，混用会误判「已有回复」。
function typingMessagesFor(messages, kind) {
  if (Array.isArray(messages)) return messages
  return messages?.[kind] ?? []
}

// 同拍是否已有该 bot 的真实回复：有则跳过驻留（回复本身就是可见结果，不必再占一条气泡）。
function hasReplySince(messages, botId, sinceMs) {
  if (!botId) return false
  for (const message of messages ?? []) {
    if (message?.sender_type !== 'bot' || message?.sender_id !== botId) continue
    const at = Date.parse(message.created_at ?? '')
    if (!Number.isFinite(at)) continue
    if (!sinceMs || at >= sinceMs) return true
  }
  return false
}

// 同拍是否已有该 bot 的真实回复：bot 回复消息带 run_id，按运行精确匹配最准
// （不会把该 bot 更早一轮的迟到回复算作本轮回复）；没有运行归属时退回「发送者 + 时间」近似。
function hasReplyForRun(messages, runId, botId, sinceMs) {
  if (runId) {
    for (const message of messages ?? []) {
      if (message?.run_id === runId) return true
    }
    return false
  }
  return hasReplySince(messages, botId, sinceMs)
}

// 运行是否比乐观气泡更新：乐观气泡只被「比它更新的运行」接管。
// 更早的运行属于上一轮消息，不能盖掉本轮刚立的排队行（否则上一轮的终态会把新气泡写成「已成功」）。
function runIsNewerThan(run, sinceMs) {
  const at = Date.parse(run?.queued_at ?? run?.started_at ?? '')
  if (!Number.isFinite(at)) return true
  if (!sinceMs) return true
  return at >= sinceMs
}

// 乐观气泡：发送成功后立刻为被 @ 的目标 bot 立一条排队行，不等下一拍轮询。
// 该 bot 已有在途气泡时不重复立（同一个 bot 不出现两行）。
function addOptimisticTypingBubble(ledger, { kind, scope, botId, botName = 'Bot', now = Date.now() }) {
  const key = typingBubbleKey(kind, scope, botId)
  const prior = ledger.get(key)
  if (prior && !prior.lingerUntil) return ledger
  const next = new Map(ledger)
  next.set(key, {
    key,
    kind,
    scope,
    botId,
    botName,
    status: 'queued',
    startedAt: new Date(now).toISOString(),
    runId: null,
    optimistic: true,
    lingerUntil: null,
    createdAt: now,
    since: now,
  })
  return next
}

// 台账合并（纯函数，返回新台账不改入参）：真实运行接管乐观气泡 → 终态转驻留 → 回复到齐则跳过驻留。
function reconcileTypingBubbles(ledger, { runs = [], messages = {}, scope = '', now = Date.now(), lingerMs = TYPING_LINGER_MS, optimisticTtlMs = TYPING_OPTIMISTIC_TTL_MS } = {}) {
  const latest = latestTypingRuns(runs, scope)
  const next = new Map()
  for (const [key, run] of latest) {
    // ① 真实活跃运行接管：状态与耗时起点以运行为准（乐观气泡就此让位，不再重复画）。
    if (!['queued', 'running'].includes(run.status)) continue
    const prior = ledger.get(key)
    // 乐观气泡只被比它更新的运行接管：更早的运行属于上一轮，不能盖掉本轮的排队行。
    if (prior?.optimistic && !runIsNewerThan(run, prior.since)) continue
    next.set(key, {
      key,
      kind: run.kind,
      scope,
      botId: run.bot_id,
      botName: run.botName ?? prior?.botName ?? 'Bot',
      status: run.status,
      startedAt: run.started_at ?? run.queued_at ?? null,
      runId: run.id ?? null,
      optimistic: false,
      lingerUntil: null,
      createdAt: now,
      since: Date.parse(run.queued_at ?? run.started_at ?? '') || now,
    })
  }
  for (const [key, bubble] of ledger) {
    if (next.has(key)) continue
    if (bubble.scope !== scope) continue
    if (bubble.lingerUntil) {
      // ② 驻留中：不因后续轮询延长；同拍补到真实回复则直接撤掉（回复已可见）。
      if (hasReplyForRun(typingMessagesFor(messages, bubble.kind), bubble.runId, bubble.botId, bubble.since)) continue
      if (now < bubble.lingerUntil) next.set(key, bubble)
      continue
    }
    const run = latest.get(key)
    if (run && TYPING_TERMINAL_STATUS.includes(run.status)) {
      // 上一轮就结束的运行不算本轮终态：乐观气泡继续挂着排队行，等本轮自己的运行。
      if (bubble.optimistic && !runIsNewerThan(run, bubble.since)) {
        if (now - bubble.createdAt < optimisticTtlMs) next.set(key, bubble)
        continue
      }
      // ③ 真实运行进入终态：同拍已有真实回复就跳过驻留，否则驻留到 lingerUntil 再淡出移除。
      if (hasReplyForRun(typingMessagesFor(messages, bubble.kind), run.id ?? bubble.runId, bubble.botId, bubble.since)) continue
      next.set(key, { ...bubble, status: run.status, runId: run.id ?? bubble.runId, optimistic: false, lingerUntil: now + lingerMs })
      continue
    }
    // ④ 其余（乐观气泡、运行已不在列表里的活跃气泡）：按 TTL 兜底丢弃，不留长驻状态。
    if (now - bubble.createdAt < optimisticTtlMs) next.set(key, bubble)
  }
  return next
}

// 驻留末段的透明度：剩余时间不足淡出窗口时线性淡出，到期为 0。
function typingLingerOpacity(bubble, now = Date.now()) {
  if (!bubble?.lingerUntil) return 1
  const remaining = bubble.lingerUntil - now
  if (remaining >= TYPING_LINGER_FADE_MS) return 1
  return Math.max(0, remaining / TYPING_LINGER_FADE_MS)
}

// 渲染行：真实活跃运行由 DSHBOTS-1 的 typingRows 负责；这里只补乐观气泡与终态驻留行，
// 并按活跃 bot 去重——真实运行接管后同一 bot 只出现一行。
function typingLingerRows(ledger, kind, runs, scope, now = Date.now()) {
  const activeBotIds = new Set((runs ?? [])
    .filter(run => run?.kind === kind && ['queued', 'running'].includes(run.status))
    .map(run => run.bot_id))
  return [...ledger.values()]
    .filter(bubble => bubble.kind === kind && bubble.scope === scope)
    .filter(bubble => !activeBotIds.has(bubble.botId))
    .filter(bubble => !bubble.lingerUntil || now < bubble.lingerUntil)
    .sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')))
}
// typing-linger:end

// 气泡台账（DSHBOTS-150）：模块级短命数据，按 kind+scope+bot 存放，到期即丢弃（不做全局长驻 state）。
let typingBubbleLedger = new Map()

// 当前会话 scope：群聊按项目、单聊按 bot。台账与运行按 scope 对齐，切会话不串台。
function typingScope() {
  if (state.chatMode === 'solo') return `solo:${state.soloBotId ?? ''}`
  return `group:${state.data?.project?.id ?? state.projectId ?? ''}`
}

// 气泡行渲染：乐观排队行 + 终态驻留行。样式复用 .typing-row；淡出用内联 opacity（不新增样式表条目）。
// 画之前先按当前 state.data 对齐台账（渲染即对齐）：气泡与这一拍取到的 state 同拍，
// 不用等下一轮轮询——真实运行接管、终态转驻留、同拍已有回复则跳过驻留都在这一动作里生效。
function typingLingerRowsHtml(kind, runs = state.data?.runs ?? []) {
  const now = Date.now()
  syncTypingBubbles(now)
  const rows = typingLingerRows(typingBubbleLedger, kind, runs, typingScope(), now)
  return rows.map(bubble => {
    const bot = botById(bubble.botId)
    const lingering = Boolean(bubble.lingerUntil)
    const text = lingering ? runStatusLabel(bubble.status) : t('chat.typingQueued')
    const style = lingering ? ` style="opacity:${typingLingerOpacity(bubble, now).toFixed(3)};transition:opacity ${TYPING_LINGER_FADE_MS}ms linear"` : ''
    return `<div class="typing-row${lingering ? ' typing-row-linger' : ''}" data-bubble-key="${attr(bubble.key)}"${lingering ? ` data-linger-until="${bubble.lingerUntil}"` : ''}${style}>
      ${avatar(bot, 'sm')}
      ${lingering ? '' : '<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>'}
      <strong class="typing-name">${esc(bubble.botName)}</strong>
      <span class="typing-text">${esc(text)}</span>
      <span class="run-clock" data-started="${attr(bubble.startedAt ?? '')}">${duration(bubble.startedAt)}</span>
    </div>`
  }).join('')
}

// 乐观渲染入口（DSHBOTS-150）：发送成功后为被 @ 的目标 bot 立排队气泡，不等下一拍轮询。
// 目标 bot 取服务端回传的 runBots / runBot——与后端实际派生的运行完全一致，无需前端解析 @。
function applyOptimisticTyping(result, kind) {
  const scope = typingScope()
  const botIds = kind === 'solo_chat' ? [result?.runBot].filter(Boolean) : (result?.runBots ?? [])
  for (const botId of botIds) {
    const bot = botById(botId)
    typingBubbleLedger = addOptimisticTypingBubble(typingBubbleLedger, { kind, scope, botId, botName: bot?.name ?? 'Bot' })
  }
}

// 台账与最新运行/消息对齐：真实运行接管乐观气泡，终态转驻留，回复到齐则跳过驻留。
function syncTypingBubbles(now = Date.now()) {
  typingBubbleLedger = reconcileTypingBubbles(typingBubbleLedger, {
    runs: state.data?.runs ?? [],
    messages: { chat: state.data?.messages ?? [], solo_chat: state.data?.solo?.messages ?? [] },
    scope: typingScope(),
    now,
  })
}

// 驻留气泡到期即摘除：直接移除 DOM 节点（不整页重建，避免打断正在输入的草稿）。
function pruneTypingLinger(now = Date.now()) {
  for (const [key, bubble] of [...typingBubbleLedger]) {
    const expired = bubble.lingerUntil ? now >= bubble.lingerUntil : now - bubble.createdAt >= TYPING_OPTIMISTIC_TTL_MS
    if (!expired) continue
    typingBubbleLedger.delete(key)
    for (const el of document.querySelectorAll(`[data-bubble-key="${key}"]`)) el.remove()
  }
  // 淡出段：两次轮询之间也按剩余时间刷新透明度。
  for (const el of document.querySelectorAll('[data-linger-until]')) {
    const remaining = Number(el.dataset.lingerUntil) - now
    el.style.opacity = String(remaining <= TYPING_LINGER_FADE_MS ? Math.max(0, remaining / TYPING_LINGER_FADE_MS) : 1)
  }
}

export { typingLingerRowsHtml, applyOptimisticTyping, pruneTypingLinger }
