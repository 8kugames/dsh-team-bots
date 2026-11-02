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

test('看板列与卡片允许收缩，长标题不再撑破列宽', () => {
  assert.match(block('.column'), /min-width:\s*0/, '列需 min-width:0，否则被长标题最小内容宽度顶开')
  assert.match(block('.task-card'), /min-width:\s*0/, '卡片需 min-width:0')
  assert.match(block('.task-card'), /overflow:\s*hidden/, '卡片需 overflow:hidden，裁掉溢出内容')
})

test('任务卡标题限 3 行并允许任意位置断行', () => {
  const title = block('.task-card-title')
  assert.match(title, /display:\s*-webkit-box/, '需用 -webkit-box 才能配合 line-clamp')
  assert.match(title, /-webkit-line-clamp:\s*3/, '标题限 3 行')
  assert.match(title, /line-clamp:\s*3/, '同时写标准 line-clamp')
  assert.match(title, /-webkit-box-orient:\s*vertical/, 'clamp 需要垂直方向')
  assert.match(title, /overflow:\s*hidden/, '超出行数需裁掉')
  assert.match(title, /overflow-wrap:\s*anywhere/, '不可断长串需 anywhere 断行')
})

test('任务号省略号、优先级不压缩', () => {
  const id = block('.task-id')
  assert.match(id, /text-overflow:\s*ellipsis/, '任务号过长需省略号')
  assert.match(id, /overflow:\s*hidden/, '任务号需裁掉')
  assert.match(id, /white-space:\s*nowrap/, '任务号单行')
  assert.match(id, /min-width:\s*0/, '任务号作为 flex 项需允许收缩')
  assert.match(block('.task-priority'), /flex:\s*0 0 auto/, '优先级标签不压缩')
})

test('标题 hover 可看全文', () => {
  assert.match(
    source,
    /<div class="task-card-title" title="\$\{attr\(task\.title\)\}">\$\{esc\(task\.title\)\}<\/div>/,
    '标题需带 title 属性显示完整标题',
  )
})
