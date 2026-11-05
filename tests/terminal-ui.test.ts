import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'

// 按 tests/ac.test.js 的先例：读 ui 源码（app.js + ui/modules/*.js）做关键标记断言（不跑浏览器）。
const source = readUiSource()
// CSS 断言走汇总口径（DSHBOTS-160）：ui/styles/*.css 拼接后与线上 styles() 完全一致。
const css = await uiStylesSource()
// NAV/SOLO_NAV 已拆到 modules/state.js（DSHBOTS-15），从模块源码读取。
const stateSource = readFileSync(fileURLToPath(new URL('../ui/modules/state.js', import.meta.url)), 'utf8')

test('终端 tab 只出现在项目上下文导航', () => {
  // NAV/SOLO_NAV 都是每行一项，按收口括号截取整块（模块顶层 0 缩进）。
  const nav = /const NAV = \[([\s\S]*?)\n\]/.exec(stateSource)?.[1]
  assert.ok(nav, '缺少 NAV 定义')
  assert.match(nav, /\['terminal', 'terminal'\]/)
  const soloNav = /const SOLO_NAV = \[([\s\S]*?)\n\]/.exec(stateSource)?.[1]
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
const renderTerminalBody = /function renderTerminal\(\)\s*\{([\s\S]*?)\n\}/.exec(source)?.[1]
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

// ── DSHBOTS-74：终端页布局继续美化（井的层次、右列视觉权重、节奏与细节）──

test('输出井有内描边，与机身条分层：井读成凹陷面而非浮板', () => {
  const output = cssBlock('.terminal-output')
  assert.match(output, /inset 0 0 0 1px var\(--console-line\)/, '输出井应有 1px --console-line 内描边')
  // 标题栏与输入行同色（机身条），深色井被两条浅带夹住。
  assert.match(cssBlock('.terminal-chrome'), /background:\s*var\(--surface-2\)/, '标题栏应是 --surface-2 机身条')
  assert.match(cssBlock('.terminal-input-row'), /background:\s*var\(--surface-2\)/, '命令输入行应是 --surface-2 机身条')
})

test('三段节奏统一：标题栏与输入行内边距一致到 16px', () => {
  const chrome = cssBlock('.terminal-chrome')
  const input = cssBlock('.terminal-input-row')
  assert.match(chrome, /padding:\s*0 16px/, '标题栏横向内边距应为 16px')
  assert.match(input, /padding:\s*12px 16px/, '输入行横向内边距应为 16px')
})

test('右列视觉权重：并发提示降权为旁注，历史卡从属于终端卡', () => {
  const warn = cssBlock('.terminal-warn')
  assert.match(warn, /border-left:\s*2px solid var\(--star\)/, '并发提示应改为左侧 2px 竖线，不再整圈描边')
  assert.ok(!/border:\s*1px solid var\(--star\)/.test(warn), '并发提示不应再整圈描边')
  assert.match(cssBlock('.terminal-history-card'), /box-shadow:\s*var\(--shadow-1\)/, '历史卡投影应比终端卡更浅')
  assert.match(cssBlock('.terminal-history-head'), /background:\s*var\(--surface-2\)/, '历史卡标题条应有底色')
})

test('命令与元信息字号层级：命令是主角，元信息退到 --ink-3', () => {
  assert.match(cssBlock('.terminal-history-cmd'), /color:\s*var\(--ink\);/, '命令文本应用 --ink 主色')
  assert.match(cssBlock('.terminal-history-meta'), /color:\s*var\(--ink-3\)/, '元信息应退到 --ink-3')
  assert.match(cssBlock('.terminal-history-item .pill'), /font-size:\s*var\(--fs-caption\)/, '状态徽标字号应收紧')
})

test('历史卡头部用 eyebrow 标题，空态用独立类不再靠行内样式', () => {
  assert.match(renderTerminalBody, /class="terminal-history-head"><span class="eyebrow">\$\{t\("命令历史"\)\}<\/span>/, '历史卡标题应是 eyebrow')
  assert.match(renderTerminalBody, /class="terminal-history-empty"/, '历史空态应使用独立类')
  assert.ok(!/class="side-empty" style="padding:14px 16px"/.test(renderTerminalBody), '历史空态不应再靠行内样式')
  assert.match(cssBlock('.terminal-history-empty'), /color:\s*var\(--ink-3\)/, '历史空态文字应弱化')
})

test('井内与历史列表滚动条走主题变量，不喧宾夺主', () => {
  const output = cssBlock('.terminal-output')
  assert.match(output, /scrollbar-width:\s*thin/, '输出井应使用细滚动条')
  assert.match(output, /scrollbar-color:[^;]*var\(--console-line\)/, '输出井滚动条应走 --console-line')
  const history = cssBlock('.terminal-history')
  assert.match(history, /scrollbar-width:\s*thin/, '历史列表应使用细滚动条')
  assert.match(cssBlock('.terminal-kbd'), /background:\s*var\(--surface-3\)/, '键位提示应浮在机身条之上')
})

