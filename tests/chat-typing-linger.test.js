import { test } from 'node:test'
import assert from 'node:assert/strict'

// DSHBOTS-150：排队气泡驻留——①入队乐观渲染（发送成功后不等下一拍轮询就画排队行）
// ②终态驻留（运行结束气泡再留几秒淡出；同拍已有真实回复则跳过驻留）。
// 纯逻辑放在 ui/modules/typing-linger.js 的 typing-linger 标记块里（DSHBOTS-159 从 app.js 外迁），
// 本文件按标记块抽出来跑真实实现；读源用 app.js + ui/modules/*.js 拼接，断言不随搬家失效。
import { readUiSource } from './helpers/ui-sources.js'
const source = readUiSource()
const block = /\/\/ typing-linger:start[\s\S]*?\/\/ typing-linger:end/.exec(source)?.[0]
assert.ok(block, 'ui/modules/typing-linger.js 缺少 typing-linger 标记块')

const api = new Function(`${block}
return {
  typingBubbleKey,
  typingScopeOf,
  typingScopeMatches,
  latestTypingRuns,
  typingMessagesFor,
  hasReplySince,
  hasReplyForRun,
  addOptimisticTypingBubble,
  reconcileTypingBubbles,
  typingLingerOpacity,
  typingLingerRows,
  TYPING_LINGER_MS,
  TYPING_LINGER_FADE_MS,
  TYPING_OPTIMISTIC_TTL_MS,
  TYPING_TERMINAL_STATUS,
}`)()

const GROUP_SCOPE = 'group:p1'
const SOLO_SCOPE = 'solo:b1'

function chatRun(overrides = {}) {
  return {
    id: 'run_1',
    kind: 'chat',
    status: 'queued',
    bot_id: 'b1',
    botName: 'Alpha',
    project_id: 'p1',
    queued_at: '2026-01-01T00:00:00Z',
    started_at: null,
    ...overrides,
  }
}

function botReply(runId, botId = 'b1', createdAt = '2026-01-01T00:00:05Z') {
  return { sender_type: 'bot', sender_id: botId, run_id: runId, created_at: createdAt }
}

test('乐观渲染：发送后立刻为被 @ 的目标 bot 立排队气泡，同一 bot 不重复立', () => {
  const ledger = api.addOptimisticTypingBubble(new Map(), {
    kind: 'chat', scope: GROUP_SCOPE, botId: 'b1', botName: 'Alpha', now: 1000,
  })
  const bubble = ledger.get('chat:group:p1:b1')
  assert.ok(bubble, '乐观气泡未建立')
  assert.equal(bubble.status, 'queued')
  assert.equal(bubble.optimistic, true)
  assert.equal(bubble.runId, null)
  assert.equal(bubble.since, 1000)
  // 同一 bot 再发一条不重复立（一个 bot 同时只一行）
  const again = api.addOptimisticTypingBubble(ledger, {
    kind: 'chat', scope: GROUP_SCOPE, botId: 'b1', botName: 'Alpha', now: 2000,
  })
  assert.equal(again.size, 1)
  assert.equal(again.get('chat:group:p1:b1').since, 1000)
})

test('真实运行接管乐观气泡：状态与耗时起点以运行为准，按 run id 不重复画', () => {
  const optimistic = api.addOptimisticTypingBubble(new Map(), {
    kind: 'chat', scope: GROUP_SCOPE, botId: 'b1', botName: 'Alpha', now: 1000,
  })
  const merged = api.reconcileTypingBubbles(optimistic, {
    runs: [chatRun({ status: 'running', started_at: '2026-01-01T00:00:01Z' })],
    messages: { chat: [] },
    scope: GROUP_SCOPE,
    now: 2000,
  })
  assert.equal(merged.size, 1)
  const bubble = merged.get('chat:group:p1:b1')
  assert.equal(bubble.optimistic, false)
  assert.equal(bubble.status, 'running')
  assert.equal(bubble.runId, 'run_1')
  assert.equal(bubble.startedAt, '2026-01-01T00:00:01Z')
  // 活跃运行的 bot 不再出驻留行（DSHBOTS-1 的 typing 行负责画，避免同一 bot 两行）
  const rows = api.typingLingerRows(merged, 'chat', [chatRun({ status: 'running' })], GROUP_SCOPE, 2000)
  assert.deepEqual(rows, [])
})

test('终态驻留：运行结束无回复时气泡保留 TYPING_LINGER_MS（3–5s）再淡出移除', () => {
  assert.ok(api.TYPING_LINGER_MS >= 3000 && api.TYPING_LINGER_MS <= 5000, '驻留时长必须落在 3–5s 区间')
  // 真实路径：发送时立的乐观气泡 → 轮询取到终态运行 → 转驻留。
  const optimistic = api.addOptimisticTypingBubble(new Map(), {
    kind: 'chat', scope: GROUP_SCOPE, botId: 'b1', botName: 'Alpha', now: 1000,
  })
  const ledger = api.reconcileTypingBubbles(optimistic, {
    runs: [chatRun({ status: 'succeeded' })],
    messages: { chat: [] },
    scope: GROUP_SCOPE,
    now: 5000,
  })
  const bubble = ledger.get('chat:group:p1:b1')
  assert.ok(bubble, '终态气泡未驻留')
  assert.equal(bubble.status, 'succeeded')
  assert.equal(bubble.lingerUntil, 5000 + api.TYPING_LINGER_MS)
  // 驻留不因后续轮询延长
  const later = api.reconcileTypingBubbles(ledger, {
    runs: [chatRun({ status: 'succeeded' })],
    messages: { chat: [] },
    scope: GROUP_SCOPE,
    now: 6000,
  })
  assert.equal(later.get('chat:group:p1:b1').lingerUntil, 5000 + api.TYPING_LINGER_MS)
  // 到期即丢弃
  const expired = api.reconcileTypingBubbles(ledger, {
    runs: [chatRun({ status: 'succeeded' })],
    messages: { chat: [] },
    scope: GROUP_SCOPE,
    now: 5000 + api.TYPING_LINGER_MS + 1,
  })
  assert.equal(expired.size, 0)
  // 末段线性淡出
  const fadeFrom = 5000 + api.TYPING_LINGER_MS - api.TYPING_LINGER_FADE_MS
  assert.equal(api.typingLingerOpacity(bubble, fadeFrom), 1)
  assert.ok(api.typingLingerOpacity(bubble, 5000 + api.TYPING_LINGER_MS) <= 0.001)
})

test('同拍已有真实回复则跳过驻留：气泡直接撤掉，不占一条空泡', () => {
  const optimistic = api.addOptimisticTypingBubble(new Map(), {
    kind: 'chat', scope: GROUP_SCOPE, botId: 'b1', botName: 'Alpha', now: 1000,
  })
  const ledger = api.reconcileTypingBubbles(optimistic, {
    runs: [chatRun({ status: 'succeeded' })],
    messages: { chat: [botReply('run_1')] },
    scope: GROUP_SCOPE,
    now: 5000,
  })
  assert.equal(ledger.size, 0)
})

test('驻留途中补到真实回复：驻留气泡撤掉（回复已可见）', () => {
  const optimistic = api.addOptimisticTypingBubble(new Map(), {
    kind: 'chat', scope: GROUP_SCOPE, botId: 'b1', botName: 'Alpha', now: 1000,
  })
  const first = api.reconcileTypingBubbles(optimistic, {
    runs: [chatRun({ status: 'succeeded' })],
    messages: { chat: [] },
    scope: GROUP_SCOPE,
    now: 5000,
  })
  assert.equal(first.size, 1)
  const second = api.reconcileTypingBubbles(first, {
    runs: [chatRun({ status: 'succeeded' })],
    messages: { chat: [botReply('run_1')] },
    scope: GROUP_SCOPE,
    now: 5200,
  })
  assert.equal(second.size, 0)
})

test('回复判定按 run id 精确匹配：别的运行的迟到回复不算本轮回复', () => {
  const messages = [botReply('run_old', 'b1', '2026-01-01T00:00:30Z')]
  assert.equal(api.hasReplyForRun(messages, 'run_1', 'b1', 0), false)
  assert.equal(api.hasReplyForRun(messages, 'run_old', 'b1', 0), true)
  // 没有运行归属时退回「发送者 + 时间」近似
  assert.equal(api.hasReplySince(messages, 'b1', Date.parse('2026-01-01T00:00:10Z')), true)
  assert.equal(api.hasReplySince(messages, 'b1', Date.parse('2026-01-01T00:01:00Z')), false)
})

test('乐观气泡兜底：真实运行迟迟不进列表时按 TTL 丢弃，不留长驻状态', () => {
  const ledger = api.addOptimisticTypingBubble(new Map(), {
    kind: 'chat', scope: GROUP_SCOPE, botId: 'b1', botName: 'Alpha', now: 1000,
  })
  const kept = api.reconcileTypingBubbles(ledger, {
    runs: [], messages: { chat: [] }, scope: GROUP_SCOPE, now: 1000 + api.TYPING_OPTIMISTIC_TTL_MS - 1,
  })
  assert.equal(kept.size, 1)
  const dropped = api.reconcileTypingBubbles(ledger, {
    runs: [], messages: { chat: [] }, scope: GROUP_SCOPE, now: 1000 + api.TYPING_OPTIMISTIC_TTL_MS + 1,
  })
  assert.equal(dropped.size, 0)
})

test('会话隔离：单聊与群聊的气泡不串台', () => {
  const solo = api.addOptimisticTypingBubble(new Map(), {
    kind: 'solo_chat', scope: SOLO_SCOPE, botId: 'b1', botName: 'Alpha', now: 1000,
  })
  const merged = api.reconcileTypingBubbles(solo, {
    runs: [chatRun({ kind: 'solo_chat', project_id: null })],
    messages: { solo_chat: [] },
    scope: SOLO_SCOPE,
    now: 2000,
  })
  assert.equal(merged.size, 1)
  const bubble = merged.get(api.typingBubbleKey('solo_chat', SOLO_SCOPE, 'b1'))
  assert.ok(bubble, '单聊气泡未建立')
  assert.equal(bubble.scope, SOLO_SCOPE)
  // 群聊 scope 的台账不认单聊运行
  const crossed = api.reconcileTypingBubbles(solo, {
    runs: [chatRun({ kind: 'solo_chat', project_id: null })],
    messages: { chat: [] },
    scope: GROUP_SCOPE,
    now: 2000,
  })
  assert.equal(crossed.size, 0)
})

test('接线：发送成功后立即乐观渲染（不等下一拍轮询），两处聊天视图都挂上气泡行', () => {
  const sendBody = /async function sendMessage\(\)[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(sendBody, '未找到 sendMessage')
  const optimisticAt = sendBody.indexOf('applyOptimisticTyping(')
  const loadAt = sendBody.indexOf('await loadState(')
  assert.ok(optimisticAt > 0, 'sendMessage 未调用 applyOptimisticTyping')
  assert.ok(optimisticAt < loadAt, '乐观渲染必须排在 loadState 之前，否则要等一轮取数才画气泡')
  assert.match(source, /applyOptimisticTyping\(result, state\.chatMode === 'solo' \? 'solo_chat' : 'chat'\)/)
  // 群聊与单聊的聊天区都渲染气泡行
  assert.match(source, /typingRows\(state\.data\.runs, 'chat'\)\}\s*\n\s*\$\{typingLingerRowsHtml\('chat', state\.data\.runs\)\}/)
  assert.match(source, /typingRows\(runs, 'solo_chat'\)\}\s*\n\s*\$\{typingLingerRowsHtml\('solo_chat', runs\)\}/)
})

test('接线：画气泡行时对齐台账、1s 定时器到期摘除气泡，都不整页重建（不打断输入草稿）', () => {
  const htmlBody = /function typingLingerRowsHtml\([\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(htmlBody, '未找到 typingLingerRowsHtml')
  assert.ok(htmlBody.indexOf('syncTypingBubbles(') > 0, '画气泡行前需对齐气泡台账')
  assert.ok(htmlBody.indexOf('syncTypingBubbles(') < htmlBody.indexOf('typingLingerRows('), '对齐必须早于取行')
  // 轮询仍走取数 → 焦点渲染闸门 → render（DSHBOTS-72/D-123 的闸门结构不动）
  const pollBody = /async function poll\(\)[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(pollBody, '未找到 poll')
  assert.match(pollBody, /await loadState\(state\.projectId, \{ quiet: true \}\)\n\s*\/\/ 渲染闸门/)
  assert.match(pollBody, /if \(!pollRenderBlockedByFocus\(document\.activeElement[\s\S]*?\)\) render\(\)/)
  assert.match(source, /pruneTypingLinger\(\)/)
  // 气泡块自身不碰滚动（滚动闸门 D-72 不回归）
  assert.doesNotMatch(block, /scroll/i)
  // 不动 DSHBOTS-1 的 typing 行通道
  assert.match(source, /typingRows\(state\.data\.runs, 'chat'\)/)
  assert.match(source, /typingRows\(runs, 'solo_chat'\)/)
})

test('终态驻留行的秒表冻结在运行结束时刻：显示这次运行真正花了多久，不在驻留几秒里继续往上跳', () => {
  const optimistic = api.addOptimisticTypingBubble(new Map(), {
    kind: 'chat', scope: GROUP_SCOPE, botId: 'b1', botName: 'Alpha', now: 1000,
  })
  const ledger = api.reconcileTypingBubbles(optimistic, {
    runs: [chatRun({ status: 'succeeded', started_at: '2026-01-01T00:00:01Z', ended_at: '2026-01-01T00:00:03Z' })],
    messages: { chat: [] },
    scope: GROUP_SCOPE,
    now: 5000,
  })
  const bubble = ledger.get('chat:group:p1:b1')
  assert.equal(bubble.startedAt, '2026-01-01T00:00:01Z')
  assert.equal(bubble.endedAt, '2026-01-01T00:00:03Z')
  // 渲染层：驻留行秒表是静态文本（不带 data-started，1s 定时器不会改它），排队行仍实时走动
  const htmlBody = /function typingLingerRowsHtml\([\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(htmlBody, '未找到 typingLingerRowsHtml')
  const clock = /const clock = lingering\s*\? `([^`]*)`\s*:\s*`([^`]*)`/.exec(htmlBody)
  assert.ok(clock, '未找到驻留/排队两套秒表')
  assert.match(clock[1], /duration\(bubble\.startedAt, bubble\.endedAt/)
  assert.doesNotMatch(clock[1], /data-started/, '驻留行秒表须冻结，不能被 1s 定时器改写')
  assert.match(clock[2], /data-started/, '排队行秒表照旧实时走动')
})

test('上一轮的终态运行不劫持本轮乐观气泡：气泡继续显示排队中', () => {
  const base = Date.parse('2026-01-01T00:00:00Z')
  const optimistic = api.addOptimisticTypingBubble(new Map(), {
    kind: 'chat', scope: GROUP_SCOPE, botId: 'b1', botName: 'Alpha', now: base + 5000,
  })
  // 上一轮（早于乐观气泡）的终态运行
  const ledger = api.reconcileTypingBubbles(optimistic, {
    runs: [chatRun({ status: 'succeeded', queued_at: '2026-01-01T00:00:00Z' })],
    messages: { chat: [] },
    scope: GROUP_SCOPE,
    now: base + 6000,
  })
  const bubble = ledger.get('chat:group:p1:b1')
  assert.ok(bubble, '气泡被上一轮终态带走了')
  assert.equal(bubble.optimistic, true)
  assert.equal(bubble.status, 'queued')
  assert.equal(bubble.lingerUntil, null)
})
