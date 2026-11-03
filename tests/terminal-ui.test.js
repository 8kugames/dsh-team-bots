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

// ── DSHBOTS-66：终端页视觉重构（修图标撑爆整屏 + 右列被挤成一字一行 + 补终端结构感）──

// 取顶层 CSS 规则块（闭合大括号回到行首）。
function cssBlock(selector) {
  const re = new RegExp(`\\${selector}\\s*\\{([\\s\\S]*?)\\n\\}`)
  const block = re.exec(css)?.[1]
  assert.ok(block, `缺少样式规则 ${selector}`)
  return block
}

// 取 renderTerminal 函数体。
const renderTerminalBody = /function renderTerminal\(\)\s*\{([\s\S]*?)\n {2}\}/.exec(source)?.[1]
assert.ok(renderTerminalBody, '缺少 renderTerminal 函数体')

test('图标显式定尺寸：警告图标与空态图标各带尺寸类，不会再撑爆容器', () => {
  // SVG 没有 width/height 属性时在弹性容器里会按默认尺寸铺开——必须靠尺寸类锁死。
  assert.match(source, /icon\('alert',\s*'terminal-warn-icon'\)/, '并发风险提示图标应带 terminal-warn-icon 尺寸类')
  assert.match(source, /icon\('terminal',\s*'terminal-empty-icon'\)/, '输出区空态图标应带 terminal-empty-icon 尺寸类')
  const warnIcon = cssBlock('.terminal-warn-icon')
  assert.match(warnIcon, /width:\s*\d+px/, '警告图标应有明确宽度')
  assert.match(warnIcon, /height:\s*\d+px/, '警告图标应有明确高度')
  const emptyIcon = cssBlock('.terminal-empty-icon')
  assert.match(emptyIcon, /width:\s*\d+px/, '空态图标应有明确宽度')
  assert.match(emptyIcon, /height:\s*\d+px/, '空态图标应有明确高度')
  // 尺寸落在 18–64px 区间内：既不是撑屏的巨图，也不是看不见的小点。
  const warnSize = Number(/width:\s*(\d+)px/.exec(warnIcon)?.[1])
  const emptySize = Number(/width:\s*(\d+)px/.exec(emptyIcon)?.[1])
  assert.ok(warnSize >= 14 && warnSize <= 32, `警告图标尺寸应在 14–32px，实际 ${warnSize}px`)
  assert.ok(emptySize >= 24 && emptySize <= 64, `空态图标尺寸应在 24–64px，实际 ${emptySize}px`)
})

test('终端页两列骨架：右列有可读列宽，容器补 min-width:0', () => {
  const page = cssBlock('.terminal-page')
  assert.match(page, /display:\s*grid/, '终端页应为两列网格')
  assert.match(page, /grid-template-columns:[^;]*minmax\(\s*0\s*,\s*1fr\s*\)[^;]*minmax\(\s*\d+px\s*,\s*\d+px\s*\)/, '右列应有 minmax(220px, 280px) 级别的固定可读列宽')
  assert.match(cssBlock('.terminal-main'), /min-width:\s*0/, '主列需补 min-width:0，否则长输出会撑破网格')
  assert.match(cssBlock('.terminal-side'), /min-width:\s*0/, '右列需补 min-width:0')
  assert.match(cssBlock('.terminal-warn-text'), /min-width:\s*0/, '提示正文需补 min-width:0，否则被挤成一字一行')
  // 窄屏整块落到下方：媒体查询里回到单列。
  assert.match(css, /@media \(max-width: \d+px\)[\s\S]*?\.terminal-page\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/, '窄屏应回落到单列')
})

test('输出区有最大高度、内部滚动且不撑破页面', () => {
  const output = cssBlock('.terminal-output')
  assert.match(output, /max-height:[^;]+;/, '输出区应有最大高度')
  assert.match(output, /overflow:\s*auto/, '输出区应内部滚动')
  assert.match(output, /min-height:[^;]+;/, '输出区应有最小高度')
  const wrap = cssBlock('.terminal-output-wrap')
  assert.match(wrap, /position:\s*relative/, '输出容器需为定位上下文，空态说明层才能贴合输出区')
})

test('终端骨架顺序：标题栏 → 输出区 → 命令输入行（输入行贴底）', () => {
  const chromeAt = renderTerminalBody.indexOf('terminal-chrome')
  const outputAt = renderTerminalBody.indexOf('id="terminal-output"')
  const inputAt = renderTerminalBody.indexOf('data-form="terminal-run"')
  assert.ok(chromeAt >= 0 && outputAt >= 0 && inputAt >= 0, '终端页应含标题栏/输出区/输入行')
  assert.ok(chromeAt < outputAt, '标题栏应在输出区之上')
  assert.ok(outputAt < inputAt, '命令输入行应贴在输出区下方')
  assert.match(renderTerminalBody, /class="terminal-prompt"/, '输入行应有 $ 提示符')
  assert.match(renderTerminalBody, /terminal-kbd/, '输入行应有 ⌘ / Ctrl ↵ 提示')
})

test('输出区空态独立成层，不再由 pre 承载图标', () => {
  const preTag = /<pre class="terminal-output"[^>]*>([\s\S]*?)<\/pre>/.exec(renderTerminalBody)?.[1] ?? ''
  assert.ok(!preTag.includes('icon('), 'pre 内不应再承载图标')
  assert.ok(!preTag.includes('<svg'), 'pre 内不应再出现 svg')
  assert.match(renderTerminalBody, /class="terminal-output-empty"/, '空态应是独立说明层')
  assert.match(cssBlock('.terminal-output-empty'), /position:\s*absolute/, '空态说明层应覆盖在输出区上')
  assert.match(cssBlock('.terminal-output-empty'), /justify-content:\s*center/, '空态说明层应居中')
})

