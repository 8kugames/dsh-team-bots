// DSHBOTS-129 新建任务表单「时效要求（分钟）」输入框 + 任务详情「时效」行——读源码断言。
// 约定沿用 tests/task-scope-display.test.js：ui/app.js 是浏览器脚本，按源码断言；
// 先剔行注释再断言，防止「断言写进注释里」的假锁。归一纯函数用 time-budget 标记块抽取后裸执行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readUiSource } from './helpers/ui-sources.js'

const app = readUiSource()
const zh = readFileSync(new URL('../ui/i18n/zh.js', import.meta.url), 'utf8')
const en = readFileSync(new URL('../ui/i18n/en.js', import.meta.url), 'utf8')

/** 取出某个函数体（到列首的函数收尾为止）并剔掉行注释。 */
function functionBody(source, signature) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `找不到 ${signature}`)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, `找不到 ${signature} 的结尾`)
  return source.slice(start, end).replace(/\/\/[^\n]*/g, '')
}

/** 取出 create-task 提交分支的源码（到下一个分支为止）。 */
function createTaskBranch() {
  const start = app.indexOf("if (type === 'create-task') {")
  assert.ok(start >= 0, '找不到 create-task 提交分支')
  const end = app.indexOf("if (type === 'update-task') {", start)
  assert.ok(end > start, '找不到 create-task 分支的边界')
  return app.slice(start, end).replace(/\/\/[^\n]*/g, '')
}

test('新建任务表单含「时效要求（分钟）」可选数字输入框，placeholder 注明选填留空不设', () => {
  const body = functionBody(app, 'function modalNewTask()')
  assert.match(body, /id="new-task-time-budget"/, '表单必须有该输入框')
  assert.match(body, /name="time_budget_minutes"/, '表单字段名与服务端/工具参数同口径（time_budget_minutes）')
  assert.match(body, /type="number"/, '只接受数字输入')
  assert.match(body, /min="1"/, '下限 1 分钟')
  assert.match(body, /max="10080"/, '上限 10080 分钟（一周），与服务端钳制一致')
  assert.match(body, /t\('taskForm\.timeBudgetLabel'\)/, '标签走 i18n，不写死中文')
  assert.match(body, /placeholder="\$\{attr\(t\('taskForm\.timeBudgetPlaceholder'\)\)\}"/, 'placeholder 走 i18n 且转义')
  // 选填：不得带 required，否则留空无法提交（留空 = 不设时效）。
  assert.doesNotMatch(body, /id="new-task-time-budget"[^>]*required/, '该输入框是选填，不得标 required')
  // 版式：时效字段与「指派给/优先级」同一行，三列自适应（宽屏三列、窄屏自动收成单列），不留空格子。
  assert.match(
    body,
    /<div class="field-row" style="grid-template-columns:repeat\(auto-fit,minmax\(180px,1fr\)\)">[\s\S]*?id="new-task-time-budget"/,
    '时效字段所在行用自适应三列版式（窄屏自动折行，不留空位）',
  )
  // 字典值必须是「选填，留空不设」口径。
  assert.match(zh, /'taskForm\.timeBudgetPlaceholder': '选填，留空不设'/, '中文 placeholder 注明选填留空不设')
})

test('时效归一：空串/0/负数/非数字 → null（提交时整键不传），正数取整数分钟', () => {
  const block = /\/\/ time-budget:start[\s\S]*?\/\/ time-budget:end/.exec(app)?.[0]
  assert.ok(block, 'ui/app.js 缺少 time-budget 标记块')
  const { normalizeTimeBudgetMinutes } = new Function(`${block}\nreturn { normalizeTimeBudgetMinutes }`)()

  assert.equal(normalizeTimeBudgetMinutes(''), null, '空串 → null')
  assert.equal(normalizeTimeBudgetMinutes('   '), null, '纯空白 → null')
  assert.equal(normalizeTimeBudgetMinutes(undefined), null, '未填 → null')
  assert.equal(normalizeTimeBudgetMinutes(null), null, 'null → null')
  assert.equal(normalizeTimeBudgetMinutes('0'), null, '0 → null（不得当成 1 分钟）')
  assert.equal(normalizeTimeBudgetMinutes(0), null, '数字 0 → null')
  assert.equal(normalizeTimeBudgetMinutes('-5'), null, '负数 → null')
  assert.equal(normalizeTimeBudgetMinutes('abc'), null, '非数字 → null')
  assert.equal(normalizeTimeBudgetMinutes('30'), 30, '正数字符串 → 30')
  assert.equal(normalizeTimeBudgetMinutes(45), 45, '正数 → 45')
  assert.equal(normalizeTimeBudgetMinutes('30.7'), 30, '小数向下取整到整分钟')
})

test('提交映射：读 formData 的 time_budget_minutes，归一为 null 时整键不传', () => {
  const branch = createTaskBranch()
  assert.match(
    branch,
    /normalizeTimeBudgetMinutes\(payload\.time_budget_minutes\)/,
    '提交时取表单字段 time_budget_minutes 并归一',
  )
  assert.match(
    branch,
    /\.\.\.\(timeBudgetMinutes === null \? \{\} : \{ time_budget_minutes: timeBudgetMinutes \}\)/,
    '归一为 null 时整键不传（不把空值当时效下发）',
  )
  // 不得残留旧的 camelCase 直传写法（会把空串当真值判断）。
  assert.doesNotMatch(branch, /timeBudgetMinutes:\s*payload\.timeBudgetMinutes/, '不得再直传未归一的表单值')
})

test('任务详情 modal：时效行条件渲染——有值显示「X 分钟」+ 小字说明，NULL 整行不出现', () => {
  const body = functionBody(app, 'function modalTask(task)')
  assert.match(body, /task\.timeBudgetMinutes \?/, '时效行以 task.timeBudgetMinutes 为条件（NULL 不显示）')
  assert.match(
    body,
    /t\('task\.timeBudgetValue', \{ minutes: Number\(task\.timeBudgetMinutes\) \}\)/,
    '有值时显示「X 分钟」（走 i18n，分钟数取自任务数据）',
  )
  // 层级：与「写范围」段同构——小标签（eyebrow）+ 值 + 小字说明，三者都在同一信息层。
  assert.match(body, /<div class="eyebrow"[^>]*>\$\{t\('taskForm\.timeBudgetLabel'\)\}<\/div>/, '时效行带小标签（与写范围段同构）')
  assert.match(body, /<div class="hint"[^>]*>\$\{t\('task\.timeBudgetNote'\)\}<\/div>/, '时效行下挂小字说明')
  // 行位置：与「写范围」同一信息层（在评论区之前）。
  assert.ok(body.indexOf('task.timeBudgetMinutes ?') < body.indexOf('>评论<'), '时效行应与写范围同层，位于评论区之前')
  assert.match(zh, /'task\.timeBudgetValue': '\$\{minutes\} 分钟'/, '中文时效值文案带分钟数插值')
  assert.match(zh, /'task\.timeBudgetNote': '软性时限，超时硬中止仍由运行超时控制'/, '中文小字说明口径与卡面一致')
})

test('i18n：zh/en 各含时效相关 key，且中英 key 集合一致', () => {
  const keys = ['taskForm.timeBudgetLabel', 'taskForm.timeBudgetPlaceholder', 'task.timeBudgetValue', 'task.timeBudgetNote']
  const zhKeys = new Set([...zh.matchAll(/'([^']+)':/g)].map(m => m[1]))
  const enKeys = new Set([...en.matchAll(/'([^']+)':/g)].map(m => m[1]))
  for (const key of keys) {
    assert.ok(zhKeys.has(key), `zh 缺 key：${key}`)
    assert.ok(enKeys.has(key), `en 缺 key：${key}`)
  }
  assert.deepEqual([...zhKeys].sort(), [...enKeys].sort(), 'zh/en key 集合必须一致')
})
