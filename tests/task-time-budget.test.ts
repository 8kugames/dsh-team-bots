// DSHBOTS-125：任务发布支持「时效要求」（time_budget_minutes）。
// 覆盖：createTask 落库与 taskView 快照（双命名/缺省/钳制）、owner 派单透传、
// 任务提示词注入与不注入两分支（硬口径文案 + runTimeoutMs 取更短者）、迁移幂等（含老库升级）。
// DSHBOTS-131：运行时效上限 min(全局 runTimeoutMs, budget) 的纯计算、startRun 启动期定格、
// 到期即超时中止（run 置 failed/RUN_TIMEOUT + run_events 留痕）、budget 大于全局时按全局中止、
// 派生运行（review/handle/memory_review）提示词同步同一时效口径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { runMigrations } from '../src/db-migrations.js'
import { resolveConfig, effectiveRunLimits, effectiveTaskTimeBudgetMinutes } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { runTimeoutMsForTaskRun } from '../src/services/runtime/session.js'
import { installTeamTools } from '../src/tools.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup({ runTimeoutMs }: { runTimeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-time-budget-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000,
    ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }),
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service, config }
}

// 真实 startRun 的最小宿主替身：复用分支只需 resolveAgent/selectModel/prompt/cancel；
// 无 kind='bot' 绑定时 ensureBotBinding 会走 create 新建控制面会话（DSHBOTS-289）。
const stubHost = () => ({
  sessionController: {
    resolveAgent: async () => ({}),
    selectModel: async () => ({}),
    create: async () => ({ sessionId: 'sess-budget-stub' }),
    prompt: async () => ({}),
    cancel: async () => {},
  },
})

const insertTaskRun = (store, { runId, projectId, botId, taskId, sessionId }) => {
  const at = new Date().toISOString()
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
     VALUES (?, ?, ?, ?, 'task', 'write', 'test', 'running', 1, ?, ?)`,
    runId, projectId, botId, taskId, `${runId}-1`, at,
  )
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, 'task', ?, ?)`,
    sessionId, botId, projectId, taskId, at,
  )
}

// 轮询到条件成立：中止链是 async（timer 回调 void timeoutRun），测试侧不能同步断言。
async function until(predicate, { limit = 200 } = {}) {
  for (let i = 0; i < limit; i += 1) {
    if (predicate()) return true
    await new Promise(resolve => setImmediate(resolve))
  }
  return predicate()
}

async function primeProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Budget', key: 'BUD', ownerBotId: director.id, memberIds: [dev.id] })
  return { director, dev, project }
}

function ownerSession(store, director, project) {
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    'sess-owner', director.id, project.id, 'project', new Date().toISOString(),
  )
  return 'sess-owner'
}

const cleanup = async ({ root, store }) => {
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const rowOf = (store, id) => store.get('SELECT * FROM tasks WHERE id = ?', id)

test('createTask 落库与 taskView 快照：双命名收参、缺省补 20、越界钳制、0/负数视为未提', async () => {
  const ctx = await setup()
  try {
    const { project } = await primeProject(ctx.service, ctx.store)
    const actor = ctx.service.actor()

    const snakeCase = await ctx.service.createTask({ projectId: project.id, title: '蛇形', time_budget_minutes: 45 }, actor)
    assert.equal(rowOf(ctx.store, snakeCase.id).time_budget_minutes, 45, 'snake_case 入参应落库')
    assert.equal(ctx.service.taskView(rowOf(ctx.store, snakeCase.id)).timeBudgetMinutes, 45, 'taskView 应透出 timeBudgetMinutes')

    const camelCase = await ctx.service.createTask({ projectId: project.id, title: '驼峰', timeBudgetMinutes: 30 }, actor)
    assert.equal(rowOf(ctx.store, camelCase.id).time_budget_minutes, 30, 'camelCase 入参同口径落库')

    const none = await ctx.service.createTask({ projectId: project.id, title: '无时效' }, actor)
    assert.equal(rowOf(ctx.store, none.id).time_budget_minutes, 20, '未传应补缺省（看门狗未配置 → 仓内缺省 20）')
    assert.equal(ctx.service.taskView(rowOf(ctx.store, none.id)).timeBudgetMinutes, 20, 'taskView 透出补挂后的缺省值')

    const clamped = await ctx.service.createTask({ projectId: project.id, title: '越界', time_budget_minutes: 99_999 }, actor)
    assert.equal(rowOf(ctx.store, clamped.id).time_budget_minutes, 10_080, '超上限钳到一周（10080）')

    const zero = await ctx.service.createTask({ projectId: project.id, title: '零值', time_budget_minutes: 0 }, actor)
    assert.equal(rowOf(ctx.store, zero.id).time_budget_minutes, 20, '0 不得钳成 1 分钟：视为未提补缺省')
  } finally {
    await cleanup(ctx)
  }
})

test('assignFromBot 透传：owner 派单带 time_budget_minutes 落到新任务', async () => {
  const ctx = await setup()
  try {
    const { director, project } = await primeProject(ctx.service, ctx.store)
    const sessionId = ownerSession(ctx.store, director, project)
    const assigned = await ctx.service.assignFromBot(sessionId, {
      assignee: 'Builder', title: '限时派单', description: '写范围：src/x.js',
      time_budget_minutes: 25,
    })
    assert.equal(rowOf(ctx.store, assigned.id).time_budget_minutes, 25, 'owner 派单路径应落库时效要求')
    assert.equal(ctx.service.taskView(rowOf(ctx.store, assigned.id)).timeBudgetMinutes, 25)
  } finally {
    await cleanup(ctx)
  }
})

test('提示词注入两分支：有时效注入硬口径段并写明与 runTimeoutMs 取更短者，无时效零注入', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const runtime = new DshRuntime({ ctx: null, config: ctx.config, store: ctx.store, logger: { info() {}, warn() {}, error() {} } })
    const botRow = ctx.store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    const projectRow = ctx.store.get('SELECT * FROM projects WHERE id = ?', project.id)
    const actor = ctx.service.actor()
    const budgeted = await ctx.service.createTask({ projectId: project.id, title: '限时任务', time_budget_minutes: 30 }, actor)
    const plain = await ctx.service.createTask({ projectId: project.id, title: '普通任务' }, actor)
    // DSHBOTS-198：建档即补缺省预算，NULL 分支只剩存量老卡——直改库置 NULL 模拟。
    ctx.store.run('UPDATE tasks SET time_budget_minutes = NULL WHERE id = ?', plain.id)

    const withBudget = runtime.promptFor({
      run: { kind: 'task' }, bot: botRow, project: projectRow, task: rowOf(ctx.store, budgeted.id),
    })
    assert.match(withBudget, /# Time budget/, '应有时效段标题')
    assert.match(withBudget, /within 30 minutes/, '时限值应注入')
    assert.match(withBudget, /aborted when the budget expires/, '必须写明到期即中止（硬口径）')
    assert.match(withBudget, /smaller of this budget and the global run timeout/, '应写明与全局 runTimeoutMs 取更短者')
    assert.ok(!withBudget.includes('soft expectation'), '软口径文案不得残留')

    const withoutBudget = runtime.promptFor({
      run: { kind: 'task' }, bot: botRow, project: projectRow, task: rowOf(ctx.store, plain.id),
    })
    assert.ok(!withoutBudget.includes('# Time budget'), '未传时效不得注入时效段')
    assert.ok(!withoutBudget.includes('minutes; plan the depth'), '交付规划句同样不得出现')
  } finally {
    await cleanup(ctx)
  }
})

test('派生运行提示词同步时效：review/handle/memory_review 与任务卡同口径，无时效零注入', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const runtime = new DshRuntime({ ctx: null, config: ctx.config, store: ctx.store, logger: { info() {}, warn() {}, error() {} } })
    const botRow = ctx.store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    const projectRow = ctx.store.get('SELECT * FROM projects WHERE id = ?', project.id)
    const actor = ctx.service.actor()
    const budgeted = await ctx.service.createTask({ projectId: project.id, title: '限时交付', time_budget_minutes: 30 }, actor)
    const plain = await ctx.service.createTask({ projectId: project.id, title: '普通交付' }, actor)
    // 同上：NULL 分支按存量老卡口径直改库。
    ctx.store.run('UPDATE tasks SET time_budget_minutes = NULL WHERE id = ?', plain.id)
    const at = new Date().toISOString()
    // 派生运行一律置 succeeded：one_active_run_per_task 唯一索引只挡 queued/running，
    // 同一任务下插多条派生运行做提示词断言时必须避开它。
    const insertRun = (id, { kind, taskId, triggerType = 'test', triggerRef = null, status = 'succeeded' }) => {
      ctx.store.run(
        `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, queued_at)
         VALUES (?, ?, ?, ?, ?, 'read', ?, ?, ?, 1, ?, ?)`,
        id, project.id, dev.id, taskId, kind, triggerType, triggerRef, status, `${id}-1`, at,
      )
      return ctx.store.get('SELECT * FROM runs WHERE id = ?', id)
    }
    const promptOf = (run, task) => runtime.promptFor({ run, bot: botRow, project: projectRow, task })

    ctx.store.run("UPDATE tasks SET status = 'in_review' WHERE id IN (?, ?)", budgeted.id, plain.id)
    const delegate = insertRun('run-delegate', { kind: 'review', taskId: budgeted.id, triggerType: 'review_delegate' })
    const review = insertRun('run-review', { kind: 'review', taskId: budgeted.id })
    const handle = insertRun('run-handle', { kind: 'handle', taskId: budgeted.id })
    const finished = insertRun('run-finished', { kind: 'task', taskId: budgeted.id, status: 'succeeded' })
    ctx.store.run('UPDATE runs SET output = ? WHERE id = ?', '交付说明', finished.id)
    const memory = insertRun('run-memory', { kind: 'memory_review', taskId: budgeted.id, triggerRef: finished.id })

    // 这些派生运行与任务卡共用同一时效上限（run.task_id 非空即继承），提示词必须同步告知，
    // 否则代理会在不知情的情况下被超时中止。
    for (const [label, run] of [['委派核验', delegate], ['owner 验收', review], ['受阻处理', handle], ['记忆复核', memory]]) {
      const prompt = promptOf(run, rowOf(ctx.store, budgeted.id))
      assert.match(prompt, /# Time budget/, `${label}运行应注入时效段`)
      assert.match(prompt, /within 30 minutes/, `${label}运行应带时限值`)
      assert.match(prompt, /aborted when the budget expires/, `${label}运行应写明到期即中止`)
    }

    const plainDelegate = insertRun('run-plain-delegate', { kind: 'review', taskId: plain.id, triggerType: 'review_delegate' })
    const plainPrompt = promptOf(plainDelegate, rowOf(ctx.store, plain.id))
    assert.ok(!plainPrompt.includes('# Time budget'), '无时效任务的派生运行不得注入时效段')
  } finally {
    await cleanup(ctx)
  }
})

test('迁移幂等：新库自带列，老库补列可重跑，迁移名单只记一次', async () => {
  const ctx = await setup()
  try {
    const columns = ctx.store.all('PRAGMA table_info(tasks)').map(col => col.name)
    assert.ok(columns.includes('time_budget_minutes'), '新库建表自带 time_budget_minutes')
    assert.equal(
      ctx.store.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?', 'tasks_time_budget_minutes')?.n, 1,
      '迁移名应登记且只一次',
    )

    // 模拟老库：抹掉列与迁移记录，重跑 runMigrations 应补齐且不报错。
    // runMigrations 收的是原始 DatabaseSync 句柄（openDatabase 内同款），Store 挂在 .db 上。
    ctx.store.run('ALTER TABLE tasks DROP COLUMN time_budget_minutes')
    ctx.store.run("DELETE FROM schema_migrations WHERE name = 'tasks_time_budget_minutes'")
    assert.ok(!ctx.store.all('PRAGMA table_info(tasks)').map(col => col.name).includes('time_budget_minutes'))

    runMigrations(ctx.store.db)
    assert.ok(ctx.store.all('PRAGMA table_info(tasks)').map(col => col.name).includes('time_budget_minutes'), '老库升级应补列')
    assert.equal(
      ctx.store.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?', 'tasks_time_budget_minutes')?.n, 1,
      '补列后迁移名登记恰好一次',
    )

    // 幂等：再跑一遍全链无异常、无重复记录。
    runMigrations(ctx.store.db)
    assert.equal(
      ctx.store.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?', 'tasks_time_budget_minutes')?.n, 1,
      '重跑不产生重复迁移记录',
    )
  } finally {
    await cleanup(ctx)
  }
})

test('team_assign_task 工具 schema 暴露 time_budget_minutes（owner 派单入口契约）', () => {
  const tools = []
  installTeamTools({ tools: { register: (tool) => tools.push(tool) } }, {})
  const tool = tools.find(item => item.name === 'team_assign_task')
  assert.ok(tool, 'team_assign_task 未注册')
  const field = tool.parameters.properties.time_budget_minutes
  // additionalProperties=false：schema 不声明就等于 owner bot 无法传入，必须显式暴露。
  assert.ok(field, 'schema 必须声明 time_budget_minutes，否则 owner 派单路径传不进时效要求')
  assert.equal(field.type, 'integer')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.match(field.description, /aborted when the budget expires/)
  assert.match(field.description, /smaller of this budget and the global run timeout/)
})

test('运行超时上限：任务时效收紧为 min(全局, budget)，无时效与非任务运行沿用全局', () => {
  const globalMs = 60 * 60_000
  const run = (id, taskId) => ({ id, task_id: taskId })
  assert.equal(
    runTimeoutMsForTaskRun({ run: run('r1', 't1'), task: { time_budget_minutes: 30 }, globalRunTimeoutMs: globalMs }),
    30 * 60_000, '时效小于全局应取时效',
  )
  assert.equal(
    runTimeoutMsForTaskRun({ run: run('r2', 't2'), task: { time_budget_minutes: 24 * 60 }, globalRunTimeoutMs: globalMs }),
    globalMs, '时效大于全局应取全局',
  )
  assert.equal(
    runTimeoutMsForTaskRun({ run: run('r3', 't3'), task: { time_budget_minutes: null }, globalRunTimeoutMs: globalMs }),
    globalMs, '无时效应沿用全局',
  )
  assert.equal(
    runTimeoutMsForTaskRun({ run: run('r4', null), task: { time_budget_minutes: 5 }, globalRunTimeoutMs: globalMs }),
    globalMs, '非任务运行（task_id 为空）不得继承任务时效',
  )
  assert.equal(
    runTimeoutMsForTaskRun({ run: run('r5', 't5'), task: { timeBudgetMinutes: 15 }, globalRunTimeoutMs: globalMs }),
    15 * 60_000, 'camelCase 时效同口径',
  )
  assert.equal(
    runTimeoutMsForTaskRun({ run: run('r6', 't6'), task: { time_budget_minutes: 0 }, globalRunTimeoutMs: globalMs }),
    globalMs, '0/非法值视为未提，沿用全局',
  )
})

test('startRun 启动期定格：带时效任务上限 = min(全局, budget)，无时效沿用全局', async () => {
  const ctx = await setup()
  const timers = []
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const actor = ctx.service.actor()
    const budgeted = await ctx.service.createTask({ projectId: project.id, title: '限时任务', time_budget_minutes: 30 }, actor)
    const plain = await ctx.service.createTask({ projectId: project.id, title: '普通任务' }, actor)
    // DSHBOTS-198：建档即补缺省预算；「无时效沿用全局」分支只剩存量老卡，直改库置 NULL 模拟。
    ctx.store.run('UPDATE tasks SET time_budget_minutes = NULL WHERE id = ?', plain.id)
    const botRow = ctx.store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    const projectRow = ctx.store.get('SELECT * FROM projects WHERE id = ?', project.id)
    const runtime = new DshRuntime({ ctx: stubHost(), config: ctx.config, store: ctx.store, logger: { info() {}, warn() {}, error() {} } })
    const globalMs = effectiveRunLimits(ctx.config, key => ctx.store.setting(key)).runTimeoutMs

    for (const [task, expected] of [[budgeted, 30 * 60_000], [plain, globalMs]]) {
      const run = { id: `run-${task.id}`, kind: 'task', mode: 'write', task_id: task.id }
      insertTaskRun(ctx.store, { runId: run.id, projectId: project.id, botId: dev.id, taskId: task.id, sessionId: `sess-${task.id}` })
      await runtime.startRun({ run, bot: botRow, project: projectRow, task: rowOf(ctx.store, task.id), sessionKind: 'task' })
      assert.equal(
        (runtime.pendingByRun.get(run.id) as { runTimeoutMs: number }).runTimeoutMs, expected,
        `${task.title}：运行超时上限应为 min(全局, budget)`,
      )
      timers.push((runtime.pendingByRun.get(run.id) as { timer: ReturnType<typeof setTimeout> }).timer)
      // one_active_run_per_bot（DSHBOTS-289）：同 bot 至多一条 queued/running——本轮定格
      // 断言完即置终态释放名额，下一轮才能再种 running 运行。
      ctx.store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?", new Date().toISOString(), run.id)
    }
  } finally {
    for (const timer of timers) clearTimeout(timer)
    await cleanup(ctx)
  }
})

test('时效到期即中止：到点杀运行，run 置 failed/RUN_TIMEOUT 且 run_events 留痕', async () => {
  const { mock } = await import('node:test')
  const ctx = await setup()
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const actor = ctx.service.actor()
    const task = await ctx.service.createTask({ projectId: project.id, title: '到期任务', time_budget_minutes: 30 }, actor)
    const botRow = ctx.store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    const projectRow = ctx.store.get('SELECT * FROM projects WHERE id = ?', project.id)
    const runtime = new DshRuntime({ ctx: stubHost(), config: ctx.config, store: ctx.store, logger: { info() {}, warn() {}, error() {} } })
    ctx.service.attachRuntime(runtime)
    const run = { id: 'run-expire', kind: 'task', mode: 'write', task_id: task.id }
    insertTaskRun(ctx.store, { runId: run.id, projectId: project.id, botId: dev.id, taskId: task.id, sessionId: 'sess-expire' })

    await runtime.startRun({ run, bot: botRow, project: projectRow, task: rowOf(ctx.store, task.id), sessionKind: 'task' })
    assert.equal((runtime.pendingByRun.get(run.id) as { runTimeoutMs: number }).runTimeoutMs, 30 * 60_000, '带时效任务的运行上限应为时效值')

    // 中止链会经 finishRun 给 owner 派生后续运行（outbox → tick → executeRun）；本例只验时效中止，
    // 关掉调度闸门避免派生运行在断言后继续活动。
    ctx.service.started = false
    mock.timers.tick(30 * 60_000)
    assert.ok(
      await until(() => ctx.store.get('SELECT status FROM runs WHERE id = ?', run.id)?.status === 'failed'),
      '到期后运行应转失败',
    )

    const runRow = ctx.store.get('SELECT * FROM runs WHERE id = ?', run.id)
    assert.equal(runRow.status, 'failed', '到期后运行应置失败')
    assert.equal(runRow.error_code, 'RUN_TIMEOUT', '失败码应为 RUN_TIMEOUT')
    assert.match(runRow.error_message, /30 分钟/, '中止文案应带上时效分钟数')
    assert.equal(runtime.pendingByRun.has(run.id), false, 'pending 应已清理')
    const events = ctx.store.all('SELECT * FROM run_events WHERE run_id = ? ORDER BY rowid', run.id)
    assert.ok(events.some(item => item.type === 'started'), '应有 started 事件')
    assert.ok(
      events.some(item => item.type === 'failed' && item.message === runRow.error_message),
      '应有 failed 事件留痕，且文案与 run 一致',
    )
  } finally {
    mock.timers.reset()
    await cleanup(ctx)
  }
})

test('budget 大于全局时按全局中止：effective timeout 取更短者', async () => {
  const { mock } = await import('node:test')
  const globalMs = 2 * 60_000
  const ctx = await setup({ runTimeoutMs: globalMs })
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const actor = ctx.service.actor()
    const task = await ctx.service.createTask({ projectId: project.id, title: '超宽时效', time_budget_minutes: 10_080 }, actor)
    const botRow = ctx.store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    const projectRow = ctx.store.get('SELECT * FROM projects WHERE id = ?', project.id)
    const runtime = new DshRuntime({ ctx: stubHost(), config: ctx.config, store: ctx.store, logger: { info() {}, warn() {}, error() {} } })
    ctx.service.attachRuntime(runtime)
    const run = { id: 'run-global-cap', kind: 'task', mode: 'write', task_id: task.id }
    insertTaskRun(ctx.store, { runId: run.id, projectId: project.id, botId: dev.id, taskId: task.id, sessionId: 'sess-global-cap' })

    await runtime.startRun({ run, bot: botRow, project: projectRow, task: rowOf(ctx.store, task.id), sessionKind: 'task' })
    assert.equal((runtime.pendingByRun.get(run.id) as { runTimeoutMs: number }).runTimeoutMs, globalMs, '时效远大于全局时应取全局')

    // 同上：关掉调度闸门，避免中止后的 owner 派生运行在断言后继续活动。
    ctx.service.started = false
    mock.timers.tick(globalMs)
    assert.ok(
      await until(() => ctx.store.get('SELECT status FROM runs WHERE id = ?', run.id)?.status === 'failed'),
      '全局上限到点应中止运行',
    )
    assert.equal(ctx.store.get('SELECT error_code FROM runs WHERE id = ?', run.id).error_code, 'RUN_TIMEOUT')
    assert.match(ctx.store.get('SELECT error_message FROM runs WHERE id = ?', run.id).error_message, /2 分钟/)
  } finally {
    mock.timers.reset()
    await cleanup(ctx)
  }
})

// DSHBOTS-198：任务卡默认带时间预算（用户 2026-11-04 拍板 A：跟随看门狗）。
// 缺省链 = 显式 time_budget_minutes > env DSH_TEAM_TASK_TIME_BUDGET_MINUTES >
// 无进展看门狗（分钟）生效值 > 兜底 20（看门狗未配置与配 0 关闭同值；预算不得变 0/无限）。
test('缺省预算链：未传补 20、env 覆盖、看门狗配置覆盖、看门狗 0 兜底 20、显式不覆盖', async () => {
  const prevEnv = process.env.DSH_TEAM_TASK_TIME_BUDGET_MINUTES
  const ctx = await setup()
  try {
    const { project } = await primeProject(ctx.service, ctx.store)
    const actor = ctx.service.actor()
    const create = (title, extra = {}) => ctx.service.createTask({ projectId: project.id, title, ...extra }, actor)

    assert.equal(rowOf(ctx.store, (await create('未传')).id).time_budget_minutes, 20, '未传应补看门狗缺省生效值 20')

    // env 口径与 effectiveRunLimits 同款（review-watchdog 先例）：env 显式时生效值取
    // config——resolveConfig 启动快照已吃进 env 值，运行中后设的 env 不追溯生效的卡。
    process.env.DSH_TEAM_TASK_TIME_BUDGET_MINUTES = '45'
    ctx.store.setSetting('stall_watchdog_minutes', '75')
    const envSnapshot = resolveConfig({
      workspace: join(ctx.root, 'workspace'), dataDir: join(ctx.root, 'data'),
      skillRoot: join(ctx.root, 'workspace', '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000,
    })
    assert.equal(effectiveTaskTimeBudgetMinutes(envSnapshot, () => '75'), 45, 'env 显式应压过看门狗配置')

    delete process.env.DSH_TEAM_TASK_TIME_BUDGET_MINUTES
    assert.equal(rowOf(ctx.store, (await create('看门狗配置')).id).time_budget_minutes, 75, '看门狗生效值应成为缺省预算')

    ctx.store.setSetting('stall_watchdog_minutes', '0')
    assert.equal(rowOf(ctx.store, (await create('看门狗关闭')).id).time_budget_minutes, 20, '看门狗 0（关闭）应回落兜底 20')

    ctx.store.setSetting('stall_watchdog_minutes', '75')
    assert.equal(
      rowOf(ctx.store, (await create('显式优先', { time_budget_minutes: 90 })).id).time_budget_minutes, 90,
      '显式时效不得被缺省链覆盖',
    )
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_TEAM_TASK_TIME_BUDGET_MINUTES
    else process.env.DSH_TEAM_TASK_TIME_BUDGET_MINUTES = prevEnv
    await cleanup(ctx)
  }
})

test('重派补挂与预算行在场：assignTask 给 NULL 存量卡补缺省、显式卡不覆盖，缺省卡提示词带预算行', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const actor = ctx.service.actor()
    const legacy = await ctx.service.createTask({ projectId: project.id, title: '老卡', time_budget_minutes: 30 }, actor)
    ctx.store.run('UPDATE tasks SET time_budget_minutes = NULL WHERE id = ?', legacy.id)
    await ctx.service.assignTask(legacy.id, dev.id, actor, { autoStart: false })
    assert.equal(rowOf(ctx.store, legacy.id).time_budget_minutes, 20, '重派应给 NULL 预算存量卡补缺省')

    const explicit = await ctx.service.createTask({ projectId: project.id, title: '显式卡', time_budget_minutes: 90 }, actor)
    await ctx.service.assignTask(explicit.id, dev.id, actor, { autoStart: false })
    assert.equal(rowOf(ctx.store, explicit.id).time_budget_minutes, 90, '显式预算不得被重派覆盖')

    // 产品规则：每张任务卡 prompt 都携带明确时限——缺省补挂的卡预算行必须在场。
    const runtime = new DshRuntime({ ctx: null, config: ctx.config, store: ctx.store, logger: { info() {}, warn() {}, error() {} } })
    const botRow = ctx.store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    const projectRow = ctx.store.get('SELECT * FROM projects WHERE id = ?', project.id)
    const prompt = runtime.promptFor({ run: { kind: 'task' }, bot: botRow, project: projectRow, task: rowOf(ctx.store, legacy.id) })
    assert.match(prompt, /# Time budget/, '缺省补挂卡应有时效段')
    assert.match(prompt, /within 20 minutes/, '缺省预算值 20 应注入提示词')
    assert.match(prompt, /aborted when the budget expires/, '必须写明到期即中止')
  } finally {
    await cleanup(ctx)
  }
})
