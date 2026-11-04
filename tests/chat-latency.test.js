import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'

const source = readUiSource()
const mdBlock = /\/\/ markdown-render:start[\s\S]*?\/\/ markdown-render:end/.exec(source)?.[0]
assert.ok(mdBlock, '缺少 markdown-render 标记块')
const { mdCreateRenderer } = new Function(`${mdBlock}\nreturn { mdCreateRenderer }`)()

const apiSource = readFileSync(fileURLToPath(new URL('../ui/modules/api.js', import.meta.url)), 'utf8')

// 假依赖只计数：验证缓存是否真的省掉了 marked / DOMPurify 的重复劳动。
function countingDeps(counters) {
  return {
    marked: { parse: (value) => { counters.parse += 1; return `<p>${value}</p>` } },
    DOMPurify: { sanitize: (value) => { counters.sanitize += 1; return value } },
  }
}

test('markdown 缓存：同正文同 scope 二次渲染不再解析（点击与 2.8s 轮询的重复主开销）', () => {
  const counters = { parse: 0, sanitize: 0 }
  const render = mdCreateRenderer(countingDeps(counters))
  const scope = { projectId: 'p1', root: '/srv/ws/art' }
  const body = '# 标题\n\n一段正文'
  assert.equal(render(body, scope), '<p># 标题\n\n一段正文</p>')
  assert.equal(render(body, scope), '<p># 标题\n\n一段正文</p>')
  assert.equal(counters.parse, 1, '第二次应命中缓存，不再调用 marked.parse')
  assert.equal(counters.sanitize, 1, '第二次应命中缓存，不再调用 DOMPurify.sanitize')
})

test('markdown 缓存：scope 变化必须重新解析（图片改写依赖 scope）', () => {
  const counters = { parse: 0, sanitize: 0 }
  const render = mdCreateRenderer(countingDeps(counters))
  const body = '![图](assets/a.png)'
  render(body, { projectId: 'p1', root: '/srv/ws/art' })
  render(body, { projectId: 'p2', root: '/srv/ws/art' })
  assert.equal(counters.parse, 2, '不同 scope 的正文不能共用缓存')
})

test('markdown 缓存：有界 LRU，超限淘汰最旧条目', () => {
  const counters = { parse: 0, sanitize: 0 }
  const render = mdCreateRenderer(countingDeps(counters))
  const scope = { projectId: 'p1', root: '/srv/ws/art' }
  for (let index = 0; index < 1501; index += 1) render(`正文-${index}`, scope)
  assert.equal(counters.parse, 1501)
  render('正文-0', scope)
  assert.equal(counters.parse, 1502, '超限淘汰最旧条目后需重新解析')
})

test('已读上报不挡渲染：loadState 不再 await markVisibleChatRead', () => {
  assert.match(apiSource, /void markVisibleChatRead\(data\)/, 'loadState 应即发即走已读上报')
  assert.doesNotMatch(apiSource, /await markVisibleChatRead/, 'loadState 不应等待已读上报（点击路径上的第二次串行往返）')
})

test('已读上报失败可重报：markVisibleChatRead 失败回退水位', () => {
  assert.match(apiSource, /state\.markedRead = null/, '上报失败应回退水位，下一轮轮询自动重报')
})

test('已读上报口径跟随 data：项目回退时不会标错项目', () => {
  assert.match(apiSource, /const projectId = data\?\.project\?\.id \?\? state\.projectId/, '上报项目必须取 data.project.id，回退到别的项目时才不会标错')
})

// —— 点击路径的乐观切换（DSHBOTS-167 约束①：先出骨架，再异步取数）——
const selectProjectBlock = source.slice(source.indexOf("case 'select-project'"), source.indexOf("case 'refresh'"))
assert.ok(selectProjectBlock.length > 0, '找不到 select-project 分支')
const soloBotBlock = source.slice(source.indexOf("case 'solo-bot'"), source.indexOf("case 'copy'"))
assert.ok(soloBotBlock.length > 0, '找不到 solo-bot 分支')

test('select-project：先 render 出骨架，再 await 取数', () => {
  const renderAt = selectProjectBlock.indexOf('render()')
  const awaitAt = selectProjectBlock.indexOf('await refresh()')
  assert.ok(renderAt >= 0 && awaitAt >= 0, '分支内应同时存在 render() 与 await refresh()')
  assert.ok(renderAt < awaitAt, 'render() 必须在 await 之前，点击才不至于无反馈')
})

test('solo-bot：先 render 出骨架，再 await 取数', () => {
  const renderAt = soloBotBlock.indexOf('render()')
  const awaitAt = soloBotBlock.indexOf('await loadState')
  assert.ok(renderAt >= 0 && awaitAt >= 0, '分支内应同时存在 render() 与 await loadState')
  assert.ok(renderAt < awaitAt, 'render() 必须在 await 之前，点击才不至于无反馈')
})

test('renderView：目标上下文与已加载数据错开时出骨架，不再渲染消息列表', () => {
  assert.match(source, /function chatContextPending\(\) \{/, '缺少 chatContextPending 判定')
  assert.match(source, /function renderView\(\) \{\s*if \(state\.view === 'chat' && chatContextPending\(\)\) return chatPendingView\(\)/, 'renderView 应在错开时直接返回骨架')
  assert.match(source, /function chatPendingView\(\) \{/, '缺少骨架视图')
})

test('连续点击不闪回：先发的旧响应不得清掉新一次的骨架标志', () => {
  assert.match(source, /function beginChatPending\(pending\) \{/, '缺少取数序号登记')
  assert.match(source, /const seq = \(state\.chatRequestSeq \+= 1\)/, '每次取数应领一个递增序号')
  assert.match(source, /if \(state\.chatPending\?\.seq === seq\) state\.chatPending = null/, '只有仍是最新一次才允许清骨架')
  assert.equal((source.match(/endChatPending\(pendingSeq\)/g) ?? []).length, 2, 'select-project 与 solo-bot 都要按序号清理')
})
