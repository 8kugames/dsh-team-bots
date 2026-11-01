import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 按 tests/ac.test.js 的先例：读 ui/app.js 源码做关键标记断言（不跑浏览器）。
const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../ui/styles.css', import.meta.url)), 'utf8')

test('终端 tab 只出现在项目上下文导航', () => {
  // NAV/SOLO_NAV 都是每行一项、两空格缩进收口，按缩进出口截取整块。
  const nav = /const NAV = \[([\s\S]*?)\n {2}\]/.exec(source)?.[1]
  assert.ok(nav, '缺少 NAV 定义')
  assert.match(nav, /\['terminal',\s*'终端',\s*'terminal'\]/)
  const soloNav = /const SOLO_NAV = \[([\s\S]*?)\n {2}\]/.exec(source)?.[1]
  assert.ok(soloNav, '缺少 SOLO_NAV 定义')
  assert.ok(!soloNav.includes("'terminal'"), '单聊导航不应出现终端 tab')
})

test('渲染接线：renderView 分派 terminal，视图含输入行/停止按钮/输出区/历史回填', () => {
  assert.match(source, /case 'terminal': return renderTerminal\(\)/)
  assert.match(source, /data-form="terminal-run"/)
  assert.match(source, /id="terminal-cmd-input"/)
  assert.match(source, /data-action="terminal-stop"/)
  assert.match(source, /id="terminal-output"/)
  assert.match(source, /data-action="terminal-fill"/)
})

test('终端运行中渲染停止按钮与 run-clock 秒跳', () => {
  // 停止按钮只挂在活跃命令行里
  const activeRow = /terminal-active-row[\s\S]*?terminal-stop/.exec(source)?.[0]
  assert.ok(activeRow, '活跃命令行应包含停止按钮')
  assert.match(activeRow, /class="run-clock" data-started/)
  // ⌘Enter 快捷发送
  assert.match(source, /terminal-cmd-input' && \(event\.metaKey \|\| event\.ctrlKey\) && event\.key === 'Enter'/)
})

test('活跃命令 1s 轮询、结束回落常规 poll，不引入 WebSocket', () => {
  assert.match(source, /state\.terminalPollTimer = setInterval\(/)
  assert.match(source, /\}, 1000\)/)
  assert.match(source, /api\('terminal_state', \{ projectId: state\.projectId \}, \{ quiet: true \}\)/)
  assert.match(source, /if \(!terminal\.active\) \{[\s\S]*?stopTerminalPoll\(\)/)
  assert.ok(!/new WebSocket|EventSource/.test(source), '不应引入 WebSocket/SSE')
})

test('任务并发软提示文案存在', () => {
  assert.match(source, /有任务正在写该项目工作区，终端命令与它并发需自担风险/)
})

test('终端样式齐全且走主题变量（明暗两套通用）', () => {
  for (const cls of ['.terminal-page', '.terminal-input-row', '.terminal-output', '.terminal-active-row', '.terminal-history-item', '.terminal-warn']) {
    assert.match(css, new RegExp(`\\${cls}\\s*\\{`))
  }
  const outputBlock = /\.terminal-output\s*\{([\s\S]*?)\}/.exec(css)?.[1]
  assert.ok(outputBlock.includes('var(--mono)'), '输出区应使用等宽字体变量')
  assert.ok(outputBlock.includes('overflow: auto'), '输出区应可滚动')
})
