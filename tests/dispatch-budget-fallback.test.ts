// DSHBOTS-325：派单 time_budget 程序化兜底（漏传时按 priority 分档落库）。
// 守门五向：a) 漏传 + high → 45 落库；b) 显式 90 → 90 不被覆盖；c) low → 15；
// d) 重派已有预算不重算（存量 NULL 卡补挂按档）；e) 无效 priority 回退 medium 档。
// 另守：直建卡（不经派单）仍走全局缺省链 20（③）；描述「N 分钟档」与兜底档不一致时
// 建卡回执提示一行、一致或显式预算时不提示（④，仅提示不拦截）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig, PRIORITY_BUDGET_MINUTES } from '../src/config.js'
import { TeamService } from '../src/service.js'

// startRun 只记账不回调完成：任务 run 停在 running，不影响本测试只读 tasks 表的断言。
class HoldingRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-held' }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-budget-tier-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

async function seedProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build things.', provider: 'fake', model: 'model-a', effort: 'high',
  })
  const project = await service.createProject({ name: 'Gate', key: 'GATE', ownerBotId: director.id, memberIds: [dev.id] })
  const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  return { sessionId, project }
}

async function closeQuietly(service, store) {
  for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
    try {
      await service.cancelRunInternal(run.id, false)
    } catch {}
  }
  try {
    store.close()
  } catch {}
}

async function withSetup(fn) {
  const ctx = await setup()
  try {
    return await fn(ctx)
  } finally {
    await closeQuietly(ctx.service, ctx.store)
    await rm(ctx.root, { recursive: true, force: true })
  }
}

const budgetOf = (store, taskId) =>
  store.get('SELECT time_budget_minutes AS v, priority FROM tasks WHERE id = ?', taskId)

const taskMessages = (store, taskId) =>
  store.all('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at', taskId)

const dispatch = (ctx, sessionId, input) =>
  ctx.service.assignFromBot(sessionId, { assignee: 'Builder', description: '做点事。', ...input })

test('档表常量钉住分档值（urgent/high 90、medium 60、low/none 30）', () => {
  assert.deepEqual(PRIORITY_BUDGET_MINUTES, { urgent: 90, high: 90, medium: 60, low: 30, none: 30 })
})

test('a) 漏传预算 + high → 90 落库（priority 同步落卡）', async () => {
  await withSetup(async ctx => {
    const { sessionId } = await seedProject(ctx.service, ctx.store)
    const task = await dispatch(ctx, sessionId, { title: '高优卡', write_scopes: ['src/a.js'], priority: 'high' })
    const row = budgetOf(ctx.store, task.id)
    assert.equal(row.v, 90, '漏传预算的 high 卡应落 90（回读核验，不信透传）')
    assert.equal(row.priority, 'high')
  })
})

test('b) 显式 90 → 90 落库不被兜底覆盖（priority=low 也不压成 15）', async () => {
  await withSetup(async ctx => {
    const { sessionId } = await seedProject(ctx.service, ctx.store)
    const task = await dispatch(ctx, sessionId, {
      title: '显式预算卡', write_scopes: ['src/b.js'], priority: 'low', time_budget_minutes: 90,
    })
    assert.equal(budgetOf(ctx.store, task.id).v, 90, '显式值永远优先，不被分档兜底覆盖')
  })
})

test('c) 漏传预算 + low → 30 落库；不传 priority 同 medium 档 60', async () => {
  await withSetup(async ctx => {
    const { sessionId } = await seedProject(ctx.service, ctx.store)
    const low = await dispatch(ctx, sessionId, { title: '低优卡', write_scopes: ['src/c.js'], priority: 'low' })
    assert.equal(budgetOf(ctx.store, low.id).v, 30, 'low 卡应落 30')
    const plain = await dispatch(ctx, sessionId, { title: '缺省优卡', write_scopes: ['src/d.js'] })
    assert.equal(budgetOf(ctx.store, plain.id).v, 60, '不传 priority（createTask 回退 medium）应落 60')
    assert.equal(budgetOf(ctx.store, plain.id).priority, 'medium')
  })
})

test('d) 重派已有预算不重算（90 保留）；存量 NULL 预算卡重派按生效 priority 档补挂', async () => {
  await withSetup(async ctx => {
    const { sessionId } = await seedProject(ctx.service, ctx.store)
    const task = await dispatch(ctx, sessionId, {
      title: '原卡', write_scopes: ['src/e.js'], priority: 'high', time_budget_minutes: 90,
    })
    // 重派同时把 priority 改成 low：已有预算 90 必须保留，不按 low 重算成 15。
    await dispatch(ctx, sessionId, { task: 'GATE-1', priority: 'low' })
    assert.equal(budgetOf(ctx.store, task.id).v, 90, '重派不重算已有预算')

    // 存量 NULL 预算卡（D-198 之前的老卡形态）重派：按改后生效 priority=high 补挂 45。
    const legacy = await dispatch(ctx, sessionId, { title: '老卡', write_scopes: ['src/f.js'], priority: 'medium' })
    ctx.store.run('UPDATE tasks SET time_budget_minutes = NULL WHERE id = ?', legacy.id)
    await dispatch(ctx, sessionId, { task: 'GATE-2', priority: 'high' })
    assert.equal(budgetOf(ctx.store, legacy.id).v, 90, 'NULL 预算卡重派按生效 priority 档补挂')
  })
})

test('e) 无效 priority 回退默认档（medium 60），与 createTask 归一同口径', async () => {
  await withSetup(async ctx => {
    const { sessionId } = await seedProject(ctx.service, ctx.store)
    const task = await dispatch(ctx, sessionId, { title: '怪优先级卡', write_scopes: ['src/g.js'], priority: 'bogus' })
    const row = budgetOf(ctx.store, task.id)
    assert.equal(row.priority, 'medium', '无效 priority 与 createTask 同口径归一为 medium')
    assert.equal(row.v, 60, '无效 priority 回退 medium 档 60，不得落 undefined/NULL')
  })
})

test('③ 直建卡（不经派单）仍走全局缺省链：漏传预算落看门狗缺省 20 不落分档', async () => {
  await withSetup(async ctx => {
    const { project } = await seedProject(ctx.service, ctx.store)
    const task = await ctx.service.createTask(
      { projectId: project.id, title: '直建卡', writeScopes: ['src/h.js'], priority: 'high' },
      ctx.service.actor(),
    )
    assert.equal(budgetOf(ctx.store, task.id).v, 20, '直建卡沿用全局缺省链（看门狗缺省 20 分钟），不被派单分档接管')
  })
})

test('④ 描述「N 分钟档」与兜底档不一致：回执提示一行；一致或显式预算时不提示', async () => {
  await withSetup(async ctx => {
    const { sessionId, project } = await seedProject(ctx.service, ctx.store)
    // medium 卡（兜底 60）描述写 45 分钟档 → 提示；不拦截建卡。
    const mismatch = await dispatch(ctx, sessionId, {
      title: '档不符卡', write_scopes: ['src/i.js'], priority: 'medium',
      description: '写范围：src/i.js。45 分钟档。',
    })
    const mismatchBodies = taskMessages(ctx.store, mismatch.id).map(message => message.body)
    assert.ok(
      mismatchBodies.some(body => body.includes('budget=60（priority 兜底，描述写 45 分钟档）')),
      `应有兜底档提示消息，实际消息：${JSON.stringify(mismatchBodies)}`,
    )

    // high 卡（兜底 90）描述写 90 分钟档 → 一致，不提示。
    const consistent = await dispatch(ctx, sessionId, {
      title: '档一致卡', write_scopes: ['src/j.js'], priority: 'high',
      description: '写范围：src/j.js。90 分钟档。',
    })
    const consistentBodies = taskMessages(ctx.store, consistent.id).map(message => message.body)
    assert.ok(
      consistentBodies.every(body => !body.includes('priority 兜底')),
      '描述档与兜底档一致时不得提示',
    )

    // 显式预算 90 + 描述写 45 分钟档 → 显式值已生效，不提示。
    const explicit = await dispatch(ctx, sessionId, {
      title: '显式档卡', write_scopes: ['src/k.js'], priority: 'medium',
      description: '写范围：src/k.js。45 分钟档。', time_budget_minutes: 90,
    })
    const explicitBodies = taskMessages(ctx.store, explicit.id).map(message => message.body)
    assert.ok(
      explicitBodies.every(body => !body.includes('priority 兜底')),
      '显式预算时不得提示 priority 兜底',
    )
    assert.equal(budgetOf(ctx.store, explicit.id).v, 90)
  })
})
