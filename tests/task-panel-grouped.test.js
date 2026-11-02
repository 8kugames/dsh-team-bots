// DSHBOTS-58 任务面板改分组列表（参照 Linear）——源码断言式测试。
// 约定：ui/app.js 是浏览器 IIFE，按本项目 UI 惯例做源码断言；CSS 沿用正则抽规则体。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../ui/styles.css', import.meta.url)), 'utf8')

function block(selector) {
  const re = new RegExp(`${selector.replace(/[.[\]()]/g, ch => `\\${ch}`)}\\s*\\{([^}]*)\\}`)
  return re.exec(css)?.[1] ?? ''
}

test('任务面板按状态分组渲染，每组一个 section', () => {
  assert.match(source, /STATUS_ORDER\.map\(status => renderTaskGroup\(status, tasks\.filter\(task => task\.status === status\)\)\)/, '按状态分组渲染')
  assert.match(source, /<section class="column task-group/, '分组用 section 承载')
  assert.match(source, /class="board board-list"/, '看板容器标记为列表形态')
})

test('分组仍带 data-drop-status：拖拽换状态的通道不变', () => {
  assert.match(source, /<section class="column task-group[^"]*" data-drop-status="\$\{status\}">/, '分组保留 data-drop-status')
  assert.match(source, /closest\('\.column\[data-drop-status\]'\)/, '拖放命中仍按 .column[data-drop-status] 定位')
})

test('组头可折叠：折叠态存 state.collapsedTaskGroups', () => {
  assert.match(source, /collapsedTaskGroups: new Set\(\)/, '状态里有折叠集合')
  assert.match(source, /const collapsed = state\.collapsedTaskGroups\.has\(status\)/, '渲染读取折叠态')
  assert.match(source, /data-action="toggle-task-group"/, '组头有折叠按钮')
  assert.match(source, /case 'toggle-task-group'/, '点击事件处理折叠')
  assert.match(
    source,
    /if \(state\.collapsedTaskGroups\.has\(status\)\) state\.collapsedTaskGroups\.delete\(status\)\s*\n\s*else state\.collapsedTaskGroups\.add\(status\)/,
    '折叠态增删',
  )
})

test('折叠时组体不渲染，组头计数保留', () => {
  assert.match(source, /\$\{collapsed \? '' : `<div class="task-group-body">\$\{body\}<\/div>`\}/, '折叠时不渲染组体')
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
  assert.match(source, /<span class="tag">\$\{tasks\.length\} 个任务<\/span>/, '任务总数标签仍在')
})

test('样式：看板纵向排列，分组是块级', () => {
  const board = block('.board')
  assert.match(board, /flex-direction:\s*column/, '看板纵向排布分组')
  assert.match(board, /align-items:\s*stretch/, '分组横向铺满')
  assert.match(block('.column'), /display:\s*block/, '分组是块级容器')
  assert.match(block('.column'), /min-width:\s*0/, '分组允许收缩')
  assert.match(block('.task-group-toggle'), /cursor:\s*pointer/, '折叠按钮可点')
})
