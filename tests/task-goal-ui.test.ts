// 任务 Goal（版本化锚点）的 UI 守门：新建弹窗的填写字段、详情弹窗的版本展示与编辑入口。
// 三层断言：接线锚读构建产物（同 tests/task-time-budget-ui.test.ts）；渲染与纯逻辑真跑
// ui/modules/task-goal.js（真实 t() 与转义）；提交与点击链路照 tests/untrack-archived-confirm.test.ts
// 把 events-submit / events-click 的真实监听器剥掉 import 后配桩执行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readUiSource } from './helpers/ui-sources.js'
import zh from '../ui/i18n/zh.js'
import en from '../ui/i18n/en.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readUiSource()
const moduleSource = (name: string) => readFileSync(join(root, 'ui', 'modules', `${name}.js`), 'utf8')
const stripLineComments = (text: string) => text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
const noop = () => {}

/** 取出某个函数体（到列首的函数收尾为止）并剔掉行注释，防止断言写进注释里。 */
function functionBody(signature: string) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `找不到 ${signature}`)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, `找不到 ${signature} 的结尾`)
  return stripLineComments(source.slice(start, end))
}

// 真跑 task-goal.js 所需的最小 DOM：util.js 顶层取 toast-root，state.js 顶层读 location.search。
globalThis.location = { search: '', href: 'http://localhost/', origin: 'http://localhost', pathname: '/' } as unknown as Location
globalThis.document = { getElementById: () => null, addEventListener: noop, documentElement: { dataset: {} } } as unknown as Document
const goal = await import('../ui/modules/task-goal.js')
const { state } = await import('../ui/modules/state.js')
const i18n = await import('../ui/modules/i18n.js')

/** 剥掉 import 后把真实监听器注册进来，自由变量全部走桩；globals.document 只覆盖用到的取值方法。 */
function loadListener(name: string, type: string, stubs: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const stripped = moduleSource(name).split('\n').filter((line) => !line.startsWith('import ')).join('\n')
  const listeners = new Map<string, (event: any) => Promise<void>>()
  const { document: documentOverride = {}, ...restGlobals } = globals
  const provided: Record<string, unknown> = {
    document: {
      addEventListener: (eventType: string, handler: any) => listeners.set(eventType, handler),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      ...documentOverride as Record<string, unknown>,
    },
    window: { addEventListener: noop, confirm: () => true, open: noop, prompt: () => null },
    ...restGlobals,
  }
  new Function(...Object.keys({ ...stubs, ...provided }), stripped)(...Object.values({ ...stubs, ...provided }))
  const handler = listeners.get(type)
  assert.ok(handler, `${name} 应注册 ${type} 监听器`)
  return handler
}

// ---------- 新建任务弹窗 ----------

test('新建任务弹窗：「描述」之后紧跟 Goal 两个字段，label 用 for 关联控件 id，均为选填', () => {
  const body = functionBody('function modalNewTask()')
  const call = "goalFieldsHtml('new-task-goal'"
  assert.ok(body.includes(call), 'modalNewTask 接入 Goal 字段')
  assert.ok(body.indexOf('id="new-task-description"') < body.indexOf(call), 'Goal 字段排在「描述」之后')
  assert.match(body, /goalFieldsHtml\('new-task-goal', \{ hint: t\("选填：[^"]*"\) \}\)/, '字段下挂的小字说明走 t()')

  const html: string = goal.goalFieldsHtml('new-task-goal')
  const pairs: Array<[string, string]> = [['new-task-goal-statement', 'goal_statement'], ['new-task-goal-criteria', 'completion_criteria']]
  for (const [id, name] of pairs) {
    assert.match(html, new RegExp(`<label id="${id}-label" for="${id}">`), `label 的 for 必须指向控件 id ${id}`)
    assert.match(html, new RegExp(`<textarea class="textarea" id="${id}" name="${name}"`), `控件 id 与 name 成对：${id}/${name}`)
    assert.doesNotMatch(html, new RegExp(`id="${id}"[^>]*\\brequired\\b`), '选填字段不得标 required（留空 = 不设 Goal）')
  }
  assert.equal((html.match(/<label /g) ?? []).length, 2, '恰好两个字段')
  assert.match(html, /id="new-task-goal-statement" name="goal_statement" rows="3" maxlength="2000"/, '目标陈述长度上限与后端契约一致')
})

// ---------- create-task 提交链路 ----------

function submitHarness(fields: Record<string, string>) {
  const calls: Array<{ action: string; payload: any }> = []
  const toasts: Array<{ message: string; type: string }> = []
  const lifecycle = { closed: 0, opened: [] as string[] }
  const form: any = { dataset: { form: 'create-task' }, closest: () => form, querySelector: () => ({ checked: false }) }
  const handler = loadListener('events-submit', 'submit', {
    state,
    validateForm: () => true,
    formPayload: () => ({ projectId: 'prj_1', title: '登录页改造', ...fields }),
    normalizeTimeBudgetMinutes: () => null,
    parseGoalFields: goal.parseGoalFields,
    api: async (action: string, payload: any) => { calls.push({ action, payload }); return { id: 't1', identifier: 'DSH-1' } },
    closeModal: () => { lifecycle.closed += 1 },
    loadState: async () => {},
    render: noop,
    openTask: async (taskId: string) => { lifecycle.opened.push(taskId) },
    toast: (message: string, type: string) => toasts.push({ message, type }),
  }, {
    FormData: class { getAll() { return [] } },
  })
  return { submit: () => handler({ target: form, preventDefault: noop }), calls, toasts, lifecycle }
}

test('create-task 提交：字段全空不带 goal；两项都填带 goal 且完成标准按行拆分', async () => {
  const blank = submitHarness({ goal_statement: '   ', completion_criteria: '\n  \n' })
  await blank.submit()
  assert.equal(blank.calls.length, 1, '全空照常创建任务')
  assert.equal(blank.calls[0].action, 'create_task')
  assert.ok(!('goal' in blank.calls[0].payload), '全空时 payload 不带 goal 键')
  assert.equal(blank.lifecycle.closed, 1, '创建成功后关弹窗')

  const filled = submitHarness({ goal_statement: '  登录页支持验证码登录  ', completion_criteria: ' 输入手机号能收到验证码 \r\n\n  验证码错误时给出提示  \n' })
  await filled.submit()
  assert.deepEqual(filled.calls[0].payload.goal, {
    statement: '登录页支持验证码登录',
    criteria: ['输入手机号能收到验证码', '验证码错误时给出提示'],
  }, '陈述去首尾空白；标准按行拆分、去空白、丢空行')
})

test('create-task 提交：只填一项不发请求，toast 报错且弹窗不关', async () => {
  for (const fields of [{ goal_statement: '只有陈述', completion_criteria: '' }, { goal_statement: '', completion_criteria: '只有标准' }]) {
    const harness = submitHarness(fields)
    await harness.submit()
    assert.equal(harness.calls.length, 0, '不应发出 create_task')
    assert.deepEqual(harness.toasts, [{ message: '设置 Goal 需要同时填写目标陈述和至少一条完成标准', type: 'error' }])
    assert.equal(harness.lifecycle.closed, 0, '弹窗保留已填内容')
  }
})

// ---------- parseGoalFields 纯逻辑 ----------

test('parseGoalFields：全空 = 未设置；只填一项 = 不完整；required 时全空同样拦下', () => {
  const parse = goal.parseGoalFields
  assert.deepEqual(parse('', ''), { goal: null, error: '' })
  assert.deepEqual(parse('  ', '\n \n'), { goal: null, error: '' }, '纯空白与空行等同未填')
  assert.equal(parse(undefined, undefined).goal, null, '字段缺失（老表单）等同未填')
  for (const [statement, criteria] of [['只有陈述', ''], ['', '只有标准']]) {
    const result = parse(statement, criteria)
    assert.equal(result.goal, null)
    assert.equal(result.error, '设置 Goal 需要同时填写目标陈述和至少一条完成标准')
  }
  assert.ok(parse('', '', { required: true }).error, '改目标时全空不放行（goal 补丁没有清空语义）')
  assert.deepEqual(parse(' 目标 ', ' A\n\n  B  '), { goal: { statement: '目标', criteria: ['A', 'B'] }, error: '' })
})

// ---------- 详情弹窗渲染 ----------

const TASK = {
  id: 't1',
  status: 'todo',
  goal: { version: 2, statement: '登录页支持验证码登录', criteria: [{ id: 'C1', text: '输入手机号能收到验证码' }, { id: 'C2', text: '验证码错误时给出提示' }], parentGoalVersion: 1 },
}

test('接线：详情弹窗在写范围之后、交付产物之前渲染 Goal 块', () => {
  const body = functionBody('function modalTask(task)')
  assert.ok(body.includes('${taskGoalBlock(task)}'), 'modalTask 接入 Goal 块')
  assert.ok(body.indexOf('data-action="edit-scopes"') < body.indexOf('${taskGoalBlock(task)}'), '排在写范围段之后')
  assert.ok(body.indexOf('${taskGoalBlock(task)}') < body.indexOf('${taskDeliverablesBlock(task)}'), '排在交付产物之前')
})

test('详情弹窗：有 Goal 时渲染版本徽标、目标陈述与 C1/C2 编号列表，并给未结束的卡「编辑」入口', () => {
  state.modal = { type: 'task', detail: { id: 't1', version: 7 } }
  const html: string = goal.taskGoalBlock(TASK)
  assert.match(html, /<div class="eyebrow">Goal<\/div>/, '标题 Goal')
  assert.match(html, /<span class="pill">v2<\/span>/, '版本徽标取 goal.version')
  assert.match(html, /white-space:pre-wrap">登录页支持验证码登录<\/div>/, '目标陈述')
  assert.match(html, /<span class="mono">C1\.<\/span> 输入手机号能收到验证码/, '完成标准带 C1 编号')
  assert.match(html, /<span class="mono">C2\.<\/span> 验证码错误时给出提示/, '完成标准带 C2 编号')
  assert.match(html, /验收时会对照当前版本逐条核对；修改会产生新版本/, '版本说明小字')
  assert.match(html, /data-action="edit-goal" data-task-id="t1"[^>]*><svg[\s\S]*?<\/svg>编辑<\/button>/, '未结束的卡给编辑入口并带任务 id')
  assert.doesNotMatch(html, /data-action="update-goal"/, '查看态不出现保存按钮')
  assert.doesNotMatch(html, /parentGoalVersion/, '父版本号不进展示')
})

test('详情弹窗：HTML 转义；英文界面不出中文', () => {
  state.modal = { type: 'task', detail: { id: 't1', version: 7 } }
  const html: string = goal.taskGoalBlock({ ...TASK, goal: { version: 1, statement: '<b>粗体</b>', criteria: [{ id: 'C1', text: 'a <script>' }] } })
  assert.match(html, /&lt;b&gt;粗体&lt;\/b&gt;/, '陈述转义')
  assert.match(html, /a &lt;script&gt;/, '标准转义')
  try {
    i18n.setLanguage('en')
    assert.match(goal.taskGoalBlock(TASK), /Review checks each criterion against the current version; editing creates a new version/)
    assert.match(goal.taskGoalBlock({ ...TASK, goal: null }), /No Goal set yet/)
  } finally {
    i18n.setLanguage('zh')
  }
})

test('详情弹窗：没有 Goal 时显示未设置文案并提供「设置 Goal」入口；终态卡不给入口', () => {
  state.modal = { type: 'task', detail: { id: 't1', version: 7 } }
  for (const task of [{ ...TASK, goal: null }, { id: 't1', status: 'todo' }]) {
    const html: string = goal.taskGoalBlock(task)
    assert.match(html, /<div class="scope-empty">尚未设置 Goal<\/div>/, '未设置文案（goal 缺失等同 null）')
    assert.match(html, /data-action="edit-goal" data-task-id="t1"[^>]*><svg[\s\S]*?<\/svg>设置 Goal<\/button>/, '设置入口复用 edit-goal 动作')
    assert.doesNotMatch(html, /<span class="pill">v/, '没有 Goal 不渲染版本徽标')
  }
  for (const status of ['done', 'canceled']) {
    assert.doesNotMatch(goal.taskGoalBlock({ ...TASK, status }), /data-action="edit-goal"/, `终态 ${status} 不给编辑入口`)
    assert.doesNotMatch(goal.taskGoalBlock({ ...TASK, status, goal: null }), /data-action="edit-goal"/, `终态 ${status} 不给设置入口`)
  }
})

test('详情弹窗编辑态：两个 textarea 预填当前内容（标准每行一条），带保存/取消且不再出现编辑入口', () => {
  state.modal = { type: 'task', detail: { id: 't1', version: 7 }, editingGoal: true }
  const html: string = goal.taskGoalBlock(TASK)
  assert.match(html, /<label id="task-goal-statement-label" for="task-goal-statement">/, '陈述 label 关联控件')
  assert.match(html, /id="task-goal-statement" name="goal_statement" rows="3" maxlength="2000" placeholder="这个任务要达成的结果">登录页支持验证码登录<\/textarea>/, '陈述预填')
  assert.match(html, /<label id="task-goal-criteria-label" for="task-goal-criteria">/, '标准 label 关联控件')
  assert.match(html, /id="task-goal-criteria" name="completion_criteria" rows="4">输入手机号能收到验证码\n验证码错误时给出提示<\/textarea>/, '标准每行一条预填')
  assert.match(html, /data-action="update-goal" data-task-id="t1"[^>]*><svg[\s\S]*?<\/svg>保存<\/button>/, '保存按钮带任务 id')
  assert.match(html, /data-action="cancel-goal-edit"[^>]*>取消<\/button>/, '取消按钮')
  assert.doesNotMatch(html, /data-action="edit-goal"/, '编辑态不再出现编辑入口')
  assert.match(html, /<span class="pill">v2<\/span>/, '编辑态保留版本徽标')

  // 标志只认本任务的弹窗：别的任务详情上残留的 editingGoal 不生效。
  state.modal = { type: 'task', detail: { id: 't2', version: 1 }, editingGoal: true }
  assert.doesNotMatch(goal.taskGoalBlock(TASK), /data-action="update-goal"/)
  // 没有 Goal 的卡进编辑态：空表单，照常可保存。
  state.modal = { type: 'task', detail: { id: 't1', version: 7 }, editingGoal: true }
  assert.match(goal.taskGoalBlock({ ...TASK, goal: null }), /id="task-goal-statement" name="goal_statement" rows="3" maxlength="2000" placeholder="这个任务要达成的结果"><\/textarea>/)
})

// ---------- 详情弹窗动作（真实 click 监听器） ----------

function clickHarness(inputs: Record<string, string>) {
  const calls: Array<{ action: string; payload: any; opts: any }> = []
  const toasts: Array<{ message: string; type: string }> = []
  let layerRenders = 0
  const handler = loadListener('events-click', 'click', {
    state,
    t: i18n.t,
    toast: (message: string, type: string) => toasts.push({ message, type }),
    api: async (action: string, payload: any, opts: any) => { calls.push({ action, payload, opts }); return {} },
    loadState: async () => {},
    reloadTaskModal: async () => {},
    handleBoardAction: async () => false,
    renderModalLayer: () => { layerRenders += 1 },
    parseGoalFields: goal.parseGoalFields,
  }, {
    document: { getElementById: (id: string) => (id in inputs ? { value: inputs[id] } : null) },
  })
  const click = (action: string, dataset: Record<string, string> = {}) => {
    const target = { dataset: { action, ...dataset } }
    return handler({ target: { closest: (selector: string) => (selector === '[data-action]' ? target : null) }, preventDefault: noop })
  }
  return { click, calls, toasts, layerRenders: () => layerRenders }
}

test('详情弹窗动作：编辑/取消只翻 modal 标志并同步弹窗层；保存走 update_task 的 goal 补丁并带当前版本', async () => {
  state.modal = { type: 'task', detail: { id: 't1', version: 7 } }
  const harness = clickHarness({ 'task-goal-statement': ' 新目标 ', 'task-goal-criteria': '标准 A\n\n 标准 B ' })
  await harness.click('edit-goal', { taskId: 't1' })
  assert.equal(state.modal.editingGoal, true, '进入编辑态')
  assert.equal(harness.layerRenders(), 1, '切态只同步弹窗层，不整页重建')
  await harness.click('cancel-goal-edit')
  assert.equal(state.modal.editingGoal, false, '退出编辑态')
  assert.equal(harness.layerRenders(), 2)
  assert.equal(harness.calls.length, 0, '切态不发请求')

  await harness.click('update-goal', { taskId: 't1' })
  assert.deepEqual(harness.calls, [{
    action: 'update_task',
    payload: { taskId: 't1', patch: { goal: { statement: '新目标', criteria: ['标准 A', '标准 B'] }, version: 7 } },
    opts: { quiet: true },
  }])
  assert.deepEqual(harness.toasts, [{ message: 'Goal 已保存', type: 'success' }])
})

test('详情弹窗动作：改目标时全空或只填一项不发请求，报错后留在编辑态', async () => {
  state.modal = { type: 'task', detail: { id: 't1', version: 7 }, editingGoal: true }
  for (const inputs of [{}, { 'task-goal-statement': '只有陈述' }, { 'task-goal-criteria': '只有标准' }]) {
    const harness = clickHarness(inputs)
    await harness.click('update-goal', { taskId: 't1' })
    assert.equal(harness.calls.length, 0, '不应发出 update_task')
    assert.deepEqual(harness.toasts, [{ message: '设置 Goal 需要同时填写目标陈述和至少一条完成标准', type: 'error' }])
    assert.equal(state.modal.editingGoal, true, '已填内容不丢')
  }
})

// ---------- i18n ----------

test('i18n：Goal 相关 t() 字面量在 zh / en 都已登记且中英不同，两字典键集一致', () => {
  const literals = new Set<string>()
  for (const match of moduleSource('task-goal').matchAll(/\bt\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) literals.add(match[2])
  assert.ok(literals.size >= 8, `task-goal.js 的 t() 字面量数量异常：${literals.size}`)
  const keys = new Set([...literals, '选填：目标陈述和完成标准都填写才设置 Goal；验收时会对照完成标准逐条核对。', 'Goal 已保存', '编辑', '保存', '取消'])
  for (const key of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `zh 缺键 ${key}`)
    assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en 缺键 ${key}`)
    assert.ok(zh[key] && en[key], `字典值为空：${key}`)
  }
  for (const key of literals) assert.notEqual(zh[key], en[key], `${key} 中英文案不应相同`)
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh / en 键集一致')
})
