import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')

// 抽取 captureViewScroll / restoreViewScroll（闭包内 2 空格缩进，函数闭合均为 "\n  }"）
const fnSrc = /function captureViewScroll\([\s\S]*?\n\}\n\nfunction restoreViewScroll\([\s\S]*?\n\}/.exec(source)?.[0]
assert.ok(fnSrc, 'ui/app.js 缺少 captureViewScroll / restoreViewScroll')

const makeWindow = (scrollY = 0) => {
  const w: { scrollY: number; calls: number[][]; scrollTo?: (x: number, y: number) => void } = { scrollY, calls: [] }
  w.scrollTo = (x, y) => { w.calls.push([x, y]); w.scrollY = y }
  return w
}
const makeDoc = (board = null, tree = null) => ({
  querySelector: (sel) => (sel === '.board' ? board : sel === '.tree' ? tree : null),
})
const load = (window, document) =>
  new Function('window', 'document', `${fnSrc}\nreturn { captureViewScroll, restoreViewScroll }`)(window, document)

test('captureViewScroll：同视图读 window 纵向位，board 横向与 tree 纵向始终捕获', () => {
  const window = makeWindow(600)
  const board = { scrollLeft: 260 }
  const tree = { scrollTop: 120 }
  const { captureViewScroll } = load(window, makeDoc(board, tree))
  assert.deepEqual(captureViewScroll(true), { windowY: 600, boardX: 260, treeY: 120 })
  // 切视图（sameView=false）不携带上一视图的窗口滚动位，但元素滚动位照常捕获
  assert.deepEqual(captureViewScroll(false), { windowY: 0, boardX: 260, treeY: 120 })
})

test('captureViewScroll：滚动容器不存在（其他视图无 .board）时落 0，不抛错', () => {
  const { captureViewScroll } = load(makeWindow(0), makeDoc(null, null))
  assert.deepEqual(captureViewScroll(true), { windowY: 0, boardX: 0, treeY: 0 })
})

test('restoreViewScroll：window / board / tree 三处原位写回', () => {
  const window = makeWindow(0)
  const board = { scrollLeft: 0 }
  const tree = { scrollTop: 0 }
  const { restoreViewScroll } = load(window, makeDoc(board, tree))
  restoreViewScroll({ windowY: 600, boardX: 260, treeY: 120 })
  assert.deepEqual(window.calls, [[0, 600]])
  assert.equal(board.scrollLeft, 260)
  assert.equal(tree.scrollTop, 120)
})

test('restoreViewScroll：全 0（视口在原点）不产生任何写回，切视图不拽窗口', () => {
  const window = makeWindow(0)
  const board = { scrollLeft: 0 }
  const tree = { scrollTop: 0 }
  const { restoreViewScroll } = load(window, makeDoc(board, tree))
  restoreViewScroll({ windowY: 0, boardX: 0, treeY: 0 })
  restoreViewScroll(null)
  assert.deepEqual(window.calls, [])
  assert.equal(board.scrollLeft, 0)
  assert.equal(tree.scrollTop, 0)
})

test('restoreViewScroll：目标元素在重建后不存在时跳过该项，不抛错', () => {
  const window = makeWindow(0)
  const { restoreViewScroll } = load(window, makeDoc(null, null))
  restoreViewScroll({ windowY: 500, boardX: 260, treeY: 120 })
  assert.deepEqual(window.calls, [[0, 500]])
})

test('渲染接线：render() 重建前按视图捕获，重建后恢复并记下本次视图', () => {
  assert.match(source, /let lastRenderedView = null/)
  assert.match(source, /const savedViewScroll = captureViewScroll\(lastRenderedView === state\.view\)\n(?:\s*\/\/[^\n]*\n)*\s*morph\(app, renderShell\(\)\)/)
  assert.match(source, /restoreViewScroll\(savedViewScroll\)\n\s*lastRenderedView = state\.view/)
})

test('chat 回归锁：savedChatScroll 分支与 chatAtBottom 贴底逻辑保持原样', () => {
  assert.match(source, /\/\/ chat-scroll-restore:mark/)
  assert.match(source, /const savedChatScroll = document\.querySelector\('\.chat-messages'\)\?\.scrollTop \?\? null\n\s*const savedViewScroll = captureViewScroll/)
  assert.match(source, /if \(!state\.chatAtBottom && savedChatScroll !== null\) \{\n\s*const fresh = document\.querySelector\('\.chat-messages'\)\n\s*if \(fresh\) fresh\.scrollTop = savedChatScroll\n\s*\}/)
})
