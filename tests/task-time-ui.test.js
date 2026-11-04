// DSHBOTS-44 任务终态时间 UI —— 断言式测试。
// 约定：app.js 是浏览器 IIFE，无法直接单测内部函数，按本项目 UI 惯例做源码断言
//（先剔行注释再断言，防止「断言写进注释里」的假锁——tests/chat-pagination.test.js 先例）；
// CSS 规则断言沿用 tests/ui-button-semantics.test.js 的正则抽取法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'

const app = readUiSource()
const css = await uiStylesSource()

/** 定位 `// <marker>:start` 到 `// <marker>:end` 的原始块，再剔块内行注释。 */
function block(marker) {
  const start = app.indexOf(`// ${marker}:start`)
  const end = app.indexOf(`// ${marker}:end`)
  assert.ok(start >= 0 && end > start, `标记块 ${marker} 必须存在`)
  return app.slice(start, end).replace(/\/\/[^\n]*/g, '')
}

test('task-time-range 标记块：窗口常量与纯函数语义', () => {
  const code = block('task-time-range')
  assert.match(code, /const TASK_TIME_RANGES = \{ '7d': 7 \* 86_400_000, '30d': 30 \* 86_400_000, all: 0 \}/)
  // all 短路、非终态短路、done→completed_at / canceled→canceled_at 字段映射
  assert.match(code, /if \(timeRange === 'all'\) return false/)
  assert.match(code, /if \(task\.status !== 'done' && task\.status !== 'canceled'\) return false/)
  assert.match(code, /task\.status === 'done' \? 'completed_at' : 'canceled_at'/)
  // 缺时间戳视为窗口外：Number.isFinite 否定后才放行
  assert.match(code, /Number\.isFinite\(endedAt\) && endedAt >= cutoff/)
})

test('新增枚举「今天」与「近 30 天」：1d 按自然日 00:00 起算，30d 走滚动窗口', () => {
  const code = block('task-time-range')
  // 「今天」不是 24 小时滚动窗：cutoff 取本地当天 00:00（setHours 归零），与 Date.now() 回溯差区分
  assert.match(code, /const cutoff = timeRange === '1d' \? new Date\(\)\.setHours\(0, 0, 0, 0\) : Date\.now\(\) - \(TASK_TIME_RANGES\[timeRange\] \?\? 0\)/)
  // 近 30 天沿用滚动窗口口径，窗口常量进表
  assert.match(code, /'30d': 30 \* 86_400_000/)
  // 两个新枚举进入下拉，选中态按值精确匹配——不允许再出现 !== 'all' 兜底（1d/30d 会误显近 7 天）
  assert.match(app, /<option value="1d" \$\{state\.taskFilter\.timeRange === '1d' \? 'selected' : ''\}>今天<\/option>/)
  assert.match(app, /<option value="30d" \$\{state\.taskFilter\.timeRange === '30d' \? 'selected' : ''\}>近 30 天<\/option>/)
})

test('filteredTasks：timeRange 条件已接入且在 search 之前', () => {
  const start = app.indexOf('function filteredTasks()')
  const end = app.indexOf('}', app.indexOf('return true', start))
  const code = app.slice(start, end).replace(/\/\/[^\n]*/g, '')
  const timeIdx = code.indexOf('taskEndsOutsideRange(task, filter.timeRange)')
  const searchIdx = code.indexOf('filter.search')
  assert.ok(timeIdx > 0, 'filteredTasks 必须调用 taskEndsOutsideRange')
  assert.ok(searchIdx > timeIdx, 'timeRange 条件应与 status/assignee 同组，位于 search 之前')
})

test('筛选器 UI：timeRange select 存在、默认近 7 天、有全部出口', () => {
  assert.match(app, /data-task-filter="timeRange"/)
  assert.match(app, /<option value="7d"/)
  assert.match(app, /<option value="all"/)
  assert.match(app, /<option value="7d" \$\{state\.taskFilter\.timeRange === '7d' \? 'selected' : ''\}>近 7 天<\/option>/)
  assert.match(app, /taskFilter: \{ status: 'all', assignee: 'all', search: '', timeRange: '7d' \}/)
  // filtering 标志要感知 timeRange：默认 7d 未收窄时不误报「筛选中」之外的空态文案
  assert.match(app, /state\.taskFilter\.timeRange !== 'all'/)
})

test('任务卡终态时间：done/canceled 各取各的时间戳，非终态不渲染', () => {
  const start = app.indexOf('task-card:start')
  const end = app.indexOf('task-card:end')
  const code = app.slice(start, end).replace(/\/\/[^\n]*/g, '')
  assert.match(code, /const endAt = task\.status === 'done' \? task\.completed_at : task\.status === 'canceled' \? task\.canceled_at : null/)
  assert.match(code, /\$\{endAt \? `<span class="task-end-time"/)
})

test('任务详情弹窗终态时间：badge 空槽补位显示完成/取消时间，缺列不造占位', () => {
  const start = app.indexOf('function modalTask(task)')
  const end = app.indexOf('\n  function ', start)
  const code = app.slice(start, end).replace(/\/\/[^\n]*/g, '')
  // 与任务卡同口径的字段分派：done→completed_at、canceled→canceled_at
  assert.match(code, /const endAt = task\.status === 'done' \? task\.completed_at : task\.status === 'canceled' \? task\.canceled_at : null/)
  // badge 三级回退：stageLabel 优先（非终态阶段徽标），终态空槽用「完成于/取消于 + formatTime」补位，缺列保持空串
  assert.match(code, /badge: task\.stageLabel \? esc\(task\.stageLabel\) : endAt \? esc\(`/)
  assert.match(code, /'完成于' : '取消于'/)
  assert.match(code, /formatTime\(endAt\)/)
})

test('CSS：.task-end-time 规则存在且为弱化小字', () => {
  const rule = css.match(/\.task-end-time \{[^}]+\}/)?.[0] ?? ''
  assert.ok(rule, '.task-end-time 规则必须存在于 styles.css')
  assert.match(rule, /var\(--ink-3\)/)
  assert.match(rule, /var\(--fs-caption\)/)
  assert.match(rule, /font-variant-numeric: tabular-nums/)
  assert.ok(/\.task-end-time svg \{[^}]*width: 12px[^}]*\}/.test(css), 'svg 尺寸规则必须存在')
})
