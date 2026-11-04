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
  assert.match(apiSource, /if \(state\.markedRead === key\) state\.markedRead = previous/, '上报失败应回退水位，下一轮轮询自动重报')
  assert.match(apiSource, /const previous = state\.markedRead/, '回退要先存旧水位')
  assert.doesNotMatch(apiSource, /catch \{\s*\n\s*state\.markedRead = null/, '不得无条件清空水位（会抹掉更新的上报）')
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

test('select-project：取数失败或项目回退时补渲染，骨架不留存', () => {
  assert.match(selectProjectBlock, /const stuckOnSkeleton = chatContextPending\(\)/, '清标志前应先记录是否还停在骨架')
  assert.match(selectProjectBlock, /if \(stuckOnSkeleton\) render\(\)/, '停在骨架时必须补一次渲染')
  assert.ok(
    selectProjectBlock.indexOf('const stuckOnSkeleton') < selectProjectBlock.indexOf('endChatPending(pendingSeq)'),
    '判定必须早于清标志，否则标志已清就判不出来了',
  )
})

// —— 骨架状态机真跑（DSHBOTS-167）：把纯函数从源码抽出来执行，而不是只做正则匹配 ——
const grabFn = (name) => {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `缺少 ${name}`)
  return source.slice(start, source.indexOf('\n}', start) + 2)
}
const loadPendingFns = (state) => new Function(
  'state',
  `${grabFn('chatContextPending')}\n${grabFn('beginChatPending')}\n${grabFn('endChatPending')}\nreturn { chatContextPending, beginChatPending, endChatPending }`,
)(state)

function pendingState(overrides = {}) {
  return { chatPending: null, chatRequestSeq: 0, chatAtBottom: false, data: { project: { id: 'p1' }, solo: null }, ...overrides }
}

test('chatContextPending：数据与目标上下文错开时出骨架，落回后自动消失', () => {
  const state = pendingState({ chatPending: { projectId: 'p2', chatMode: 'group', soloBotId: null, seq: 1 } })
  const { chatContextPending } = loadPendingFns(state)
  assert.equal(chatContextPending(), true, '数据还是 p1、目标是 p2 → 应出骨架')
  state.data = { project: { id: 'p2' }, solo: null }
  assert.equal(chatContextPending(), false, '数据落回 p2 → 骨架消失（中途到达的轮询响应也能顶掉）')
  state.chatPending = null
  assert.equal(chatContextPending(), false, '无待取数时永远不出骨架')
})

test('chatContextPending：单聊按 solo.bot 判定，群聊不要求 solo', () => {
  const state = pendingState({
    chatPending: { projectId: 'p1', chatMode: 'solo', soloBotId: 'b9', seq: 1 },
    data: { project: { id: 'p1' }, solo: null },
  })
  const { chatContextPending } = loadPendingFns(state)
  assert.equal(chatContextPending(), true, '单聊目标 b9 但数据里没有 solo → 应出骨架')
  state.data = { project: { id: 'p1' }, solo: { bot: { id: 'b9' } } }
  assert.equal(chatContextPending(), false, 'solo.bot 到位 → 骨架消失')
})

test('beginChatPending/endChatPending：旧序号不得清掉新一次的骨架标志', () => {
  const state = pendingState()
  const { beginChatPending, endChatPending } = loadPendingFns(state)
  const first = beginChatPending({ projectId: 'p1', chatMode: 'group', soloBotId: null })
  const second = beginChatPending({ projectId: 'p2', chatMode: 'group', soloBotId: null })
  assert.ok(second > first, '序号应递增')
  endChatPending(first)
  assert.ok(state.chatPending, '先发的旧响应不得清掉后一次的骨架标志')
  endChatPending(second)
  assert.equal(state.chatPending, null, '最新一次结束后骨架才清掉')
})

test('beginChatPending：换上下文才重置贴底，同一上下文重复点击不动滚动', () => {
  const same = pendingState({ chatAtBottom: false })
  loadPendingFns(same).beginChatPending({ projectId: 'p1', chatMode: 'group', soloBotId: null })
  assert.equal(same.chatAtBottom, false, '同一上下文重复点击不动滚动')
  const switched = pendingState({ chatAtBottom: false })
  loadPendingFns(switched).beginChatPending({ projectId: 'p2', chatMode: 'group', soloBotId: null })
  assert.equal(switched.chatAtBottom, true, '换上下文必须贴底，否则骨架渲染后用户停在新会话顶部')
})

test('markdown 缓存键用 JSON 序列化，正文里的分隔符不会撞键', () => {
  assert.match(mdBlock, /JSON\.stringify\(/, '缓存键应序列化而非分隔符拼接')
})
