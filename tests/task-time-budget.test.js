// DSHBOTS-125：任务发布支持「时效要求」（time_budget_minutes）。
// 覆盖：createTask 落库与 taskView 快照（双命名/缺省/钳制）、owner 派单透传、
// 任务提示词注入与不注入两分支（软约束文案 + runTimeoutMs 分工）、迁移幂等（含老库升级）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { runMigrations } from '../src/db-migrations.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-time-budget-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service, config }
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

test('createTask 落库与 taskView 快照：双命名收参、缺省 NULL、越界钳制、0/负数视为未提', async () => {
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
    assert.equal(rowOf(ctx.store, none.id).time_budget_minutes, null, '未传应为 NULL')
    assert.equal(ctx.service.taskView(rowOf(ctx.store, none.id)).timeBudgetMinutes, null, 'taskView 对 NULL 透出 null')

    const clamped = await ctx.service.createTask({ projectId: project.id, title: '越界', time_budget_minutes: 99_999 }, actor)
    assert.equal(rowOf(ctx.store, clamped.id).time_budget_minutes, 10_080, '超上限钳到一周（10080）')

    const zero = await ctx.service.createTask({ projectId: project.id, title: '零值', time_budget_minutes: 0 }, actor)
    assert.equal(rowOf(ctx.store, zero.id).time_budget_minutes, null, '0 不得钳成 1 分钟：视为未提')
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

test('提示词注入两分支：有时效注入软约束段并写明 runTimeoutMs 分工，无时效零注入', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const runtime = new DshRuntime({ ctx: null, config: ctx.config, store: ctx.store, logger: { info() {}, warn() {}, error() {} } })
    const botRow = ctx.store.get('SELECT * FROM bots WHERE id = ?', dev.id)
    const projectRow = ctx.store.get('SELECT * FROM projects WHERE id = ?', project.id)
    const actor = ctx.service.actor()
    const budgeted = await ctx.service.createTask({ projectId: project.id, title: '限时任务', time_budget_minutes: 30 }, actor)
    const plain = await ctx.service.createTask({ projectId: project.id, title: '普通任务' }, actor)

    const withBudget = runtime.promptFor({
      run: { kind: 'task' }, bot: botRow, project: projectRow, task: rowOf(ctx.store, budgeted.id),
    })
    assert.match(withBudget, /# Time budget/, '应有时效段标题')
    assert.match(withBudget, /within 30 minutes/, '时限值应注入')
    assert.match(withBudget, /soft expectation[\s\S]*runTimeoutMs/, '应写明软约束与 runTimeoutMs 硬中止的分工')

    const withoutBudget = runtime.promptFor({
      run: { kind: 'task' }, bot: botRow, project: projectRow, task: rowOf(ctx.store, plain.id),
    })
    assert.ok(!withoutBudget.includes('# Time budget'), '未传时效不得注入时效段')
    assert.ok(!withoutBudget.includes('minutes; plan the depth'), '交付规划句同样不得出现')
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
