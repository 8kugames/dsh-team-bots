import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'

const source = readUiSource()
const css = readFileSync(fileURLToPath(new URL('../ui/styles.css', import.meta.url)), 'utf8')

// 取某个选择器的规则体（选择器需写全，如后代选择器 '.task-card-foot .task-run-label'）。
function block(selector) {
  const escaped = selector.replace(/[.[\]()]/g, ch => `\\${ch}`).replace(/\s+/g, '\\s+')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`)
  return re.exec(css)?.[1] ?? ''
}

// 取 @media (max-width: Npx) 断点内的全部规则（大括号配平，避免只截到第一条子规则）。
// 同一断点可能有多处，用 hint 挑出真正含目标规则的那一段。
function mediaBlock(maxWidth, hint = '') {
  const marker = `@media (max-width: ${maxWidth}px) {`
  let from = 0
  for (;;) {
    const start = css.indexOf(marker, from)
    if (start < 0) return ''
    let depth = 0
    for (let i = start + marker.length - 1; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) {
        const body = css.slice(start, i + 1)
        if (!hint || body.includes(hint)) return body
        from = i + 1
        break
      }
    }
  }
}

test('任务卡标题单行省略，完整标题走 hover', () => {
  // DSHBOTS-58 起任务行改紧凑单行：标题不再换行，宽度不足时单行省略号，全文靠 title 属性。
  const title = block('.task-card-title')
  assert.match(title, /white-space:\s*nowrap/, '紧凑单行标题不换行')
  assert.match(title, /overflow:\s*hidden/, '超出宽度需裁掉')
  assert.match(title, /text-overflow:\s*ellipsis/, '超出宽度需省略号')
  assert.match(title, /min-width:\s*0/, '标题作为 flex 项需允许收缩')
})

test('看板列与卡片允许收缩，长标题不再撑破列宽', () => {
  assert.match(block('.column'), /min-width:\s*0/, '列需 min-width:0，否则被内容最小宽度顶开')
  assert.match(block('.task-card'), /min-width:\s*0/, '卡片需 min-width:0')
  assert.match(block('.task-card'), /overflow:\s*hidden/, '卡片需 overflow:hidden，裁掉内部溢出')
})

test('标题 hover 可看全文，走 attr 转义', () => {
  assert.match(
    source,
    /<div class="task-card-title" title="\$\{attr\(task\.title\)\}">\$\{esc\(task\.title\)\}<\/div>/,
    '标题需带 title 属性显示完整标题',
  )
})

test('任务号省略号、优先级不压缩、运行标签单行省略', () => {
  const id = block('.task-id')
  assert.match(id, /min-width:\s*0/, '任务号作为 flex 项需允许收缩')
  assert.match(id, /overflow:\s*hidden/, '任务号需裁掉')
  assert.match(id, /text-overflow:\s*ellipsis/, '任务号过长需省略号')
  assert.match(id, /white-space:\s*nowrap/, '任务号单行')
  assert.match(block('.task-priority'), /flex:\s*0 0 auto/, '优先级标签不压缩')
  assert.match(block('.task-card-foot'), /min-width:\s*0/, '卡片底行需允许收缩')
  const runLabel = block('.task-card-foot .task-run-label')
  assert.match(runLabel, /text-overflow:\s*ellipsis/, '运行标签过长需省略号')
  // 基类 task-run-label 必须在（供省略号等样式命中）；后缀修饰类（工单七态的 person 强调，DSHBOTS-137）允许按 stage 插值。
  assert.match(source, /<span class="task-run-label\$\{stage\.stage === 'person' \? ' task-stage-person' : ''\}">\$\{runLabel\}<\/span>/, '运行标签需带 class 供样式命中')
})

test('任务详情弹窗标题长串可断行，不撑破弹窗', () => {
  assert.match(block('.modal-head h2'), /overflow-wrap:\s*anywhere/, '弹窗标题需允许任意位置断行')
})

// ── DSHBOTS-58 参照 Linear 的分组树形列表 ──

test('分组树容器：分组是 section.task-group，组体是 div.task-group-body[data-panel]', () => {
  assert.match(source, /<section class="column task-group/, '分组用 section 承载')
  assert.match(
    source,
    /<div class="task-group-body" data-panel="\$\{attr\(key\)\}">\$\{body\}<\/div>/,
    '组体容器带稳定的 panel key',
  )
  assert.match(source, /class="board board-list"/, '看板容器标记为列表形态')
  assert.match(source, /class="column-head task-group-head"/, '组头有独立 class')
  assert.match(source, /<span class="column-dot \$\{status\}">/, '组头是状态色圆点 + 状态名 + 计数')
})

test('投放目标保留：分组仍带 data-drop-status，拖放命中仍按 .column[data-drop-status]', () => {
  assert.match(source, /<section class="column task-group[^"]*" data-drop-status="\$\{status\}">/, '分组保留 data-drop-status')
  assert.match(source, /closest\('\.column\[data-drop-status\]'\)/, '拖放命中仍按 .column[data-drop-status] 定位')
  assert.match(source, /event\.target\.closest\('\.task-card'\)/, '拖拽源仍是任务行')
})

test('任务行结构：状态图标 + 优先级图标 + 编号 + 标题 + 右簇（运行/终态时间/头像）', () => {
  assert.match(source, /\$\{taskStatusIcon\(task\)\}/, '行首是状态图标')
  assert.match(source, /\$\{taskPriorityIcon\(task\)\}/, '行首是优先级图标')
  assert.match(source, /function taskStatusIcon\(task\)/, '有状态图标渲染函数')
  assert.match(source, /function taskPriorityIcon\(task\)/, '有优先级图标渲染函数')
  assert.match(source, /class="task-status-icon \$\{attr\(status\)\}"/, '状态图标带状态 class 供配色')
  assert.match(source, /class="task-priority \$\{key\}"/, '优先级图标带档位 class 供配色')
  assert.match(source, /<span class="task-id">\$\{esc\(task\.identifier\)\}<\/span>/, '编号单独成簇')
  assert.match(source, /\$\{bot \? avatar\(bot, 'sm'\) : '<span class="faint">未指派<\/span>'\}/, '行尾是负责人头像')
  assert.match(source, /<span class="task-end-time" title="\$\{attr\(endAt\)\}">/, '终态时间小字在行尾')
})

test('状态图标：Linear 式小圆环，各状态沿用现有状态色 token', () => {
  const icon = block('.task-status-icon')
  assert.ok(icon, '找不到 .task-status-icon 样式块')
  assert.match(icon, /border-radius:\s*50%/, '状态图标是圆环')
  assert.match(block('.task-status-icon.todo'), /color:\s*var\(--accent\)/, '待执行用 accent 色')
  assert.match(block('.task-status-icon.in_progress'), /color:\s*var\(--star\)/, '进行中用 star 色')
  assert.match(block('.task-status-icon.blocked'), /color:\s*var\(--danger\)/, '受阻用 danger 色')
  assert.match(block('.task-status-icon.done'), /color:\s*var\(--green\)/, '已完成用 green 色')
  assert.match(source, /status === 'done' \? icon\('check'\) : ''/, '已完成是环内对勾')
})

test('优先级图标：三档横条，配色沿用现有优先级色', () => {
  assert.match(block('.task-priority.urgent'), /color:\s*var\(--danger\)/, '紧急用 danger 色')
  assert.match(block('.task-priority.high'), /color:\s*var\(--star\)/, '高用 star 色')
  assert.match(block('.task-priority.medium'), /color:\s*var\(--accent\)/, '中用 accent 色')
  assert.match(source, /priority: '<path d="M4 7h13M4 12h9M4 17h5"\/>/, '优先级是三档横条图标')
})

test('视觉：紧凑 32px 行、无边框无卡片阴影、hover 高亮、分组间距 8px', () => {
  const row = block('.task-card')
  assert.match(row, /height:\s*32px/, '行高 32px')
  assert.match(row, /border:\s*none/, '行无边框')
  assert.match(row, /box-shadow:\s*none/, '行无卡片阴影')
  assert.match(row, /align-items:\s*center/, '单行垂直居中')
  assert.match(block('.task-card:hover'), /background:\s*var\(--surface-2\)/, 'hover 有底色高亮')
  assert.match(block('.board'), /gap:\s*8px/, '分组间距 8px')
  assert.match(block('.board'), /flex-direction:\s*column/, '看板纵向排布分组')
})

test('小屏（≤720px）：任务行让出标签与运行文案，标题不被裁掉', () => {
  const small = mediaBlock(720, '.task-card')
  assert.ok(small, '找不到 ≤720px 断点')
  assert.match(small, /\.task-tags \{[\s\S]*?display:\s*none/, '小屏隐藏标签簇')
  assert.match(small, /\.task-card-foot \.task-run-label \{[\s\S]*?display:\s*none/, '小屏隐藏运行文案')
  assert.match(small, /\.task-card \{[\s\S]*?padding:\s*0 6px/, '小屏收紧行内边距')
})
