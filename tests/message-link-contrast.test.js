// DSHBOTS-130：深色（Catppuccin）主题下消息内 URL 不可见。
// 根因是全局 `a { color: var(--accent-text) }` 与用户气泡底色 --accent 同色系
// （Catppuccin 暗色下两者同为 #b7bdf8，对比 1.00:1）。修法是给气泡内链接一条
// 独立配色规则：用户气泡用 --accent-ink，bot 气泡与评论用 --accent-text。
// 本文件读页面 CSS 汇总真源（ui/styles/* 拼接，DSHBOTS-160，与线上 styles() 同口径）
// 做断言（仓库先例：tests/question-ui.test.js 等），
// 并按 WCAG 2.1 实算四套主题下的对比度，不复制一份色值到测试里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { uiStylesSource } from './ui-styles-source.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const css = await uiStylesSource()

// ---- CSS 解析小工具（够用即可，不引第三方依赖） -----------------------------

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
  throw new Error('CSS 块花括号不配平')
}

function blockAt(source, from) {
  const open = source.indexOf('{', from)
  assert.ok(open >= 0, 'CSS 块起始未找到')
  return source.slice(open + 1, matchingBrace(source, open))
}

// 展平所有规则（@media 里的嵌套规则也取到），返回 { selector, body } 列表。
function parseRules(source) {
  const out = []
  let cursor = 0
  while (cursor < source.length) {
    const open = source.indexOf('{', cursor)
    if (open < 0) break
    const selector = source.slice(cursor, open).trim()
    const close = matchingBrace(source, open)
    const body = source.slice(open + 1, close)
    if (body.includes('{')) out.push(...parseRules(body))
    else out.push({ selector, body })
    cursor = close + 1
  }
  return out
}

function tokens(block) {
  const map = new Map()
  for (const match of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(match[1], match[2].trim())
  }
  return map
}

// 取某个选择器的声明块（取第一个匹配）。
function ruleBody(selector) {
  const index = bare.indexOf(selector)
  assert.ok(index >= 0, `CSS 里找不到规则：${selector}`)
  return blockAt(bare, index)
}

// ---- 四套主题的 token ------------------------------------------------------

function themeTokens() {
  const mediaIndexes = [...bare.matchAll(/@media \(prefers-color-scheme: dark\) \{/g)].map((m) => m.index)
  assert.equal(mediaIndexes.length, 2, '暗色媒体查询应为两处（默认 + Catppuccin）')

  const lightRoot = tokens(blockAt(bare, bare.indexOf(':root {')))
  const darkMedia = blockAt(bare, mediaIndexes[0])
  const darkRoot = tokens(blockAt(darkMedia, darkMedia.indexOf(':root {')))
  const catMedia = blockAt(bare, mediaIndexes[1])
  const catRoot = tokens(blockAt(bare, bare.indexOf(':root[data-theme="catppuccin"] {')))
  const catDark = tokens(blockAt(catMedia, catMedia.indexOf(':root[data-theme="catppuccin"] {')))

  return {
    '默认浅色': lightRoot,
    '默认深色': darkRoot,
    'Catppuccin 浅色': catRoot,
    'Catppuccin 深色': catDark,
  }
}

const THEMES = themeTokens()

// ---- WCAG 2.1 对比度 -------------------------------------------------------

function channel(value) {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex) {
  const raw = hex.trim().replace('#', '')
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(fg, bg) {
  const a = luminance(fg)
  const b = luminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

const ratio = (theme, fgToken, bgToken) => {
  const t = THEMES[theme]
  assert.ok(t.has(fgToken), `主题 ${theme} 缺 token --${fgToken}`)
  assert.ok(t.has(bgToken), `主题 ${theme} 缺 token --${bgToken}`)
  return contrast(t.get(fgToken), t.get(bgToken))
}

// ---- 用例 ------------------------------------------------------------------

test('气泡内链接有独立规则：用户气泡用 --accent-ink，不吃全局 --accent-text', () => {
  // 用户气泡规则必须存在且显式用 --accent-ink。
  const userRule = bare.slice(bare.indexOf('.message-row.user .message-bubble a'))
  const body = blockAt(bare, bare.indexOf('.message-row.user .message-bubble a'))
  assert.match(body, /color\s*:\s*var\(--accent-ink\)/, '用户气泡内链接必须用 var(--accent-ink)')
  assert.doesNotMatch(body, /color\s*:\s*var\(--accent-text\)/, '用户气泡内链接不得再用 var(--accent-text)')
  assert.ok(userRule.length > 0)
})

test('全局 a 规则未被误改：仍是 var(--accent-text)，不含 --accent-ink', () => {
  const globalA = ruleBody('\na {')
  assert.match(globalA, /color\s*:\s*var\(--accent-text\)/, '全局 a 的链接色必须保持 var(--accent-text)')
  assert.doesNotMatch(globalA, /--accent-ink/, '全局 a 不得改成 --accent-ink')
})

test('链接配色作用域只落在气泡/评论内，不误伤全局 a', () => {
  // 逐条规则解析：凡是给「链接元素」单独上色的规则，选择器必须落在
  // .message-bubble / .comment-body 上；唯一的例外是全局 a 规则本身（保持原样）。
  const rules = parseRules(bare)
  const linkRules = rules.filter(({ selector, body }) => {
    if (!/color\s*:\s*var\(--accent-(?:text|ink)\)/.test(body)) return false
    const compounds = selector.split(/\s+/)
    return compounds[compounds.length - 1] === 'a'
  })
  assert.ok(linkRules.length >= 2, '应至少有两条链接配色规则（气泡 + 评论）')
  for (const { selector } of linkRules) {
    if (selector.trim() === 'a') continue
    assert.match(selector, /\.message-bubble|\.comment-body/, `链接配色规则越界：${selector}`)
  }
})

test('气泡链接零新增色值：只用既有 token，不写字面颜色', () => {
  const body = ruleBody(':is(.message-bubble, .comment-body) a')
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b/i, '气泡链接规则里不得出现字面色值')
  assert.doesNotMatch(body, /rgba?\(|hsla?\(/i, '气泡链接规则里不得出现字面颜色函数')
  assert.match(body, /text-decoration\s*:\s*underline/, '气泡链接必须有下划线')
  assert.match(body, /text-underline-offset\s*:\s*2px/, '气泡链接下划线偏移 2px')
})

test('四套主题下用户气泡链接对比 ≥ 4.5:1', () => {
  for (const theme of Object.keys(THEMES)) {
    const value = ratio(theme, 'accent-ink', 'accent')
    assert.ok(value >= 4.5, `${theme} 用户气泡链接对比仅 ${value.toFixed(2)}:1`)
  }
})

test('四套主题下 bot 气泡与评论链接对比达标（暗色 ≥4.5:1）', () => {
  for (const theme of Object.keys(THEMES)) {
    const bot = ratio(theme, 'accent-text', 'surface-3')
    const comment = ratio(theme, 'accent-text', 'surface')
    assert.ok(comment >= 4.5, `${theme} 评论链接对比仅 ${comment.toFixed(2)}:1`)
    if (theme.includes('深色')) {
      assert.ok(bot >= 4.5, `${theme} bot 气泡链接对比仅 ${bot.toFixed(2)}:1`)
    }
  }
})

test('回归护栏：全局链接色与用户气泡底色同色系的问题不再靠全局规则承担', () => {
  // 全局 a 的色仍允许与 --accent 同色系（不动全局规则），但气泡内链接必须另有配色。
  const bubbleLink = blockAt(bare, bare.indexOf(':is(.message-bubble, .comment-body) a'))
  assert.match(bubbleLink, /color\s*:\s*var\(--accent-text\)/)
  const userLink = blockAt(bare, bare.indexOf('.message-row.user .message-bubble a'))
  assert.match(userLink, /color\s*:\s*var\(--accent-ink\)/)
})
