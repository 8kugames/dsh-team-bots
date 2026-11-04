// DSHBOTS-124 任务详情 modal 显式显示「写范围」——断言式测试。
// 约定沿用 tests/task-time-ui.test.js：app.js 是浏览器脚本，按源码断言；先剔行注释再断言，
// 防止「断言写进注释里」的假锁。CSS 规则断言沿用正则抽取法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'

const app = readUiSource()
const css = await uiStylesSource()
const tasksService = readFileSync(new URL('../src/services/tasks.js', import.meta.url), 'utf8')

/** 取出 modalTask 函数体（到列首的函数收尾为止）并剔掉行注释。 */
function modalTaskBody() {
  const start = app.indexOf('function modalTask(task)')
  assert.ok(start >= 0, '找不到 modalTask 函数')
  const end = app.indexOf('\n}', start)
  assert.ok(end > start, '找不到 modalTask 函数结尾')
  return app.slice(start, end).replace(/\/\/[^\n]*/g, '')
}

test('任务详情 modal 含「写范围」区块：声明的路径逐条以等宽 chip 列出', () => {
  const body = modalTaskBody()
  assert.match(body, /<div class="eyebrow" style="margin-bottom:6px">写范围<\/div>/, '写范围用与「评论」同款的 eyebrow 标题')
  assert.match(body, /<div class="scope-block">/, '写范围有独立容器')
  assert.match(body, /<div class="scope-chips">/, '非空时用 chip 行承载路径')
  assert.match(body, /writeScopes\.map\(scope =>/, '声明的路径逐条列出')
  assert.match(body, /class="approval-chip mono"/, '路径 chip 沿用审批卡片路径 chip 的等宽样式')
  assert.match(body, /title="\$\{attr\(scope\)\}"/, 'chip 保留完整路径的 title 提示（长路径省略时可查）')
  assert.match(body, /esc\(scope\)/, '路径走转义输出')
  // 区块位置：在「评论」分隔线之前，随任务元信息一起露出，不必翻到页尾。
  assert.ok(body.indexOf('scope-block') < body.indexOf('>评论<'), '写范围区块应在评论区之前')
})

test('未声明写范围：灰字兜底文案「未声明（保守串行）」，与非空分支同源互斥', () => {
  const body = modalTaskBody()
  assert.match(body, /'<div class="scope-empty">未声明（保守串行）<\/div>'/, '空集合显示未声明兜底文案')
  // 兜底与列表是同一个三元的两支：空集合走灰字，非空走 chip 行。
  assert.match(
    body,
    /writeScopes\.length\s*\?[\s\S]{0,400}?scope-chips[\s\S]{0,400}?:\s*'<div class="scope-empty">未声明（保守串行）<\/div>'/,
    '空/未声明与非空必须是互斥的两支，不会同时渲染',
  )
  assert.match(body, /Array\.isArray\(task\.writeScopes\)/, '缺失或非数组的 writeScopes 一律按未声明兜底')
})

test('数据源接线：taskView 透出 writeScopes，任务详情走 taskView', () => {
  assert.match(tasksService, /writeScopes: readWriteScopes\(rawScopes\)/, 'taskView 应透出归一化后的 writeScopes')
  assert.match(tasksService, /async taskDetail\(taskId\) \{[\s\S]*?\.\.\.this\.taskView\(task\)/, '任务详情沿用 taskView 的字段集')
  assert.match(modalTaskBody(), /task\.writeScopes/, '前端只读取 task.writeScopes，不另取状态源')
})

test('CSS：写范围 chip 容器可换行，未声明兜底为灰字', () => {
  const chips = css.match(/\.scope-chips \{[^}]+\}/)?.[0] ?? ''
  assert.ok(chips, '.scope-chips 规则必须存在于 styles.css')
  assert.match(chips, /display: flex/)
  assert.match(chips, /flex-wrap: wrap/, '多条路径换行排布，不横向溢出')
  const empty = css.match(/\.scope-empty \{[^}]+\}/)?.[0] ?? ''
  assert.ok(empty, '.scope-empty 规则必须存在于 styles.css')
  assert.match(empty, /var\(--ink-3\)/, '未声明兜底为弱化灰字')
  // chip 本体沿用审批卡片样式：等宽字体 + 卡片底色。
  assert.match(css, /\.approval-chip \{[^}]*font-family: var\(--mono\)/, 'chip 等宽字体沿用 .approval-chip')
})
