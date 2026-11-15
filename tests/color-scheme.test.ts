// DSHBOTS-349：宿主深色模式下团队工作台停留浅色（黑底嵌浅色圆角面板，不一体）。
// 根因：工作台深色唯一依赖 prefers-color-scheme 媒体查询，而宿主 WebView 媒体查询
// 失真（恒报 light）；宿主自身深色靠给同源父文档 body 打 data-ds-dark-theme 属性驱动。
// 修法：深色 token 改由 :root[data-color-scheme="dark"] 承载（删媒体查询包裹），
// util.ts resolveColorScheme() 嵌入态读父文档 body 属性（双向跟随）、独立态与跨源
// 异常回落系统媒体查询；MutationObserver + matchMedia change 实时跟随宿主切换。
// DSHBOTS-351：浅色模式下群聊页发黑——嵌入态只读直接 parent 且绝对压过媒体查询，
// 单层信号失真即整页误判 dark。改为祖先链遍历：自直接父逐层上溯到 window.top，
// 任一祖先带属性才判 dark；全程无属性（含顶层）/跨源异常/独立态一律回落媒体查询
// （废止「宿主浅强压系统深」的绝对优先），观察器随之覆盖祖先链各层 body。
// 本文件做样式/源码锚断言 + 真实求值断言（先例：tilde-path / token-format）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { uiStylesSource } from './ui-styles-source.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = await uiStylesSource()
// 注释里可能带花括号，先剥掉再配平。
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

function matchingBrace(source, open) {
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error('块花括号不配平')
}

function blockAt(source, from) {
  const open = source.indexOf('{', from)
  assert.ok(open >= 0, '块起始未找到')
  return source.slice(open + 1, matchingBrace(source, open))
}

// ---- 样式锚：属性承载 + 媒体查询退役 ----------------------------------------

test('深色 token 由 :root[data-color-scheme="dark"] 承载，媒体查询包裹已删', () => {
  assert.doesNotMatch(
    bare,
    /@media\s*\(prefers-color-scheme:\s*dark\)/,
    '深色不得再依赖 prefers-color-scheme 媒体查询（宿主 WebView 失真恒报 light）',
  )
  const darkIndex = bare.indexOf(':root[data-color-scheme="dark"] {')
  assert.ok(darkIndex >= 0, '缺少 :root[data-color-scheme="dark"] 暗色根块')
  const dark = blockAt(bare, darkIndex)
  assert.match(dark, /color-scheme:\s*dark/, '暗色根块应声明 color-scheme: dark')
  assert.match(dark, /--bg:\s*#101219/, '暗色画布色应为原深色底 #101219（token 原样迁移）')
  const catIndex = bare.indexOf(':root[data-color-scheme="dark"][data-theme="catppuccin"] {')
  assert.ok(catIndex >= 0, '缺少 Catppuccin 暗色属性块')
  assert.match(blockAt(bare, catIndex), /--bg:\s*#181926/, 'Catppuccin 暗色底应为原 #181926')
})

test('暗色卡片内高光阴影随属性选择器走，不再寄生媒体查询', () => {
  const index = bare.indexOf(':root[data-color-scheme="dark"] .card,')
  assert.ok(index >= 0, '缺少 :root[data-color-scheme="dark"] .card 阴影规则')
  const body = blockAt(bare, index)
  assert.match(body, /box-shadow:/)
  assert.match(body, /inset 0 1px 0 rgba\(255, 255, 255, 0\.05\)/, '内高光声明应原样保留')
})

// ---- 源码锚：util/app 接线（编译产物与源码逐行对齐） -------------------------

const utilSource = readFileSync(join(root, 'ui', 'modules', 'util.js'), 'utf8')
const appSource = readFileSync(join(root, 'ui', 'app.js'), 'utf8')

function fnBody(source, name) {
  const index = source.indexOf(`export function ${name}`)
  assert.ok(index >= 0, `util.js 缺少 export function ${name}`)
  return blockAt(source, index)
}

test('resolveColorScheme：嵌入态祖先链上溯（直接父→window.top），整体 try/catch 回落', () => {
  const body = fnBody(utilSource, 'resolveColorScheme')
  assert.match(body, /try\s*\{/, '祖先链访问须包在 try 里')
  assert.match(body, /for \(let current = window\.parent; current && current !== window; current = current\.parent\)/, '须自直接父逐层上溯祖先链')
  assert.match(body, /hasAttribute\('data-ds-dark-theme'\)/, '须读祖先 body 的 data-ds-dark-theme')
  assert.match(body, /current === window\.top/, '须遍历到顶层为止')
  assert.match(body, /\}\s*catch/, '跨源访问异常须被捕获')
  assert.match(body, /matchMedia\('\(prefers-color-scheme: dark\)'\)/, '回落路径须查系统媒体查询')
})

test('applyColorScheme：同步 documentElement 的属性与行内 color-scheme', () => {
  const body = fnBody(utilSource, 'applyColorScheme')
  assert.match(body, /setAttribute\('data-color-scheme', scheme\)/)
  assert.match(body, /style\.colorScheme = scheme/)
})

test('initColorScheme：MutationObserver 观察祖先链 body 属性 + matchMedia change 双通道', () => {
  const body = fnBody(utilSource, 'initColorScheme')
  assert.match(body, /new MutationObserver\(applyColorScheme\)/, '宿主切换深浅须实时跟随')
  assert.match(body, /for \(let current = window\.parent/, '观察范围须覆盖祖先链各层')
  assert.match(body, /attributeFilter:\s*\['data-ds-dark-theme'\]/, '只观察宿主主题属性，避免全量属性触发')
  assert.match(body, /addEventListener\('change', applyColorScheme\)/, '独立态系统切换也须跟随')
})

test('app 启动接线：模块加载即解析深浅并常驻观察', () => {
  assert.match(appSource, /initColorScheme\(\)/, 'app.js 启动段应调用 initColorScheme()')
})

// ---- 真实求值：resolveColorScheme 祖先链矩阵（util.js 顶层依赖最小桩） -----------

globalThis.location = new URL('http://127.0.0.1:3080/api/dsh-team/ui?view=chat') as unknown as Location
globalThis.document = { getElementById: () => null } as unknown as Document

const host = { mediaDark: false }
const bodyOf = (dark: boolean) => ({ hasAttribute: (name: string) => name === 'data-ds-dark-theme' && dark })
type ChainLevel = { document: { body: { hasAttribute: (name: string) => boolean } }, parent?: unknown, top?: unknown }

globalThis.window = {
  matchMedia: () => ({ matches: host.mediaDark, addEventListener() {} }),
  parent: null,
} as unknown as Window & typeof globalThis

function setParent(value: unknown) {
  Object.defineProperty(globalThis.window, 'parent', { configurable: true, writable: true, value })
}
function setParentGetter(get: () => unknown) {
  Object.defineProperty(globalThis.window, 'parent', { configurable: true, get })
}
// 构造 self 之上的祖先链（由近及远各层 body 是否带主题属性）；顶层 parent 指向自身。
function setChain(...darks: boolean[]) {
  const levels = darks.map(dark => ({ document: { body: bodyOf(dark) } })) as ChainLevel[]
  const top = levels[levels.length - 1]
  levels.forEach((level, index) => {
    level.top = top
    level.parent = index < levels.length - 1 ? levels[index + 1] : top
  })
  ;(globalThis.window as unknown as { top: unknown }).top = top
  setParent(levels[0])
}

const { resolveColorScheme, applyColorScheme } = await import(
  pathToFileURL(join(root, 'ui/modules/util.js')) as unknown as string
)

test('嵌入态：直接父 body 带 data-ds-dark-theme → dark（哪怕媒体查询报 light，D-349 场景）', () => {
  setChain(true)
  host.mediaDark = false
  assert.equal(resolveColorScheme(), 'dark')
})

test('嵌入态：仅中间祖先带属性 → dark（直接父与顶层皆无，D-351 新增）', () => {
  setChain(false, true, false)
  host.mediaDark = false
  assert.equal(resolveColorScheme(), 'dark')
})

test('嵌入态：祖先链全程无属性（含顶层）→ 回落系统媒体查询（废止宿主浅绝对优先）', () => {
  setChain(false, false)
  host.mediaDark = false
  assert.equal(resolveColorScheme(), 'light', '系统浅 → light')
  host.mediaDark = true
  assert.equal(resolveColorScheme(), 'dark', '系统深 → dark')
})

test('跨源宿主：window.parent 访问抛异常 → 回落系统媒体查询', () => {
  setParentGetter(() => {
    throw new Error('SecurityError')
  })
  host.mediaDark = true
  assert.equal(resolveColorScheme(), 'dark')
  host.mediaDark = false
  assert.equal(resolveColorScheme(), 'light')
})

test('跨源中间祖先：上溯途中 document 不可读 → 回落系统媒体查询（即便顶层带属性，D-351 新增）', () => {
  const top = { document: { body: bodyOf(true) } } as ChainLevel
  top.top = top
  top.parent = top
  const mid = { document: { body: bodyOf(false) } } as ChainLevel
  Object.defineProperty(mid, 'document', { configurable: true, get() { throw new Error('SecurityError') } })
  mid.parent = top
  mid.top = top
  ;(globalThis.window as unknown as { top: unknown }).top = top
  setParent({ document: { body: bodyOf(false) }, parent: mid, top } as ChainLevel)
  host.mediaDark = true
  assert.equal(resolveColorScheme(), 'dark')
  host.mediaDark = false
  assert.equal(resolveColorScheme(), 'light')
})

test('独立态（无父窗口）：跟随系统媒体查询', () => {
  setParent(globalThis.window)
  host.mediaDark = true
  assert.equal(resolveColorScheme(), 'dark')
  host.mediaDark = false
  assert.equal(resolveColorScheme(), 'light')
})

test('applyColorScheme：把结果落到 documentElement 属性与行内 color-scheme', () => {
  const stamped: Array<[string, string]> = []
  const el = { setAttribute: (k: string, v: string) => stamped.push([k, v]), style: {} }
  globalThis.document = { getElementById: () => null, documentElement: el } as unknown as Document
  setParent({ document: { body: { hasAttribute: () => true } } } as ChainLevel)
  assert.equal(applyColorScheme(), 'dark')
  assert.deepEqual(stamped, [['data-color-scheme', 'dark']])
  assert.equal((el as { style: { colorScheme?: string } }).style.colorScheme, 'dark')
})
