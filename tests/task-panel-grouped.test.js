// DSHBOTS-58 任务面板改分组列表（参照 Linear）——源码断言式测试。
// DSHBOTS-62 追加：已完成组收 done 任务、头部计数与各组计数之和一致、空组不渲染组体。
// 约定：ui/app.js 是浏览器 IIFE，按本项目 UI 惯例做源码断言；CSS 沿用正则抽规则体。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUiSource } from './helpers/ui-sources.js'
import { uiStylesSource } from './ui-styles-source.js'

const source = readUiSource()
const css = await uiStylesSource()

function block(selector) {
  const re = new RegExp(`${selector.replace(/[.[\]()]/g, ch => `\\${ch}`)}\\s*\\{([^}]*)\\}`)
  return re.exec(css)?.[1] ?? ''
}

// 时间筛选相关纯函数直接取 ui/app.js 的 task-time-range 标记块求值（tests/task-sort.test.js 先例）：
// 这样断言的是真实行为，而不是对源码文本的复述。
const timeBlock = /\/\/ task-time-range:start[\s\S]*?\/\/ task-time-range:end/.exec(source)?.[0]
assert.ok(timeBlock, 'ui/app.js 缺少 task-time-range 标记块')
const { taskEndsOutsideRange, taskTerminalTime } =
  new Function(`${timeBlock}\nreturn { taskEndsOutsideRange, taskTerminalTime }`)()

const STATUS_ORDER = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'canceled']

// 面板时间筛选的实际判定口径（与 ui/app.js filteredTasks 的判定一致）。
const hiddenByTimeRange = (task, timeRange) =>
  Boolean(taskTerminalTime(task) && taskEndsOutsideRange(task, timeRange))

test('任务面板按状态分组渲染，每组一个 section', () => {
  assert.match(source, /STATUS_ORDER\.map\(status => renderTaskGroup\(status, tasks\.filter\(task => task\.status === status\)\)\)/, '按状态分组渲染')
  assert.match(source, /<section class="column task-group/, '分组用 section 承载')
  assert.match(source, /class="board board-list"/, '看板容器标记为列表形态')
})

test('分组仍带 data-drop-status：拖拽换状态的通道不变', () => {
  assert.match(source, /<section class="column task-group[^"]*" data-drop-status="\$\{status\}">/, '分组保留 data-drop-status')
  assert.match(source, /closest\('\.column\[data-drop-status\]'\)/, '拖放命中仍按 .column[data-drop-status] 定位')
})

test('组头可折叠：展开态记在 state.openPanels（key: task-group:<status>）', () => {
  assert.match(source, /function taskGroupKey\(status\) \{\s*\n\s*return `task-group:\$\{status\}`/, 'panel key 形如 task-group:<status>')
  assert.match(source, /for \(const status of STATUS_ORDER\) state\.openPanels\.add\(taskGroupKey\(status\)\)/, '分组默认全展开')
  assert.match(source, /const expanded = state\.openPanels\.has\(key\)/, '渲染读取展开态')
  assert.match(source, /data-action="toggle-task-group"/, '组头有折叠按钮')
  assert.match(source, /case 'toggle-task-group'/, '点击事件处理折叠')
  assert.match(
    source,
    /if \(state\.openPanels\.has\(key\)\) state\.openPanels\.delete\(key\)\s*\n\s*else state\.openPanels\.add\(key\)/,
    '展开态增删走 openPanels',
  )
})

test('折叠时组体不渲染，组头计数保留', () => {
  assert.match(
    source,
    /\$\{expanded && body \? `<div class="task-group-body" data-panel="\$\{attr\(key\)\}">\$\{body\}<\/div>` : ''\}/,
    '折叠时（或空组时）不渲染组体',
  )
  assert.match(source, /<span class="column-count">\$\{tasks\.length\}<\/span>/, '组头计数不变')
})

test('任务行是紧凑单行：编号、标题、标签、运行态一行排开', () => {
  const card = block('.task-card')
  assert.match(card, /display:\s*flex/, '任务行为 flex 单行')
  assert.match(card, /align-items:\s*center/, '单行垂直居中')
  assert.match(card, /min-width:\s*0/, '允许收缩')
  assert.match(card, /overflow:\s*hidden/, '裁掉溢出')
  assert.match(block('.task-card-title'), /white-space:\s*nowrap/, '标题不换行')
  assert.match(block('.task-card-foot'), /flex:\s*0 1 auto/, '右侧运行态固定宽且可收缩')
})

test('拖拽样式与命中仍基于 .task-card / .column', () => {
  assert.match(source, /event\.target\.closest\('\.task-card'\)/, '拖拽源仍是任务行')
  assert.match(source, /document\.querySelectorAll\('\.column\.drop-target'\)/, '放下高亮仍是分组')
})

test('筛选与搜索工具栏位置不变', () => {
  assert.match(source, /id="task-search"/, '搜索框仍在工具栏')
  assert.match(source, /data-task-filter="status"/, '状态筛选仍在')
  assert.match(source, /data-task-filter="assignee"/, '成员筛选仍在')
  assert.match(source, /data-task-filter="timeRange"/, '时间筛选仍在')
  assert.match(source, /<span class="tag">\$\{shownCount\} 个任务<\/span>/, '任务总数标签仍在')
})

test('样式：看板纵向排列，分组是块级', () => {
  const board = block('.board')
  assert.match(board, /flex-direction:\s*column/, '看板纵向排布分组')
  assert.match(board, /align-items:\s*stretch/, '分组横向铺满')
  assert.match(block('.column'), /display:\s*block/, '分组是块级容器')
  assert.match(block('.column'), /min-width:\s*0/, '分组允许收缩')
  assert.match(block('.task-group-toggle'), /cursor:\s*pointer/, '折叠按钮可点')
})

// ── DSHBOTS-62：已完成组漏 done 任务、头部计数与分组对不上、空组大块空白 ──

test('已完成组收 done 任务：终态缺时间戳不被时间窗清空（P1-1）', () => {
  // done 是分组之一，分组按 status 取任务——done 任务按定义落「已完成」组
  assert.match(source, /const STATUS_ORDER = \[[^\]]*'done'[^\]]*\]/, 'done 在分组顺序里')
  assert.match(source, /renderTaskGroup\(status, tasks\.filter\(task => task\.status === status\)\)/, '分组按 status 取任务')
  // 时间筛选入口先看有没有终态时间基准：缺时间戳的终态任务不参与筛选、始终可见
  assert.match(
    source,
    /if \(taskTerminalTime\(task\) && taskEndsOutsideRange\(task, filter\.timeRange\)\) return false/,
    '时间筛选只对有终态时间戳的任务生效',
  )
  // 终态时间戳取值口径：done → completed_at，canceled → canceled_at
  assert.equal(taskTerminalTime({ status: 'done', completed_at: '2026-11-01T00:00:00.000Z' }), '2026-11-01T00:00:00.000Z')
  assert.equal(taskTerminalTime({ status: 'canceled', canceled_at: '2026-11-02T00:00:00.000Z' }), '2026-11-02T00:00:00.000Z')
  assert.equal(taskTerminalTime({ status: 'done' }), null, 'done 缺 completed_at 时没有时间基准')
  assert.equal(taskTerminalTime({ status: 'todo' }), null, '非终态没有终态时间')
  // 默认「近 7 天」窗口下的行为
  assert.equal(hiddenByTimeRange({ status: 'done' }, '7d'), false, '缺时间戳的 done 始终可见')
  assert.equal(hiddenByTimeRange({ status: 'canceled' }, '7d'), false, '缺时间戳的 canceled 始终可见')
  assert.equal(hiddenByTimeRange({ status: 'done', completed_at: '2020-01-01T00:00:00.000Z' }, '7d'), true, '窗口外的 done 仍按时间窗隐藏')
  assert.equal(hiddenByTimeRange({ status: 'todo' }, '7d'), false, '非终态不受时间窗影响')
  // 面板口径复现：库里 1 条无 completed_at 的 done，默认窗口下仍落在「已完成」组
  const tasks = [
    { identifier: 'DSH-1', status: 'todo' },
    { identifier: 'DSH-2', status: 'done' },
  ]
  const visible = tasks.filter(task => !hiddenByTimeRange(task, '7d'))
  const doneGroup = visible.filter(task => task.status === 'done')
  assert.equal(doneGroup.length, 1, 'done 任务必须出现在已完成组')
  assert.equal(doneGroup[0].identifier, 'DSH-2')
})

test('头部任务计数 = 各分组计数之和（P1-1）', () => {
  // 头部数字与分组计数同源：取各组计数之和，不再各算各的
  assert.match(
    source,
    /const groupCounts = STATUS_ORDER\.map\(status => tasks\.filter\(task => task\.status === status\)\.length\)/,
    '分组计数与分组渲染同源',
  )
  assert.match(source, /const shownCount = groupCounts\.reduce\(\(sum, count\) => sum \+ count, 0\)/, '头部计数取各组之和')
  assert.match(source, /<span class="tag">\$\{shownCount\} 个任务<\/span>/, '头部标签用各组之和')
  assert.doesNotMatch(source, /<span class="tag">\$\{tasks\.length\} 个任务<\/span>/, '头部不再用未分组的原始条数')
  // 与项目总数（设置页同源）的差额单独提示，不混进主计数
  assert.match(source, /const totalCount = Number\(project\.stats\?\.tasks/, '项目总数取设置页同源口径')
  assert.match(source, /const hiddenCount = Math\.max\(0, totalCount - shownCount\)/, '差额 = 项目总数 - 显示数')
  assert.match(source, /项目共 \$\{totalCount\} 个 · 隐藏 \$\{hiddenCount\} 个/, '差额以提示形式给出')
  // 行为：各组计数之和恒等于显示条数
  const tasks = [{ status: 'backlog' }, { status: 'todo' }, { status: 'todo' }, { status: 'done' }]
  const counts = STATUS_ORDER.map(status => tasks.filter(task => task.status === status).length)
  assert.equal(counts.reduce((sum, count) => sum + count, 0), tasks.length, '各组计数之和 = 头部计数')
  assert.equal(counts[STATUS_ORDER.indexOf('done')], 1, 'done 组计数独立统计')
})

test('空分组只留一行组头，不渲染组体占位（P1-4）', () => {
  assert.doesNotMatch(source, /board-empty/, '空组的「拖到这里」占位去掉')
  assert.match(source, /const body = tasks\.length === 0 \? '' : renderTaskRows\(tasks\)/, '空组组体为空')
  assert.match(source, /\$\{expanded && body \? `<div class="task-group-body"/, '空组不渲染组体容器')
  // 拖放通道不受影响：组 section 仍带 data-drop-status，空组仍是拖放目标
  assert.match(source, /<section class="column task-group[^"]*" data-drop-status="\$\{status\}">/, '空组仍是拖放目标')
})

// ── DSHBOTS-63：组内排序（创建/完成时间 × 正逆、优先级 × 正逆），不破坏分组与父子树 ──

// 取 ui/app.js 的 task-sort 标记块求值（时间块一并注入：完成时间排序引用 taskTerminalTime），
// 断言真实排序行为而不是复述源码文本。
const sortBlock = /\/\/ task-sort:start[\s\S]*?\/\/ task-sort:end/.exec(source)?.[0]
assert.ok(sortBlock, 'ui/app.js 缺少 task-sort 标记块')
const evalState = { taskSort: 'completed_desc' }
const { TASK_SORTS, sortTasksForPanel } =
  new Function(`const state = ${JSON.stringify(evalState)};\n${sortBlock}\n${timeBlock}\nreturn { TASK_SORTS, sortTasksForPanel }`)()

const sortTasks = [
  { id: 'a', number: 1, created_at: '2026-11-01T00:00:00.000Z', status: 'done', completed_at: '2026-11-02T00:00:00.000Z' },
  { id: 'b', number: 2, created_at: '2026-11-03T00:00:00.000Z', status: 'todo' },
  { id: 'c', number: 3, created_at: '2026-11-02T00:00:00.000Z', status: 'canceled', canceled_at: '2026-11-04T00:00:00.000Z' },
]

test('排序选择器存在且写 state.taskSort（D-63）', () => {
  assert.match(source, /taskSort: 'completed_desc',/, 'state 默认 completed_desc')
  assert.match(source, /<select class="select" data-task-sort aria-label="任务排序"/, '工具栏有排序选择器')
  assert.match(source, /if \(el\.matches\('\[data-task-sort\]'\)\) \{\s*\n\s*state\.taskSort = el\.value\s*\n\s*render\(\)/, 'change 分支写 state 后重渲染')
})

test('默认排序=完成时间 新→旧（DSHBOTS-76）', () => {
  // 默认值单一事实源在 ui/modules/state.js（上一测试的源码断言已锁字面量）；
  // 这里锁行为：不传 mode 时走 state.taskSort 默认档，无完成时间基准的任务排末尾不穿插。
  assert.deepEqual(sortTasksForPanel(sortTasks).map(task => task.id), ['c', 'a', 'b'], '不传 mode 默认按完成时间新→旧')
})

test('六种排序值齐全', () => {
  assert.deepEqual(
    TASK_SORTS.map(sort => sort.value),
    ['created_desc', 'created_asc', 'completed_desc', 'completed_asc', 'priority_desc', 'priority_asc'],
    '六档口径',
  )
  assert.equal(new Set(TASK_SORTS.map(sort => sort.value)).size, 6, '值不重复')
})

test('组内排序不破坏分组与父子树：排序在 renderTaskRows 建树前、分组在渲染上游', () => {
  assert.match(source, /renderTaskGroup\(status, tasks\.filter\(task => task\.status === status\)\)/, '分组仍按 status 切片')
  assert.match(
    source,
    /const sorted = sortTasksForPanel\(tasks\)\s*\n\s*const visible = new Set\(sorted\.map\(task => task\.id\)\)/,
    '排序结果供建树使用',
  )
  assert.match(
    source,
    /for \(const task of sorted\) \{\s*\n\s*const parentId = taskParentId\(task\)/,
    '父子挂载仍按 parent_task_id 判定，与顺序无关',
  )
  // 行为验证：父+子同组时，排序后子任务仍挂到父行下（树由 parent_task_id 组装，顺序只影响兄弟先后）
  const group = [
    { id: 'p1', parent_task_id: null },
    { id: 'c1', parent_task_id: 'p1' },
    { id: 'p2', parent_task_id: null },
  ]
  const ordered = sortTasksForPanel(group, 'created_asc')
  const ids = ordered.map(task => task.id)
  assert.equal(new Set(ids).size, 3, '排序不丢任务')
  assert.ok(ids.includes('p1') && ids.includes('c1') && ids.includes('p2'), '父与子都在组内')
})

test('完成时间排序：非终态与缺时间戳终态排末尾不穿插（D-63）', () => {
  const withNoStamp = [
    ...sortTasks,
    { id: 'd', number: 4, created_at: '2026-11-05T00:00:00.000Z', status: 'done' }, // 终态但缺 completed_at
  ]
  const desc = sortTasksForPanel(withNoStamp, 'completed_desc').map(task => task.id)
  assert.deepEqual(desc, ['c', 'a', 'b', 'd'], 'desc：有时间的终态按新→旧在前，其余按原序殿后')
  const asc = sortTasksForPanel(withNoStamp, 'completed_asc').map(task => task.id)
  assert.deepEqual(asc, ['a', 'c', 'b', 'd'], 'asc：有时间的终态按旧→新在前，非终态/缺时间戳仍按原序殿后')
})

test('创建时间与优先级排序口径（D-63）', () => {
  assert.deepEqual(sortTasksForPanel(sortTasks, 'created_desc').map(task => task.id), ['b', 'c', 'a'], '创建时间新→旧')
  assert.deepEqual(sortTasksForPanel(sortTasks, 'created_asc').map(task => task.id), ['a', 'c', 'b'], '创建时间旧→新')
  const byPriority = [
    { id: 'low', priority: 'low' },
    { id: 'urgent', priority: 'urgent' },
    { id: 'mid', priority: 'medium' },
  ]
  assert.deepEqual(sortTasksForPanel(byPriority, 'priority_desc').map(task => task.id), ['urgent', 'mid', 'low'], '优先级高→低')
  assert.deepEqual(sortTasksForPanel(byPriority, 'priority_asc').map(task => task.id), ['low', 'mid', 'urgent'], '优先级低→高')
})
