// 会话中心目录弹窗（session-catalog）的行布局回归。
// 起因：行首图标由 icon() 产出，svg 只有 viewBox、没有 width/height 属性；目录行是
// .session-catalog-open（普通 button，不带 .btn 类），拿不到 .btn svg 的尺寸约束，
// 于是 svg 按 100% 宽高撑满 flex 轨道，把整列文字挤成一字一行的竖排并溢出弹窗右侧。
// 口径与 tests/question-card-layout.test.js 对称：读线上同一份 CSS 汇总，断言
// 「图标显式尺寸」「文字列不撑破卡片」「行内状态牌不被压缩」三条布局规格。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uiStylesSource } from './ui-styles-source.js'

const css = await uiStylesSource()

// 取某个选择器的规则块正文（多条选择器同块时按逗号切第一条命中）。
const ruleBody = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`))
  assert.ok(match, `CSS 里找不到规则块：${selector}`)
  return match[1]
}

test('会话目录行首图标：显式尺寸，不许按 100% 撑满 flex 轨道', () => {
  const icon = ruleBody('.session-catalog-open > svg')
  assert.match(icon, /width:\s*18px/, '图标宽度必须显式给定（缺省即撑满轨道）')
  assert.match(icon, /height:\s*18px/, '图标高度必须显式给定')
  assert.match(icon, /flex:\s*0 0 auto/, '图标不参与收缩')
})

test('会话目录文字列：超长 bot 名/元信息省略，不撑破卡片', () => {
  const main = ruleBody('.session-catalog-main')
  assert.match(main, /min-width:\s*0/, '文字列允许收缩到内容以下')
  assert.match(main, /overflow:\s*hidden/, '文字列溢出裁剪')
  // bot 名与元信息共用一条省略规则（逗号选择器块，ruleBody 取不到，逐条正则校验）。
  assert.match(
    css,
    /\.session-catalog-main\s*>\s*strong,\s*\.session-catalog-meta\s*\{[^}]*text-overflow:\s*ellipsis/,
    'bot 名与元信息统一走 ellipsis 省略',
  )
  assert.match(
    css,
    /\.session-catalog-main\s*>\s*strong,\s*\.session-catalog-meta\s*\{[^}]*white-space:\s*nowrap/,
    'bot 名与元信息不换行',
  )
})

test('会话目录行内状态牌：不被压缩（压缩会退化成竖排字）', () => {
  const pill = ruleBody('.session-catalog-row > .pill')
  assert.match(pill, /flex:\s*0 0 auto/, '运行中/别名牌固定宽度')
})
