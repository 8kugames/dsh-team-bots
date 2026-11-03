import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseFileUriList as serverParseFileUriList,
  isSafeLookupName,
  resolveNames,
  pasteLookupRoots,
  resolvePastedPaths,
  PASTE_NAMES_MAX,
} from '../src/services/paste-paths.js'
import { handleAction } from '../src/api.js'

// DSHBOTS-70：粘贴截图与文件路径（两段式口径——先剪贴板 file:// URI，拿不到再服务端只读反查）。
// 锁定四件事：①parseFileUriList 只从剪贴板文本还原 file:// 绝对路径（uri-list 语法 + text/plain 兜底）；
// ②insertTextAtCursor 按光标 splice 插入并补派 input 事件（防 2.8s 轮询用旧草稿回滚）；
// ③paste 分发走 document 级委托且只认领 #composer-input（纯文本粘贴行为不变）；
// ④受支持图片走 addPendingImages；不支持类型按 URI → resolve_pasted_paths 反查补全绝对路径，
//   仍拿不到才插文件名 + toast「浏览器没有提供完整路径，可把文件拖进工作区后再粘贴路径」，不静默不编造。
// 服务端反查（三态、根目录白名单、名字闸、api 接线）在本文件下半部分直测 src/services/paste-paths.js。

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
  const pasteHandler = /document\.addEventListener\('paste', \(event\) => \{([\s\S]*?)\n  \}\)/.exec(source)?.[0]
  assert.ok(pasteHandler, '存在 document 级 paste 委托')
  assert.match(pasteHandler, /if \(input\?\.id !== 'composer-input'\) return/, 'target 守卫：不是 composer 直接放行')
  assert.match(pasteHandler, /const files = Array\.from\(event\.clipboardData\?\.files \?\? \[\]\)/, '只接管 files 非空的粘贴')
  assert.match(pasteHandler, /if \(files\.length === 0\) return/, '无文件（纯文本）粘贴行为不变')
  assert.doesNotMatch(source, /composer-input'\)\.addEventListener\('paste'/, '不得把 paste 监听挂在会被重建的节点上')
})

test('paste 分发：图片走 addPendingImages（粘贴截图），不支持类型先找 file:// 再反查', () => {
  const pasteHandler = /document\.addEventListener\('paste', \(event\) => \{([\s\S]*?)\n  \}\)/.exec(source)?.[0]
  assert.match(pasteHandler, /event\.preventDefault\(\)/, '接管文件粘贴的默认行为')
  assert.match(pasteHandler, /resolveImageMediaType\(file\.type, file\.name\)/, '受支持类型与选图同一判定')
  assert.match(pasteHandler, /void addPendingImages\(images\)/, '图片复用现有待发通道')
  assert.match(pasteHandler, /getData\('text\/uri-list'\) \|\| data\.getData\('text\/plain'\)/, 'uri-list 优先、text/plain 兜底')
  assert.match(pasteHandler, /api\('resolve_pasted_paths', \{ names: pending \}, \{ quiet: true \}\)/, 'URI 拿不到：调服务端只读反查')
  assert.match(pasteHandler, /if \(item\?\.chosen\) byName\.set\(item\.name, item\.chosen\)/, '唯一命中才采用，多命中不猜')
  assert.match(pasteHandler, /insertTextAtCursor\(live, lines\.join\('\\n'\)\)/, '插入前重取活节点，按光标插入')
  assert.match(pasteHandler, /toast\('浏览器没有提供完整路径，可把文件拖进工作区后再粘贴路径', 'error'\)/, '拿不到：明说，不静默失败')
})

test('红线：前端不 import 服务端模块、标记块内无目录枚举；反查只走 API', () => {
  assert.ok(!/services\/paste-paths|from ['"].*paste-paths/.test(source), '前端不 import 服务端 paste-paths 模块（浏览器侧也做不到）')
  assert.doesNotMatch(pasteBlock, /showDirectoryPicker|readdir|webkitdirectory/, '标记块内无目录枚举能力')
  assert.doesNotMatch(pasteBlock, /resolve_pasted_paths/, 'URI 解析纯函数与反查无关，标记块保持纯浏览器侧')
})

// ── 服务端反查（src/services/paste-paths.js + src/api.js 接线）──

test('服务端 parseFileUriList：多行/中文百分号/去重/非 file:// 全覆盖', () => {
  const uriList = [
    '# comment',
    'file:///Users/u/Downloads/%E9%93%B8%E5%B0%98%20%E6%97%A5%E5%BF%97.docx',
    'file:///Users/u/Downloads/%E9%93%B8%E5%B0%98%20%E6%97%A5%E5%BF%97.docx',
    'file:///Users/u/a%20b.txt',
    'file://localhost/etc/passwd',
    'https://example.com/x.pdf',
    'file:///bad/%E5',
  ].join('\r\n')
  assert.deepEqual(serverParseFileUriList(uriList), [
    '/Users/u/Downloads/铸尘 日志.docx',
    '/Users/u/a b.txt',
  ])
  assert.deepEqual(serverParseFileUriList(null), [], 'null 输入返回空')
})

test('isSafeLookupName：空名、点、含 / 与 .. 一律拒绝（防目录穿越）', () => {
  assert.equal(isSafeLookupName('报告.pdf'), true)
  assert.equal(isSafeLookupName(''), false)
  assert.equal(isSafeLookupName('.'), false)
  assert.equal(isSafeLookupName('a/b.pdf'), false)
  assert.equal(isSafeLookupName('../x.pdf'), false)
  assert.equal(isSafeLookupName('a..b'), false)
})

test('resolveNames：唯一命中/多命中/零命中三态，非法名字直接消失', () => {
  const root = mkdtempSync(join(tmpdir(), 'paste-paths-'))
  try {
    mkdirSync(join(root, 'sub1'))
    mkdirSync(join(root, 'sub2'))
    writeFileSync(join(root, '唯一 命中.txt'), 'x')
    writeFileSync(join(root, 'sub1', '同名.txt'), 'x')
    writeFileSync(join(root, 'sub2', '同名.txt'), 'x')
    const results = resolveNames(['唯一 命中.txt', '同名.txt', '不存在.xyz'], [root])
    assert.deepEqual(results[0], { name: '唯一 命中.txt', matches: [join(root, '唯一 命中.txt')], chosen: join(root, '唯一 命中.txt') })
    assert.equal(results[1].matches.length, 2)
    assert.equal(results[1].chosen, null, '多命中不替用户挑')
    assert.deepEqual(results[2], { name: '不存在.xyz', matches: [], chosen: null })
    const gated = resolveNames(['../etc/passwd', '唯一 命中.txt'], [root])
    assert.deepEqual(gated.map(item => item.name), ['唯一 命中.txt'], '非法名字按拿不到处理')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveNames：深度与配额上限（limits 测试注入）', () => {
  const root = mkdtempSync(join(tmpdir(), 'paste-paths-depth-'))
  try {
    mkdirSync(join(root, 'd1/d2'), { recursive: true })
    writeFileSync(join(root, 'd1/d2/deep.txt'), 'x')
    assert.deepEqual(
      resolveNames(['deep.txt'], [root], { maxDepth: 1 }),
      [{ name: 'deep.txt', matches: [], chosen: null }],
      '第 2 层不进',
    )
    assert.equal(resolveNames(['deep.txt'], [root], { maxDepth: 2 })[0].chosen, join(root, 'd1/d2/deep.txt'), '放开深度才命中')
    assert.ok(Array.isArray(resolveNames(['whatever'], [root], { maxEntries: 1 })), '极小配额不炸')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolvePastedPaths：根目录白名单写死，入参 roots 被忽略；names 校验', () => {
  const fakeWorkspace = mkdtempSync(join(tmpdir(), 'paste-ws-'))
  try {
    writeFileSync(join(fakeWorkspace, '工作区文件.md'), 'x')
    const out = resolvePastedPaths(fakeWorkspace, { names: ['工作区文件.md'], roots: ['/etc'] })
    assert.deepEqual(out.roots, pasteLookupRoots(fakeWorkspace), 'roots 只来自白名单')
    assert.equal(out.results[0].chosen, join(fakeWorkspace, '工作区文件.md'))
    assert.throws(() => resolvePastedPaths(fakeWorkspace, {}), /names/, 'names 缺失拒绝')
    assert.throws(
      () => resolvePastedPaths(fakeWorkspace, { names: Array.from({ length: PASTE_NAMES_MAX + 1 }, () => 'x') }),
      /20/,
      '超上限拒绝',
    )
  } finally {
    rmSync(fakeWorkspace, { recursive: true, force: true })
  }
})

test('api 接线：handleAction 分发 resolve_pasted_paths 走真实路径', async () => {
  const fakeWorkspace = mkdtempSync(join(tmpdir(), 'paste-api-'))
  try {
    writeFileSync(join(fakeWorkspace, '接线验证.txt'), 'x')
    const service = { config: { workspace: fakeWorkspace } }
    const out = await handleAction(service, 'resolve_pasted_paths', { names: ['接线验证.txt'] })
    assert.equal(out.results[0].chosen, join(fakeWorkspace, '接线验证.txt'))
    await assert.rejects(handleAction(service, 'resolve_pasted_paths', { names: 'not-array' }), /names/)
  } finally {
    rmSync(fakeWorkspace, { recursive: true, force: true })
  }
})
