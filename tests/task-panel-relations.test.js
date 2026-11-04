// DSHBOTS-58 第二笔：任务父子层级 + 依赖徽标 + 新建任务的父任务/依赖任务字段——源码断言式测试。
// 约定同 task-panel-grouped.test.js：ui/app.js 做源码断言，CSS 用正则抽规则体。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { uiStylesSource } from './ui-styles-source.js'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const css = await uiStylesSource()

function block(selector) {
  const re = new RegExp(`${selector.replace(/[.[\]()]/g, ch => `\\${ch}`)}\\s*\\{([^}]*)\\}`)
  return re.exec(css)?.[1] ?? ''
}

test('分组内按 parent_task_id 组树：父任务同组可见才挂成子级', () => {
  assert.match(source, /function renderTaskRows\(tasks\)/, '组内行由 renderTaskRows 输出')
  assert.match(source, /const parentId = taskParentId\(task\)/, '取父任务 id')
  assert.match(source, /if \(parentId && visible\.has\(parentId\)\)/, '父任务也在本组可见才挂子级')
  assert.match(source, /else \{\s*\n\s*roots\.push\(task\)/, '父不可见时子任务回到顶层')
  assert.match(source, /function taskParentId\(task\) \{\s*\n\s*return task\?\.parent_task_id \?\? task\?\.parentTaskId \?\? null/, '兼容 snake_case 与 camelCase 两种父字段')
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
  assert.match(source, /function taskChildrenKey\(taskId\) \{\s*\n\s*return `task-children:\$\{taskId\}`/, 'panel key 形如 task-children:<id>')
  assert.match(source, /state\.openPanels\.has\(key\)/, '渲染读取展开态')
  assert.match(source, /data-action="toggle-task-children"/, '父行有子任务折叠按钮')
  assert.match(source, /case 'toggle-task-children'/, '点击事件处理折叠')
  assert.match(
    source,
    /if \(state\.openPanels\.has\(key\)\) state\.openPanels\.delete\(key\)\s*\n\s*else state\.openPanels\.add\(key\)/,
    '展开态增删走 openPanels',
  )
})

test('依赖徽标：depsSatisfied=false 时行尾显示「被 N 个任务阻塞」，title 列未满足项', () => {
  assert.match(source, /const depsBlocked = task\.depsSatisfied === false && blockedNames\.length > 0/, '只有依赖未满足才显示')
  assert.match(source, /const blockedNames = Array\.isArray\(task\.blockedByNames\) \? task\.blockedByNames : \[\]/, '读 blockedByNames')
  assert.match(source, /class="task-deps-badge" title="\$\{attr\(depsTitle\)\}"/, '徽标带 title')
  assert.match(source, /const depsTitle = `被 \$\{blockedNames\.length\} 个任务阻塞：\$\{blockedNames\.join\('、'\)\}`/, 'title 列出未满足的依赖编号')
  assert.match(source, />\$\{icon\('alert'\)\}被 \$\{blockedNames\.length\} 个任务阻塞</, '徽标文案是被 N 个任务阻塞')
  const badge = block('.task-deps-badge')
  assert.ok(badge, '找不到 .task-deps-badge 样式块')
  assert.match(badge, /color:\s*var\(--danger\)/, '徽标用 danger 色')
})

test('新建任务表单：可选父任务与依赖任务', () => {
  assert.match(source, /id="new-task-parent" name="parentTaskId"/, '有父任务下拉')
  assert.match(source, /<option value="">无（顶层任务）<\/option>/, '父任务默认不选')
  assert.match(source, /id="new-task-blocked" name="blockedBy" multiple/, '依赖任务是多选')
  // D-63 派生子任务：taskRelationOptions 增加 selectedId 参数（预填父任务时给对应 option 打 selected），选项来源不变。
  assert.match(source, /function taskRelationOptions\(selectedId = ''\)/, '选项来自本项目任务')
  assert.match(source, /const tasks = state\.data\?\.tasks \?\? \[\]/, '选项取当前项目任务列表')
})

test('提交把父任务与依赖任务交给 create_task', () => {
  assert.match(source, /const blockedBy = new FormData\(form\)\.getAll\('blockedBy'\)\.map\(String\)\.filter\(Boolean\)/, '多选取全部选中项')
  assert.match(source, /parentTaskId: payload\.parentTaskId \|\| null/, '空父任务即不建关系')
  assert.match(source, /blockedBy,/, '依赖任务随创建请求提交')
  assert.match(source, /api\('create_task', \{[\s\S]*?parentTaskId: payload\.parentTaskId \|\| null,[\s\S]*?blockedBy,/, 'create_task 请求带上两个关系字段')
})

test('分组头计数不受层级影响', () => {
  assert.match(source, /<span class="column-count">\$\{tasks\.length\}<\/span>/, '组头计数仍是本组任务总数')
})

test('任务详情里也能看到父任务与被阻塞项', () => {
  assert.match(source, /const parentTask = \(state\.data\?\.tasks \?\? \[\]\)\.find\(item => item\.id === \(task\.parent_task_id \?\? task\.parentTaskId \?\? null\)\)/, '详情取父任务')
  assert.match(source, /父任务：\$\{esc\(parentTask\.identifier\)\} · \$\{esc\(parentTask\.title\)\}/, '详情显示父任务编号与标题')
  assert.match(source, /被 \$\{blockedNames\.length\} 个任务阻塞：\$\{esc\(blockedNames\.join\('、'\)\)\}/, '详情显示被阻塞项')
})
