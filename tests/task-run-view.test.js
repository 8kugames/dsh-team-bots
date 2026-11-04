import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// DSHBOTS-37 后端：taskView 的 latestRun 与 runs 忽略管理清理产生的 SUPERSEDED 运行，
// 避免 done/canceled 任务的最新运行被清理产物顶掉而误显示「已取消/运行中」。
// SUPERSEDED 不来自任何代码路径，是生产库手工收口留下的标记，故测试直插 runs 表模拟。

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-run-view-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

async function primeDoneTask(service) {
  const director = service.store.get("SELECT * FROM bots WHERE name = 'director'")
  const project = await service.createProject({ name: 'Task Run View', key: 'RUNVIEW', ownerBotId: director.id })
  const actor = service.actor()
  const task = await service.createTask({ projectId: project.id, title: '已验收任务' }, actor)
  for (const status of ['todo', 'in_progress', 'in_review', 'done']) {
    await service.updateTask(task.id, { status }, actor)
  }
  return { task, project, botId: director.id }
}

function seedRun(store, { id, projectId, botId, taskId, status, errorCode, queuedAt }) {
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, trigger_type, status, attempt, idempotency_key, error_code, queued_at)
     VALUES (?, ?, ?, ?, 'task', 'task_created', ?, 1, ?, ?, ?)`,
    id, projectId, botId, taskId, status, `test:${id}`, errorCode ?? null, queuedAt,
  )
}

const taskRowOf = (store, id) => store.get('SELECT * FROM tasks WHERE id = ?', id)

test('latestRun 不被 SUPERSEDED 清理运行顶掉：成功 run 之后有清理运行仍取成功那条', async () => {
  const { root, store, service } = await setup()
  try {
    const { task, project, botId } = await primeDoneTask(service)
    seedRun(store, { id: 'run_success', projectId: project.id, botId, taskId: task.id, status: 'succeeded', queuedAt: '2026-11-02T10:00:00.000Z' })
    seedRun(store, { id: 'run_superseded', projectId: project.id, botId, taskId: task.id, status: 'canceled', errorCode: 'SUPERSEDED', queuedAt: '2026-11-02T11:00:00.000Z' })

    const view = service.taskView(taskRowOf(store, task.id))
    assert.equal(view.latestRun?.id, 'run_success', '更晚的 SUPERSEDED 运行不得成为 latestRun')
    assert.equal(view.latestRun?.status, 'succeeded', 'latestRun 应保持真实成功运行')
    assert.deepEqual(view.runs.map(run => run.id), ['run_success'], 'runs 历史同口径排除 SUPERSEDED')

    const detail = await service.taskDetail(task.id)
    assert.deepEqual(detail.runs.map(run => run.id), ['run_success'], 'taskDetail 的运行历史同口径排除 SUPERSEDED')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('只有 SUPERSEDED 运行时 latestRun 为 null、runs 为空', async () => {
  const { root, store, service } = await setup()
  try {
    const { task, project, botId } = await primeDoneTask(service)
    seedRun(store, { id: 'run_only_superseded', projectId: project.id, botId, taskId: task.id, status: 'canceled', errorCode: 'SUPERSEDED', queuedAt: '2026-11-02T12:00:00.000Z' })

    const view = service.taskView(taskRowOf(store, task.id))
    assert.equal(view.latestRun, null, '仅有清理产物时 latestRun 应为 null')
    assert.deepEqual(view.runs, [], 'runs 历史不含清理产物')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('真实失败/取消运行不受影响：非 SUPERSEDED 的 canceled run 仍可见', async () => {
  const { root, store, service } = await setup()
  try {
    const { task, project, botId } = await primeDoneTask(service)
    seedRun(store, { id: 'run_real_cancel', projectId: project.id, botId, taskId: task.id, status: 'canceled', queuedAt: '2026-11-02T13:00:00.000Z' })

    const view = service.taskView(taskRowOf(store, task.id))
    assert.equal(view.latestRun?.id, 'run_real_cancel', '无 error_code 的取消运行是真实历史，仍应展示')
    assert.equal(view.runs.length, 1)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
