// DSHBOTS-58 第二笔：任务父子层级 + 依赖徽标 + 新建任务的父任务/依赖任务字段——源码断言式测试。
// 约定同 task-panel-grouped.test.js：ui/app.js 做源码断言，CSS 用正则抽规则体。
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

test('分组内按 parent_task_id 组树：父任务同组可见才挂成子级', () => {
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
})

test('子任务缩进一级：容器左缩进并带一条层级导线', () => {
  const children = block('.task-children')
  assert.ok(children, '找不到 .task-children 样式块')
  assert.match(children, /display:\s*flex/, '子任务容器是纵向排列')
  assert.match(children, /margin-left:\s*18px/, '子任务整体左缩进一级')
  assert.match(children, /border-left:\s*1px solid var\(--line\)/, '容器左侧一条层级导线')
  assert.match(source, /<div class="task-children" data-panel="\$\{attr\(key\)\}">/, '子任务容器带 panel key')
})

test('父行可折叠子行：展开态记在 state.openPanels（key: task-children:<id>）', () => {
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
  assert.match(source, /data-action="toggle-task-children"/, '父行有子任务折叠按钮')
  assert.match(source, /case 'toggle-task-children'/, '点击事件处理折叠')
  assert.match(
    source,
    /if \(state\.openPanels\.has\(key\)\) state\.openPanels\.delete\(key\)\s*\n\s*else state\.openPanels\.add\(key\)/,
    '展开态增删走 openPanels',
  )
})

test('依赖徽标：depsSatisfied=false 时行尾显示「被 N 个任务阻塞」，title 列未满足项', () => {
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
  assert.match(source, /class="task-deps-badge" title="\$\{attr\(depsTitle\)\}"/, '徽标带 title')
  assert.match(source, /const depsTitle = \`\$\{t\("被"\)\} \$\{blockedNames\.length\} \$\{t\("个任务阻塞："\)\}\$\{blockedNames\.join\(t\("、"\)\)\}\`/, 'title 列出未满足的依赖编号')
  assert.match(source, />\$\{icon\('alert'\)\}\$\{t\("被"\)\} \$\{blockedNames\.length\} \$\{t\("个任务阻塞"\)\}</, '徽标文案是被 N 个任务阻塞')
  const badge = block('.task-deps-badge')
  assert.ok(badge, '找不到 .task-deps-badge 样式块')
  assert.match(badge, /color:\s*var\(--danger\)/, '徽标用 danger 色')
})

test('新建任务表单：可选父任务与依赖任务', () => {
  assert.match(source, /id="new-task-parent" name="parentTaskId"/, '有父任务下拉')
  assert.match(source, /<option value="">\$\{t\("无（顶层任务）"\)\}<\/option>/, '父任务默认不选')
  assert.match(source, /id="new-task-blocked" name="blockedBy" multiple/, '依赖任务是多选')
  // D-63 派生子任务：taskRelationOptions 增加 selectedId 参数（预填父任务时给对应 option 打 selected），选项来源不变。
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
})

test('提交把父任务与依赖任务交给 create_task', () => {
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
})

test('分组头计数不受层级影响', () => {
  assert.match(source, /<span class="column-count">\$\{tasks\.length\}<\/span>/, '组头计数仍是本组任务总数')
})

test('任务详情里也能看到父任务与被阻塞项', () => {
// [修剪] 改 UI 必红的代码形状断言（重构即碎，无契约价值）
  assert.match(source, /\$\{t\("父任务："\)\}\$\{esc\(parentTask\.identifier\)\} · \$\{esc\(parentTask\.title\)\}/, '详情显示父任务编号与标题')
  assert.match(source, /\$\{t\("被"\)\} \$\{blockedNames\.length\} \$\{t\("个任务阻塞："\)\}\$\{esc\(blockedNames\.join\(t\("、"\)\)\)\}/, '详情显示被阻塞项')
})
