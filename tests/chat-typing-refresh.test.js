import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUiSource } from './helpers/ui-sources.js'

// DSHBOTS-123：「正在思考与回复…」不随 2.8s 轮询清除。
// 根因：poll() 的 `!state.data || state.busy > 0 || isTyping()` 把「焦点在 composer」当成
// 「正在输入」，取数与渲染一起跳过；sendMessage 尾部回焦 composer、切走再切回焦点恢复，
// 轮询被无限短路，typing 行与新消息冻结，直到点击（如思考气泡）令 composer 失焦。
// 修复口径：取数不再被焦点挡；渲染闸门收窄为「composer 静默窗内有输入或 IME 组词中」，
// 其余输入控件维持原焦点挡渲染语义；render() 重建后恢复 composer 焦点与光标。

const source = readUiSource()

// —— 轮询渲染闸门纯逻辑块 ——
const gateBlock = /\/\/ poll-typing-gate:start[\s\S]*?\/\/ poll-typing-gate:end/.exec(source)?.[0]
assert.ok(gateBlock, 'ui/app.js 缺少 poll-typing-gate 标记块')
const { pollRenderBlockedByFocus, COMPOSER_IDLE_MS } = new Function(
  `${gateBlock}\nreturn { pollRenderBlockedByFocus, COMPOSER_IDLE_MS }`,
)()

const composer = { tagName: 'TEXTAREA', id: 'composer-input' }
const now = 1_000_000

test('卡死场景：composer 空闲（静默窗外、未组词）不得挡渲染', () => {
  assert.equal(
    pollRenderBlockedByFocus(composer, { composing: false, composerInputAt: now - COMPOSER_IDLE_MS - 1, now }),
    false,
  )
})

test('正在输入保护：静默窗内有输入事件、或 IME 组词中，仍挡整页渲染', () => {
  assert.equal(pollRenderBlockedByFocus(composer, { composing: false, composerInputAt: now - 1, now }), true)
  assert.equal(pollRenderBlockedByFocus(composer, { composing: true, composerInputAt: 0, now }), true)
})

test('边界：距上次输入恰好达到静默窗即放行', () => {
  assert.equal(pollRenderBlockedByFocus(composer, { composing: false, composerInputAt: now - COMPOSER_IDLE_MS, now }), false)
})

test('其余输入控件维持原「焦点即挡」语义；无焦点不挡', () => {
  assert.equal(pollRenderBlockedByFocus({ tagName: 'INPUT', id: 'task-search' }, { now }), true)
  assert.equal(pollRenderBlockedByFocus({ tagName: 'TEXTAREA', id: 'terminal-cmd-input' }, { now }), true)
  assert.equal(pollRenderBlockedByFocus({ tagName: 'DIV', isContentEditable: true }, { now }), true)
  assert.equal(pollRenderBlockedByFocus(null, { now }), false)
  assert.equal(pollRenderBlockedByFocus({ tagName: 'BUTTON', id: 'send-message' }, { now }), false)
})

// —— poll() 接线：真实源码驱动 ——
const pollSrc = /async function poll\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
assert.ok(pollSrc, 'ui/app.js 缺少 poll()')

test('poll 的取数闸门只剩 data/busy，焦点不再整体短路轮询', () => {
  assert.match(pollSrc, /if \(!state\.data \|\| state\.busy > 0\) return/)
  assert.ok(!/isTyping\(\)/.test(pollSrc), 'poll 不得再用 isTyping() 挡取数')
})

test('poll 的渲染调用经 pollRenderBlockedByFocus 放行', () => {
  assert.match(pollSrc, /if \(!pollRenderBlockedByFocus\(document\.activeElement, \{ composing: state\.composerComposing, composerInputAt: state\.composerInputAt \}\)\) render\(\)/)
})

function drivePoll({ activeElement, composerInputAt, composing = false, serverRuns }) {
  const state = {
    data: { runs: [{ kind: 'chat', status: 'running', bot_id: 'b1' }] },
    busy: 0, composerInputAt, composerComposing: composing,
  }
  const document = { hidden: false, activeElement, querySelector: () => null }
  let fetches = 0
  let renders = 0
  let typingRowVisible = true
  const loadState = async () => {
    fetches += 1
    state.data = { runs: serverRuns }
  }
  const render = () => {
    renders += 1
    typingRowVisible = state.data.runs.some(run => ['queued', 'running'].includes(run.status))
  }
  const poll = new Function(
    'state', 'document', 'api', 'loadState', 'render', 'notifyNewApprovals', 'notifyOn', 'pollRenderBlockedByFocus',
    `${pollSrc}\nreturn poll`,
  )(state, document, async () => ({}), loadState, render, () => {}, () => false,
    el => pollRenderBlockedByFocus(el, { composing: state.composerComposing, composerInputAt: state.composerInputAt }))
  return {
    poll: async () => { await poll() },
    idle: () => { state.composerInputAt = 0 },
    snapshot: () => ({ fetches, renders, typingRowVisible }),
  }
}

test('复现用例（修复后行为）：运行已在服务端结束 + composer 空闲持焦，一个轮询周期即取数并清出 typing 行', async () => {
  const rig = drivePoll({ activeElement: composer, composerInputAt: Date.now() - 10_000, serverRuns: [] })
  await rig.poll()
  const { fetches, renders, typingRowVisible } = rig.snapshot()
  assert.ok(fetches >= 1, '焦点在 composer 也不得挡取数')
  assert.ok(renders >= 1, 'composer 空闲时渲染应放行')
  assert.equal(typingRowVisible, false, '「正在思考与回复…」应随轮询清除，无需点击失焦')
})

test('正在输入用例：静默窗内渲染保留（不打断输入），取数照常；越过静默窗后下一周期补渲染', async () => {
  const rig = drivePoll({ activeElement: composer, composerInputAt: Date.now() - 100, serverRuns: [] })
  await rig.poll()
  let { fetches, renders, typingRowVisible } = rig.snapshot()
  assert.ok(fetches >= 1, '正在输入时数据照常拉取（渲染单独判）')
  assert.equal(renders, 0, '正在输入不得整页重建')
  assert.equal(typingRowVisible, true, 'composer 未被拆走，旧 typing 行暂留属预期')
  rig.idle()
  await rig.poll()
  ;({ fetches, renders, typingRowVisible } = rig.snapshot())
  assert.ok(fetches >= 2, '第二周期照常取数')
  assert.ok(renders >= 1, '越过静默窗后渲染应放行')
  assert.equal(typingRowVisible, false, 'typing 行随补渲染清除')
})

// —— 输入/组词事件接线 ——
test('composer 输入事件记录时间戳；compositionstart/end 维护组词标记', () => {
  assert.match(source, /if \(el\.id === 'composer-input'\) \{\s*\n\s*state\.composerInputAt = Date\.now\(\)/)
  assert.match(source, /addEventListener\('compositionstart'[\s\S]{0,200}composer-input[\s\S]{0,120}state\.composerComposing = true/)
  assert.match(source, /addEventListener\('compositionend'[\s\S]{0,200}composer-input[\s\S]{0,120}state\.composerComposing = false/)
})

// —— render() 焦点/光标恢复接线 ——
test('render() 重建前捕获 composer 光标，rAF 收尾恢复焦点与选区', () => {
  assert.match(
    source,
    /const composerCaret = [\s\S]{0,1500}?app\.innerHTML = renderShell\(\)/,
    '捕获必须发生在 innerHTML 重建之前',
  )
  assert.match(
    source,
    /if \(composerCaret && composerInput\) \{[\s\S]{0,300}?composerInput\.focus\(\)[\s\S]{0,300}?setSelectionRange\(composerCaret\.start, composerCaret\.end, composerCaret\.direction\)/,
    'rAF 收尾应恢复焦点与光标选区',
  )
})

test('切回页面立即补一轮轮询：visibilitychange 可见即 poll', () => {
  assert.match(source, /document\.addEventListener\('visibilitychange', \(\) => \{[\s\S]{0,120}?if \(!document\.hidden\) void poll\(\)/)
})
