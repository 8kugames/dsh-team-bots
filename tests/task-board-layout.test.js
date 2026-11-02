import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../ui/styles.css', import.meta.url)), 'utf8')

// 取某个选择器的规则体（选择器需写全，如后代选择器 '.task-card-foot .task-run-label'）。
function block(selector) {
  const escaped = selector.replace(/[.[\]()]/g, ch => `\\${ch}`).replace(/\s+/g, '\\s+')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`)
  return re.exec(css)?.[1] ?? ''
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
  assert.match(source, /<span class="task-run-label">\$\{runLabel\}<\/span>/, '运行标签需带 class 供样式命中')
})

test('任务详情弹窗标题长串可断行，不撑破弹窗', () => {
  assert.match(block('.modal-head h2'), /overflow-wrap:\s*anywhere/, '弹窗标题需允许任意位置断行')
})
