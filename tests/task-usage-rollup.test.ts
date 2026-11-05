// DSHBOTS-212：任务级 usage 聚合——「一个任务端到端花多少 token」的判定口径。
// 覆盖：记账写入路径带 task_id（usage_events.task_id 修复）；taskUsageTotals 双路径归因
// （新明细 u.task_id + 历史明细 task_id NULL 经 run_id JOIN runs 追认）；失败重试运行全计入；
// 缓存读写分列；taskSubtreeIds 子树（含脏环收敛）与 taskTreeUsageTotals（主项+后代、兄弟不含）；
// taskDetail 暴露 usage.own / usage.total / subtaskCount。
// 计价公式（cacheRead/cacheWrite 计价）沿用 costForTokens 既有口径，不在此重测（卡面明确勿重做）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { recordUsage, taskSubtreeIds, taskTreeUsageTotals, taskUsageTotals } from '../src/usage.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-usage-'))
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

async function seedProject(service) {
  const director = service.store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Nest', key: 'NEST', ownerBotId: director.id, memberIds: [dev.id] })
  return { director, dev, project }
}

// 直插一条 run 行（绕开调度器），返回 run 形参供 recordUsage 消费。
function insertRun(store, { id, projectId, botId, taskId, status = 'succeeded' }) {
  const now = new Date().toISOString()
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
       attempt, idempotency_key, queued_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, 'task', 'write', 'task_created', ?, ?, 1, ?, ?, ?, ?)`,
    id, projectId, botId, taskId, taskId ?? null, status, `${id}:key`, now, now, now,
  )
  return { id, project_id: projectId, bot_id: botId, task_id: taskId ?? null }
}

const cleanup = async ({ root, store }) => {
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

test('记账写入路径：run 带 task_id → usage_events.task_id 落值；非任务运行仍 NULL', async () => {
  const ctx = await setup()
  try {
    const { director, dev, project } = await seedProject(ctx.service)
    const task = await ctx.service.createTask({ projectId: project.id, title: '主项', writeScopes: ['src/a.js'] }, { type: 'bot', id: director.id })
    const run = insertRun(ctx.store, { id: 'run_task_1', projectId: project.id, botId: dev.id, taskId: task.id })
    recordUsage(ctx.store, { sourceKey: 'k1', run, provider: 'fake', model: 'model-a', usage: { inputTokens: 100, outputTokens: 50 } })
    assert.equal(ctx.store.get('SELECT task_id FROM usage_events WHERE source_key = ?', 'k1').task_id, task.id)

    const chatRun = insertRun(ctx.store, { id: 'run_chat_1', projectId: project.id, botId: dev.id, taskId: null })
    recordUsage(ctx.store, { sourceKey: 'k2', run: chatRun, provider: 'fake', model: 'model-a', usage: { inputTokens: 10, outputTokens: 5 } })
    assert.equal(ctx.store.get('SELECT task_id FROM usage_events WHERE source_key = ?', 'k2').task_id, null)
  } finally {
    await cleanup(ctx)
  }
})

test('taskUsageTotals 双路径归因：新明细直读 + 历史明细经 run_id JOIN 追认，失败重试全计入，缓存分列', async () => {
  const ctx = await setup()
  try {
    const { director, dev, project } = await seedProject(ctx.service)
    const main = await ctx.service.createTask({ projectId: project.id, title: '主项', writeScopes: ['src/a.js'] }, { type: 'bot', id: director.id })
    const other = await ctx.service.createTask({ projectId: project.id, title: '隔壁卡', writeScopes: ['src/b.js'] }, { type: 'bot', id: director.id })

    // 路径 1（修复后的新明细）：recordUsage 带 task_id。
    const failedRun = insertRun(ctx.store, { id: 'run_fail', projectId: project.id, botId: dev.id, taskId: main.id, status: 'failed' })
    recordUsage(ctx.store, { sourceKey: 'f1', run: failedRun, provider: 'fake', model: 'model-a', usage: { inputTokens: 300, cacheReadTokens: 100, outputTokens: 80 } })
    // 路径 2（历史明细）：task_id 为 NULL，只有 run_id 指向带 task_id 的 runs 行。
    const retryRun = insertRun(ctx.store, { id: 'run_retry', projectId: project.id, botId: dev.id, taskId: main.id })
    ctx.store.run(
      `INSERT INTO usage_events(id, source_key, run_id, project_id, bot_id, task_id, provider, model, purpose, currency,
         input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, occurred_at, created_at)
       VALUES ('use_hist_1', 'h1', ?, ?, ?, NULL, 'fake', 'model-a', 'run', 'CNY', 500, 200, 60, 120, 0, ?, ?)`,
      retryRun.id, project.id, dev.id, new Date().toISOString(), new Date().toISOString(),
    )
    // 隔壁任务的用量不得混入。
    const otherRun = insertRun(ctx.store, { id: 'run_other', projectId: project.id, botId: dev.id, taskId: other.id })
    recordUsage(ctx.store, { sourceKey: 'o1', run: otherRun, provider: 'fake', model: 'model-a', usage: { inputTokens: 999, outputTokens: 999 } })

    const totals = taskUsageTotals(ctx.store, main.id)
    assert.equal(totals.calls, 2, '失败重试与成功运行都计入端到端口径')
    assert.equal(totals.inputTokens, 800, '输入含历史行 500（JOIN 追认）+ 新行 300')
    assert.equal(totals.cacheReadTokens, 300, '缓存读分列：100 + 200')
    assert.equal(totals.cacheWriteTokens, 60)
    assert.equal(totals.outputTokens, 200, '输出 80 + 120')
    assert.equal(totals.totalTokens, 800 + 300 + 60 + 200)
    // 无价目：成本为 null 且口径明示不完整（unpricedCalls 全计），不把缺价当零成本。
    assert.equal(totals.cost, null)
    assert.equal(totals.costComplete, false, '无价目时成本只是部分值，costComplete 应为 false')
    assert.equal(totals.unpricedCalls, 2)
  } finally {
    await cleanup(ctx)
  }
})

test('taskSubtreeIds：parent→child→grandchild 全收、兄弟不含、脏数据成环收敛不死循环', async () => {
  const ctx = await setup()
  try {
    const { director, project } = await seedProject(ctx.service)
    const main = await ctx.service.createTask({ projectId: project.id, title: '主项', writeScopes: ['src/a.js'] }, { type: 'bot', id: director.id })
    const child = await ctx.service.createTask({ projectId: project.id, title: '子卡', writeScopes: ['src/a/one.js'], parentTaskId: main.id }, { type: 'bot', id: director.id })
    await ctx.service.createTask({ projectId: project.id, title: '孙卡', writeScopes: ['src/a/one/deep.js'], parentTaskId: child.id }, { type: 'bot', id: director.id })
    const sibling = await ctx.service.createTask({ projectId: project.id, title: '兄弟卡', writeScopes: ['src/b.js'] }, { type: 'bot', id: director.id })

    const ids = taskSubtreeIds(ctx.store, main.id)
    assert.equal(ids.length, 3, '主项+子+孙')
    assert.ok(!ids.includes(sibling.id), '兄弟卡不入子树')

    // 脏环（直插库造互为父）：UNION 去重保证递归收敛，不死循环。
    ctx.store.run('UPDATE tasks SET parent_task_id = ? WHERE id = ?', main.id, sibling.id)
    ctx.store.run('UPDATE tasks SET parent_task_id = ? WHERE id = ?', sibling.id, main.id)
    const cyclic = taskSubtreeIds(ctx.store, main.id)
    assert.equal(cyclic.length, 4, '脏环下仍收敛：主项+子+孙+兄弟全收且不重复')
  } finally {
    await cleanup(ctx)
  }
})

test('taskTreeUsageTotals：主项+全部后代子卡端到端聚合，兄弟任务不计入', async () => {
  const ctx = await setup()
  try {
    const { director, dev, project } = await seedProject(ctx.service)
    const main = await ctx.service.createTask({ projectId: project.id, title: '主项', writeScopes: ['src/a.js'] }, { type: 'bot', id: director.id })
    const child = await ctx.service.createTask({ projectId: project.id, title: '子卡', writeScopes: ['src/a/one.js'], parentTaskId: main.id }, { type: 'bot', id: director.id })
    const sibling = await ctx.service.createTask({ projectId: project.id, title: '兄弟卡', writeScopes: ['src/b.js'] }, { type: 'bot', id: director.id })

    const mainRun = insertRun(ctx.store, { id: 'run_main', projectId: project.id, botId: dev.id, taskId: main.id })
    recordUsage(ctx.store, { sourceKey: 'm1', run: mainRun, provider: 'fake', model: 'model-a', usage: { inputTokens: 400, outputTokens: 100 } })
    const childRun = insertRun(ctx.store, { id: 'run_child', projectId: project.id, botId: dev.id, taskId: child.id })
    recordUsage(ctx.store, { sourceKey: 'c1', run: childRun, provider: 'fake', model: 'model-a', usage: { inputTokens: 200, cacheWriteTokens: 40, outputTokens: 60 } })
    const sibRun = insertRun(ctx.store, { id: 'run_sib', projectId: project.id, botId: dev.id, taskId: sibling.id })
    recordUsage(ctx.store, { sourceKey: 's1', run: sibRun, provider: 'fake', model: 'model-a', usage: { inputTokens: 777, outputTokens: 777 } })

    const own = taskUsageTotals(ctx.store, main.id)
    const total = taskTreeUsageTotals(ctx.store, main.id)
    assert.equal(own.inputTokens, 400, '本卡口径只含主项自身运行')
    assert.equal(total.inputTokens, 600, '含子树口径 = 主项 400 + 子卡 200，兄弟 777 不计')
    assert.equal(total.cacheWriteTokens, 40)
    assert.equal(total.calls, 2)
    // 拆分划算判定的读法：主项含子树 total vs 同类整卡的 own 对比，输入/缓存分列可直接看拆分引入的重复上下文。
  } finally {
    await cleanup(ctx)
  }
})

test('taskDetail 暴露 usage.own / usage.total / subtaskCount（单卡详情，不进列表热路径）', async () => {
  const ctx = await setup()
  try {
    const { director, dev, project } = await seedProject(ctx.service)
    const main = await ctx.service.createTask({ projectId: project.id, title: '主项', writeScopes: ['src/a.js'] }, { type: 'bot', id: director.id })
    await ctx.service.createTask({ projectId: project.id, title: '子卡', writeScopes: ['src/a/one.js'], parentTaskId: main.id }, { type: 'bot', id: director.id })
    const run = insertRun(ctx.store, { id: 'run_main', projectId: project.id, botId: dev.id, taskId: main.id })
    recordUsage(ctx.store, { sourceKey: 'm1', run, provider: 'fake', model: 'model-a', usage: { inputTokens: 400, outputTokens: 100 } })

    const detail = await ctx.service.taskDetail(main.id)
    assert.equal(detail.usage.subtaskCount, 1)
    assert.equal(detail.usage.own.inputTokens, 400)
    assert.equal(detail.usage.total.inputTokens, 400, '子卡无运行时 total 与 own 一致')
    // 列表口径不放大查询：taskView 不带 usage。
    const view = ctx.service.taskView(ctx.store.get('SELECT * FROM tasks WHERE id = ?', main.id))
    assert.equal(view.usage, undefined, 'taskView 列表热路径不得挂聚合')
  } finally {
    await cleanup(ctx)
  }
})
