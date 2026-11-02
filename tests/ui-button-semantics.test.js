import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../ui/styles.css', import.meta.url)), 'utf8')

const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  assert.ok(match, `找不到样式规则 ${selector}`)
  return match[1]
}

test('可交互按钮一律带发丝边框与抬升面，不再与 label 同形', () => {
  const btn = rule('.btn')
  assert.match(btn, /border:\s*1px solid var\(--line-2\)/, '按钮带 1px 发丝边框，视觉上区别于纯文本 label')
  assert.match(btn, /background:\s*var\(--surface-2\)/, '按钮有抬升面')
  assert.match(btn, /cursor:\s*pointer/, '按钮有指针光标')
})

test('按钮三态语义：primary 填充、danger 红框、icon 无框', () => {
  assert.match(rule('.btn.primary'), /border-color:\s*transparent/, 'primary 用强调色填充，边框让位')
  assert.match(rule('.btn.danger'), /color:\s*var\(--danger\)/, 'danger 用危险色文字')
  assert.match(rule('.btn.danger'), /border-color:[^;]*var\(--danger\)/, 'danger 保留一层淡红边框以区分形态')
  const icon = rule('.btn.icon')
  assert.match(icon, /border-color:\s*transparent/, '纯图标按钮靠图形本身表达可交互，不加框')
})

test('链接型交互（summary-link）与 label 区分', () => {
  const link = rule('.summary-link')
  assert.match(link, /text-decoration:\s*underline/, '折叠链接有下划线，不会读成 label')
  assert.match(link, /color:\s*var\(--ink-2\)/, '链接文字比 label 更靠前')
})

test('侧栏可点击行与纯展示行区分：悬停抬起 + 行尾箭头', () => {
  assert.match(css, /\.side-row\[data-action\]\s*\{[^}]*cursor:\s*pointer/, '可点击行有指针光标')
  assert.match(css, /\.side-row\[data-action\]:hover\s*\{[^}]*background:\s*var\(--surface-2\)/, '悬停抬起成面')
  assert.match(css, /\.side-row\[data-action\]::after\s*\{[^}]*content:\s*"\\203A"/, '行尾箭头静态可辨')
})
