import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { nowIso } from '../src/util.js'

// DSHBOTS-110：陈旧 queued 运行守卫。
// 任务已进终态（done/canceled）后，残留的 queued 运行不得再被 tick 领取执行：
// ①tick 前置清理 + 候选过滤；②任务流转终态时主动清理（含只读运行，补上写占用只清 mode='write' 的漏网）；
// ③重复触发不重复留痕。全部走真实 tick()/updateTask() 路径，不直接调私有函数绕过调度。
// 注意：库上有 one_active_run_per_task 部分唯一索引（task_id 非空且 queued/running 唯一），
// 同一任务同时最多一条活跃运行，故写运行与只读运行分用例构造。

class ManualRuntime {
  constructor() {
    this.started = []
    this.pendingRuns = new Map()
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  async startRun({ run }) {
    this.started.push({ runId: run.id, botId: run.bot_id, taskId: run.task_id ?? null, mode: run.mode })
    this.pendingRuns.set(run.id, run)
    return `session-${run.id}`
  }

  async steer() { return true }

  async cancelRun() { return true }

  complete(runId, status = 'succeeded', output = 'done') {
    this.pendingRuns.delete(runId)
    return this.handler({ runId, status, output, error: null })
  }
}

async function manualSetup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-stale-run-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  // 关闭自动调度，由测试显式驱动 tick。
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  return { root, store, service, runtime, director, dev }
}

function runRow(store, runId) {
  return store.get('SELECT * FROM runs WHERE id = ?', runId)
}

function staleEvents(store, runId) {
  return store.all(
    "SELECT * FROM run_events WHERE run_id = ? AND type = 'stale_superseded' ORDER BY created_at",
    runId,
  )
}

function requeue(store, runId) {
  store.run(
    "UPDATE runs SET status = 'queued', error_code = NULL, error_message = NULL, cancel_requested = 0, ended_at = NULL WHERE id = ?",
    runId,
  )
}

// 种子一条只读运行（review 模式）：复现 DSHBOTS-102 漏网的 read 模式排队运行。
function seedReadRun(store, { id, projectId, botId, taskId }) {
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
       attempt, idempotency_key, queued_at)
     VALUES (?, ?, ?, ?, 'review', 'read', 'review_requested', ?, 'queued', 1, ?, ?)`,
    id, projectId, botId, taskId, taskId, `seed:${id}`, nowIso(),
  )
  store.run(
    'INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
    `evt_seed_${id}`, id, 'queued', '任务交付，转总监验收', nowIso(),
  )
}

async function cleanup(root, store) {
  const started = Date.now()
  while (Date.now() - started < 2000) {
    let active = 0
    try {
      active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    } catch {
      break
    }
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try {
    store.close()
  } catch {}
  await rm(root, { recursive: true, force: true })
}

async function createProjectWithTask(service, director, dev, { autoStart = true } = {}) {
  const project = await service.createProject({
    name: 'Stale Run', key: 'STALE', ownerBotId: director.id, memberIds: [dev.id],
  })
  const task = await service.createTask({
    projectId: project.id, title: '陈旧排队运行', assigneeBotId: dev.id, autoStart,
  })
  return { project, task }
}

test('任务 done 后：tick 不领取其 queued 任务运行，且置 canceled（SUPERSEDED + 留痕）', async () => {
  const { root, store, service, runtime, director, dev } = await manualSetup()
  try {
    const { task } = await createProjectWithTask(service, director, dev)
    service.dispatchOutbox()
    const queued = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task' AND status = 'queued'", task.id)
    assert.ok(queued, '前置：任务运行应已排队')

    // 直接把任务置终态（隔离 tick 守卫本身，不经过 updateTask 的终态清理）。
    store.run("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?", nowIso(), task.id)

    service.started = true
    await service.tick()

    const after = runRow(store, queued.id)
    assert.equal(after.status, 'canceled', '终态任务的排队运行不得留在 queued')
    assert.equal(after.error_code, 'SUPERSEDED', '统一使用管理清理标记 SUPERSEDED')
    assert.equal(after.cancel_requested, 1)
    assert.ok(after.ended_at, '终态清理要写结束时间')
    assert.equal(runtime.started.filter(started => started.runId === queued.id).length, 0, '不得被领取起跑')
    assert.equal(staleEvents(store, queued.id).length, 1, '恰好一条 stale_superseded 留痕')
    assert.equal(store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'done', '任务状态不被回退')
  } finally {
    await cleanup(root, store)
  }
})

test('任务 canceled 后：同口径不领取、置 canceled（SUPERSEDED + 留痕）', async () => {
  const { root, store, service, runtime, director, dev } = await manualSetup()
  try {
    const { task } = await createProjectWithTask(service, director, dev)
    service.dispatchOutbox()
    const queued = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task' AND status = 'queued'", task.id)
    assert.ok(queued, '前置：任务运行应已排队')

    store.run("UPDATE tasks SET status = 'canceled', canceled_at = ? WHERE id = ?", nowIso(), task.id)

    service.started = true
    await service.tick()

    const after = runRow(store, queued.id)
    assert.equal(after.status, 'canceled')
    assert.equal(after.error_code, 'SUPERSEDED')
    assert.equal(runtime.started.filter(started => started.runId === queued.id).length, 0)
    assert.equal(staleEvents(store, queued.id).length, 1)
  } finally {
    await cleanup(root, store)
  }
})

test('任务流转终态时清理残留的 queued 写运行（SUPERSEDED + 留痕），重复触发不重复留痕', async () => {
  const { root, store, service, director, dev } = await manualSetup()
  try {
    const { task } = await createProjectWithTask(service, director, dev)
    service.dispatchOutbox()
    assert.ok(store.get("SELECT id FROM runs WHERE task_id = ? AND status = 'queued'", task.id), '前置：任务运行应已排队')

    const actor = service.actor()
    // in_progress → in_review：离开「进行中」时写占用释放会收掉原有写运行（TASK_LEFT_IN_PROGRESS）。
    await service.updateTask(task.id, { status: 'in_progress' }, actor)
    await service.updateTask(task.id, { status: 'in_review' }, actor)
    // in_review 期间又排队了一条写运行（outbox 派发/限流重试等路径），任务进 done 时必须由终态清理收掉。
    const retryRunId = service.enqueueTaskRun(service.taskRow(task.id), 'manual', actor)
    assert.ok(retryRunId, '前置：in_review 期间应能再排队一条写运行')

    await service.updateTask(task.id, { status: 'done' }, actor)

    const after = runRow(store, retryRunId)
    assert.equal(after.status, 'canceled', '终态清理要收掉排队的写运行')
    assert.equal(after.error_code, 'SUPERSEDED', '排队运行用 SUPERSEDED 管理清理标记')
    assert.equal(staleEvents(store, retryRunId).length, 1)
    assert.equal(store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'done')

    // 幂等：同任务重复置终态、直接重复调终态清理，都不新增事件。
    await service.updateTask(task.id, { status: 'done' }, actor)
    await service.cancelSupersededQueuedRuns(task.id)
    assert.equal(staleEvents(store, retryRunId).length, 1, '重复终态清理不重复留痕')

    // 幂等：把写运行放回 queued 模拟调度窗口内漏网后再触发，事件仍只有一条。
    requeue(store, retryRunId)
    service.started = true
    await service.tick()
    await service.tick()
    assert.equal(runRow(store, retryRunId).status, 'canceled', '再次触发仍会被守卫收掉')
    assert.equal(staleEvents(store, retryRunId).length, 1, 'run_id EXISTS 去重生效，不重复写事件')
  } finally {
    await cleanup(root, store)
  }
})

test('任务流转终态时清理残留的 queued 只读运行（补写占用只清 mode=write 的漏网）', async () => {
  const { root, store, service, director, dev } = await manualSetup()
  try {
    // 不开 autoStart：任务名下没有写运行，只留一条只读运行排队。
    const { project, task } = await createProjectWithTask(service, director, dev, { autoStart: false })
    seedReadRun(store, { id: 'run_stale_read', projectId: project.id, botId: director.id, taskId: task.id })

    const actor = service.actor()
    // in_progress → in_review：写占用释放只清 mode='write'，只读运行会漏网；
    // 随后 in_review → done 必须由终态清理把它收掉（DSHBOTS-102 事故场景）。
    await service.updateTask(task.id, { status: 'in_progress' }, actor)
    assert.equal(runRow(store, 'run_stale_read').status, 'queued', '前置：离开「进行中」不该动只读运行')
    await service.updateTask(task.id, { status: 'in_review' }, actor)
    await service.updateTask(task.id, { status: 'done' }, actor)

    const after = runRow(store, 'run_stale_read')
    assert.equal(after.status, 'canceled', '只读运行在任务终态时必须被收掉，否则会被调度器起跑执行')
    assert.equal(after.error_code, 'SUPERSEDED', '只读运行同样用 SUPERSEDED 管理清理标记')
    assert.equal(staleEvents(store, 'run_stale_read').length, 1)
    // 重复触发不重复留痕。
    await service.cancelSupersededQueuedRuns(task.id)
    assert.equal(staleEvents(store, 'run_stale_read').length, 1)
  } finally {
    await cleanup(root, store)
  }
})

test('非任务运行不受守卫影响：queued 只读运行仍照常领取', async () => {
  const { root, store, service, runtime, director, dev } = await manualSetup()
  try {
    const { project, task } = await createProjectWithTask(service, director, dev, { autoStart: false })
    seedReadRun(store, { id: 'run_stale_read_ok', projectId: project.id, botId: director.id, taskId: task.id })

    service.started = true
    await service.tick()

    const after = runRow(store, 'run_stale_read_ok')
    assert.equal(after.status, 'running', '非任务运行不得被终态守卫误杀')
    assert.equal(after.error_code, null)
    assert.equal(staleEvents(store, 'run_stale_read_ok').length, 0, '非任务运行不得写 stale_superseded')
    assert.equal(runtime.started.filter(started => started.runId === 'run_stale_read_ok').length, 1, '只读运行应被正常领取')
  } finally {
    await cleanup(root, store)
  }
})
