// DSHBOTS-63 派生子任务——源码断言 + 行为断言式测试。
// 任务详情 modal footer 的「派生子任务」按钮：复用新建任务表单并预填 parentTaskId，
// 预填必须让父任务下拉真正选中该任务（值与显示一致），不是值带了、下拉仍显示「无（顶层任务）」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')

test('任务详情 footer 有「派生子任务」按钮且带 data-task-id', () => {
  assert.match(
    source,
    /data-action="derive-subtask" data-task-id="\$\{attr\(task\.id\)\}"/,
    '按钮挂在任务详情 footer 并携带任务 id',
  )
})

test('derive-subtask 分支：校验父任务存在后以 parentTaskId 打开新建表单', () => {
  assert.match(source, /case 'derive-subtask': \{/, '点击分发存在')
  assert.match(
    source,
    /openModal\(\{ type: 'new-task', parentTaskId: parentId \}\)/,
    '复用 new-task 表单并携带 parentTaskId',
  )
  assert.match(
    source,
    /!\(state\.data\?\.tasks \?\? \[\]\)\.some\(task => task\.id === parentId\)/,
    '父任务不在当前列表时拒绝打开（防刷新后悬空 id）',
  )
})

test('modalNewTask 读 state.modal.parentTaskId 预填：下拉显示该父任务而非「无」', () => {
  assert.match(source, /const preselectedParent = state\.modal\?\.parentTaskId \?\? ''/, '预填来源')
  // 空选项始终是首个 option（无预填时浏览器默认选中它）；预填时父任务选项带 selected 显式覆盖默认。
  assert.match(
    source,
    /<option value="">无（顶层任务）<\/option>\$\{taskRelationOptions\(preselectedParent\)\}/,
    '父任务选项列表接收预填 id',
  )
  assert.match(source, /function taskRelationOptions\(selectedId = ''\)/, '选项函数支持选中标记')
})

test('行为：taskRelationOptions 给指定任务打 selected，其余不打', () => {
  const fn = new Function(`
    const attr = value => String(value ?? '');
    const esc = value => String(value ?? '');
    const state = { data: { tasks: [
      { id: 't1', identifier: 'DSH-1', title: '父任务' },
      { id: 't2', identifier: 'DSH-2', title: '另一个' },
    ] } };
    ${/\/\/ 任务关系选项（DSHBOTS-58）[\s\S]*?\n\}/.exec(source)?.[0] ?? ''}
    return taskRelationOptions;
  `)()
  const html = fn('t1')
  assert.match(html, /<option value="t1" selected>DSH-1 · 父任务<\/option>/, '指定父任务选中')
  assert.match(html, /<option value="t2">DSH-2 · 另一个<\/option>/, '其余任务不选中')
  assert.equal(fn(''), html.replace(' selected', ''), '无预填时不打 selected')
})

test('提交链路透传 parentTaskId（D-58 落地行为不回退）', () => {
  assert.match(source, /parentTaskId: payload\.parentTaskId \|\| null/, 'create-task 提交仍透传父任务')
})
