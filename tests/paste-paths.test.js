import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// DSHBOTS-70：粘贴截图与文件路径（纯前端口径——不扫目录、不加服务端接口、不读文件系统）。
// 锁定四件事：①parseFileUriList 只从剪贴板文本还原 file:// 绝对路径（uri-list 语法 + text/plain 兜底）；
// ②insertTextAtCursor 按光标 splice 插入并补派 input 事件（防 2.8s 轮询用旧草稿回滚）；
// ③paste 分发走 document 级委托且只认领 #composer-input（纯文本粘贴行为不变）；
// ④受支持图片走 addPendingImages；不支持类型无路径时插文件名 + toast「浏览器未提供完整路径」，不静默不编造。

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')

// composer-paste 标记块（纯函数区）：标记行本身是注释，求值区从 start 行之后取到 end 行之前，
// 避免把 start 标记行的尾巴（—— 说明文字）当成裸代码带进 new Function。
const pasteStart = source.indexOf('// composer-paste:start')
const pasteEnd = source.indexOf('// composer-paste:end')
assert.ok(pasteStart !== -1 && pasteEnd !== -1 && pasteStart < pasteEnd, '找不到 composer-paste 标记块')
const pasteBlock = source.slice(source.indexOf('\n', pasteStart) + 1, pasteEnd)

// 块内是纯函数，不依赖闭包标识符，可用 new Function 独立求值。
const { parseFileUriList, insertTextAtCursor } = new Function(`
${pasteBlock}
return { parseFileUriList, insertTextAtCursor }
`)()

test('parseFileUriList：uri-list 语法还原绝对路径，# 注释行跳过', () => {
  const uriList = [
    '# clipboard data',
    '# 文件复制自访达',
    'file:///Users/sile/Docs/%E6%8A%A5%E5%91%8A.pdf',
    'file:///Users/sile/Docs/plan%20v2.md',
  ].join('\r\n')
  assert.deepEqual(parseFileUriList(uriList), [
    '/Users/sile/Docs/报告.pdf',
    '/Users/sile/Docs/plan v2.md',
  ])
})

test('parseFileUriList：text/plain 里内嵌的 file:// 也能提取', () => {
  assert.deepEqual(
    parseFileUriList('看看 file:///Volumes/Data/%E6%95%B0%E6%8D%AE.csv 这个'),
    ['/Volumes/Data/数据.csv'],
  )
})

test('parseFileUriList：空/无 file:// 返回空数组，不猜不编造', () => {
  assert.deepEqual(parseFileUriList(''), [])
  assert.deepEqual(parseFileUriList(null), [])
  assert.deepEqual(parseFileUriList('https://example.com/a.pdf'), [])
  assert.deepEqual(parseFileUriList('file:// 相对路径都算没有.txt'), [])
})

test('parseFileUriList：重复路径去重', () => {
  assert.deepEqual(
    parseFileUriList('file:///a/b.png\nfile:///a/b.png'),
    ['/a/b.png'],
  )
})

function fakeTextarea({ value = '', start = null, end = null } = {}) {
  const input = {
    value,
    selectionStart: start,
    selectionEnd: end,
    events: [],
    setSelectionRange(s, e) { input.selectionStart = s; input.selectionEnd = e },
    dispatchEvent(ev) { input.events.push(ev.type) },
  }
  return input
}

test('insertTextAtCursor：按光标 splice 插入，不动光标前后的既有内容', () => {
  const value = '给 @programmer 发'
  const input = fakeTextarea({ value, start: value.length, end: value.length })
  insertTextAtCursor(input, ' /Users/x/报告.pdf')
  assert.equal(input.value, '给 @programmer 发 /Users/x/报告.pdf')
  assert.equal(input.selectionStart, input.value.length, '光标移到插入内容之后')
  assert.equal(input.selectionEnd, input.value.length)
})

test('insertTextAtCursor：有选区时替换选区，不覆盖选区外的内容', () => {
  const input = fakeTextarea({ value: '路径是 <旧的> 这里', start: 4, end: 7 })
  insertTextAtCursor(input, '/new/path.md')
  assert.equal(input.value, '路径是 /new/path.md> 这里')
})

test('insertTextAtCursor：无光标信息时追加到末尾', () => {
  const input = fakeTextarea({ value: '末尾' })
  insertTextAtCursor(input, ' /tail.txt')
  assert.equal(input.value, '末尾 /tail.txt')
})

test('insertTextAtCursor：补派 input 事件（草稿同步依赖，防轮询回滚）', () => {
  const input = fakeTextarea({ value: '' })
  insertTextAtCursor(input, 'x')
  assert.deepEqual(input.events, ['input'], '必须 dispatch 一次冒泡 input 事件')
})

test('paste 分发：document 级委托，只认领 #composer-input，纯文本粘贴不受影响', () => {
  const pasteHandler = /document\.addEventListener\('paste', \(event\) => \{([\s\S]*?)\n\}\)/.exec(source)?.[0]
  assert.ok(pasteHandler, '存在 document 级 paste 委托')
  assert.match(pasteHandler, /if \(input\?\.id !== 'composer-input'\) return/, 'target 守卫：不是 composer 直接放行')
  assert.match(pasteHandler, /const files = Array\.from\(event\.clipboardData\?\.files \?\? \[\]\)/, '只接管 files 非空的粘贴')
  assert.match(pasteHandler, /if \(files\.length === 0\) return/, '无文件（纯文本）粘贴行为不变')
  assert.doesNotMatch(source, /composer-input'\)\.addEventListener\('paste'/, '不得把 paste 监听挂在会被重建的节点上')
})

test('paste 分发：图片走 addPendingImages（粘贴截图），不支持类型 preventDefault 后找 file://', () => {
  const pasteHandler = /document\.addEventListener\('paste', \(event\) => \{([\s\S]*?)\n\}\)/.exec(source)?.[0]
  assert.match(pasteHandler, /event\.preventDefault\(\)/, '接管文件粘贴的默认行为')
  assert.match(pasteHandler, /resolveImageMediaType\(file\.type, file\.name\)/, '受支持类型与选图同一判定')
  assert.match(pasteHandler, /void addPendingImages\(images\)/, '图片复用现有待发通道')
  assert.match(pasteHandler, /getData\('text\/uri-list'\) \|\| data\.getData\('text\/plain'\)/, 'uri-list 优先、text/plain 兜底')
  assert.match(pasteHandler, /insertTextAtCursor\(input, paths\.join\('\\n'\)\)/, '有路径：按光标插入')
  assert.match(pasteHandler, /toast\('浏览器未提供完整路径', 'error'\)/, '无路径：明说，不静默失败')
})

test('红线：纯前端口径——无服务端接口、无目录扫描', () => {
  assert.ok(!source.includes('resolve_pasted_paths'), '不出现 resolve_pasted_paths 接口')
  assert.ok(!/services\/paste-paths|from ['"].*paste-paths/.test(source), '不 import 任何服务端 paste-paths 模块')
  assert.doesNotMatch(pasteBlock, /showDirectoryPicker|readdir|webkitdirectory/, '标记块内无目录枚举能力')
})
