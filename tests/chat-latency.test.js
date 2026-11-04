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
