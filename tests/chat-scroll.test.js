import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'

const source = readUiSource()

// —— 纯逻辑标记块 ——
const block = /\/\/ chat-scroll:start[\s\S]*?\/\/ chat-scroll:end/.exec(source)?.[0]
assert.ok(block, 'ui/app.js 缺少 chat-scroll 标记块')
const { nextChatAtBottom, CHAT_BOTTOM_THRESHOLD } = new Function(
  `${block}\nreturn { nextChatAtBottom, CHAT_BOTTOM_THRESHOLD }`,
)()

test('贴底阈值外部化为常量，不再是散落的字面量', () => {
  assert.equal(CHAT_BOTTOM_THRESHOLD, 80)
  assert.ok(!/el\.scrollHeight - el\.scrollTop - el\.clientHeight < 80/.test(source), '滚动监听里不应再有裸阈值比较')
})

test('渲染窗口内（rendering=true）保持原值，不把重建误判成上翻', () => {
  const base = { rendering: true, connected: true, scrollHeight: 2000, scrollTop: 0, clientHeight: 400 }
  assert.equal(nextChatAtBottom({ ...base, current: true }), true)
  assert.equal(nextChatAtBottom({ ...base, current: false }), false)
})

test('节点已脱离文档（connected=false）时保持原值', () => {
  const base = { rendering: false, connected: false, scrollHeight: 2000, scrollTop: 0, clientHeight: 400 }
  assert.equal(nextChatAtBottom({ ...base, current: true }), true)
  assert.equal(nextChatAtBottom({ ...base, current: false }), false)
})

test('内容不足一屏视为贴底（无处可滚）', () => {
  const value = nextChatAtBottom({
    rendering: false, connected: true, current: false,
    scrollHeight: 300, scrollTop: 0, clientHeight: 500,
  })
  assert.equal(value, true)
})

test('真上翻返回 false，贴底返回 true', () => {
  const common = { rendering: false, connected: true, current: false }
  assert.equal(nextChatAtBottom({ ...common, scrollHeight: 2000, scrollTop: 0, clientHeight: 400 }), false)
  assert.equal(nextChatAtBottom({ ...common, current: true, scrollHeight: 2000, scrollTop: 1600, clientHeight: 400 }), true)
})

test('阈值边界：距底部 79 视为贴底，80 视为上翻', () => {
  const common = { rendering: false, connected: true, current: false, scrollHeight: 2000, clientHeight: 400 }
  assert.equal(nextChatAtBottom({ ...common, scrollTop: 2000 - 400 - 79 }), true)
  assert.equal(nextChatAtBottom({ ...common, scrollTop: 2000 - 400 - 80 }), false)
})

// —— 接线断言（读源码）——
test('render() 重建 DOM 前打开渲染闸门，rAF 收尾复位', () => {
  assert.match(source, /rendering: false,/, 'state 初始应有 rendering 闸门字段')
  assert.match(
    source,
    /state\.rendering = true[\s\S]{0,600}?app\.innerHTML = renderShell\(\)/,
    '闸门必须在 innerHTML 重建之前打开',
  )
  assert.match(
    source,
    /requestAnimationFrame\(\(\) => \{\s*try \{[\s\S]*?finally \{[\s\S]*?state\.rendering = false/,
    '闸门必须在 rAF 收尾复位',
  )
})

test('滚动监听改用纯函数判定，并把渲染态与连接态传进去', () => {
  assert.match(source, /state\.chatAtBottom = nextChatAtBottom\(\{/, '滚动监听应调用纯函数')
  assert.match(source, /rendering: state\.rendering,/, '纯函数应收到渲染窗口标志')
  assert.match(source, /connected: el\.isConnected,/, '纯函数应收到节点连接态')
  assert.match(source, /current: state\.chatAtBottom,/, '纯函数应收到原值')
})

test('切进聊天视图时确定性贴底，不依赖历史残值', () => {
  assert.match(
    source,
    /if \(state\.view === 'chat' && lastRenderedView !== 'chat'\) state\.chatAtBottom = true/,
    '切进聊天视图应显式置 chatAtBottom = true',
  )
})

test('不许回归：上翻阅读仍不被 2.8s 轮询拽回底部', () => {
  assert.match(source, /if \(!state\.chatAtBottom && savedChatScroll !== null\)/, '阅读位恢复分支应保留')
  assert.match(
    source,
    /if \(messages && state\.chatAtBottom\) messages\.scrollTop = messages\.scrollHeight/,
    '贴底滚动分支应保留',
  )
  assert.ok(
    !/state\.chatAtBottom = true[\s\S]{0,200}?requestAnimationFrame/.test(
      /\/\/ chat-scroll:view-enter[\s\S]*?\n/.exec(source)?.[0] ?? '',
    ),
    '视图切换的贴底复位不得放到 rAF 之后',
  )
})

test('不许回归：load-older 阅读位补偿与看板/侧栏滚动位恢复保留', () => {
  assert.match(
    source,
    /listEl\.scrollTop = prevTop \+ \(listEl\.scrollHeight - prevHeight\)/,
    'load-older 的阅读位补偿应保留',
  )
  assert.match(source, /restoreViewScroll\(savedViewScroll\)/, '看板/侧栏滚动位恢复应保留')
  assert.match(source, /board-scroll-restore/, 'board-scroll-restore 标记块应保留')
})
