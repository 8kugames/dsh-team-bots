import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// 调度视图只读数据库，不需要真实 runtime：给一个空的模型目录即可。
class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-stub' }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dispatch-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.' })
  return { root, store, service, director, dev }
}

// 直接落库一条任务：需要精确控制 status/priority/position/updated_at 时比走 API 更省事。
function insertTask(store, { id: taskId, projectId, botId, status = 'todo', priority = 'medium', position = 0, number: num, updatedAt = new Date().toISOString(), title = '任务' }) {
  store.run(
    `INSERT INTO tasks(id, project_id, number, title, description, status, priority, assignee_bot_id,
      creator_type, creator_id, review_target, position, write_scopes, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, 'user', 'owner', 'user', ?, '[]', 1, ?, ?)`,
    taskId, projectId, num, title, status, priority, botId, position, updatedAt, updatedAt,
  )
}

function insertRun(store, { id: runId, projectId, botId, kind = 'task', status = 'queued', queuedAt = new Date().toISOString() }) {
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, idempotency_key, queued_at)
     VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)`,
    runId, projectId, botId, kind, status, `idem-${runId}`, queuedAt,
  )
}

test('调度视图：跨项目任务按在办/待办分组，并带项目 key 与名称', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const alpha = await service.createProject({ name: 'Alpha 项目', key: 'ALPHA', ownerBotId: director.id, memberIds: [dev.id] })
    const beta = await service.createProject({ name: 'Beta 项目', key: 'BETA', ownerBotId: director.id, memberIds: [dev.id] })

    insertTask(store, { id: 'task-a1', projectId: alpha.id, botId: dev.id, status: 'in_progress', number: 1 })
    insertTask(store, { id: 'task-b1', projectId: beta.id, botId: dev.id, status: 'blocked', number: 2 })
    insertTask(store, { id: 'task-b2', projectId: beta.id, botId: dev.id, status: 'in_review', number: 3 })
    insertTask(store, { id: 'task-a2', projectId: alpha.id, botId: dev.id, status: 'todo', number: 4 })
    insertTask(store, { id: 'task-b3', projectId: beta.id, botId: dev.id, status: 'backlog', number: 5 })
    // 别的 bot 的任务不进来
    insertTask(store, { id: 'task-other', projectId: alpha.id, botId: director.id, status: 'in_progress', number: 6 })

    const view = await service.state(alpha.id, dev.id)
    const dispatch = view.dispatch
    assert.ok(dispatch, '单聊视图应带 dispatch 段')
    assert.equal(dispatch.botId, dev.id)

    assert.deepEqual(dispatch.tasks.active.map(task => task.id).sort(), ['task-a1', 'task-b1', 'task-b2'])
    assert.deepEqual(dispatch.tasks.pending.map(task => task.id).sort(), ['task-a2', 'task-b3'])

    // 跨项目混合：每条任务都带自己的项目 key 与名称
    const betaTask = dispatch.tasks.active.find(task => task.id === 'task-b1')
    assert.equal(betaTask.projectKey, 'BETA')
    assert.equal(betaTask.projectName, 'Beta 项目')
    const alphaTask = dispatch.tasks.active.find(task => task.id === 'task-a1')
    assert.equal(alphaTask.projectKey, 'ALPHA')
    assert.equal(alphaTask.projectName, 'Alpha 项目')
    // 复用 taskView 形状
    assert.equal(alphaTask.identifier, 'ALPHA-1')
    assert.ok(Array.isArray(alphaTask.labels))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('调度视图：在办按最近更新排序，待办按优先级权重再按 position/number', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'Sort 项目', key: 'SORT', ownerBotId: director.id, memberIds: [dev.id] })

    // 在办：updated_at 越新越靠前
    insertTask(store, { id: 'wip-old', projectId: project.id, botId: dev.id, status: 'in_progress', number: 1, updatedAt: '2026-01-01T00:00:00.000Z' })
    insertTask(store, { id: 'wip-new', projectId: project.id, botId: dev.id, status: 'blocked', number: 2, updatedAt: '2026-06-01T00:00:00.000Z' })
    insertTask(store, { id: 'wip-mid', projectId: project.id, botId: dev.id, status: 'in_review', number: 3, updatedAt: '2026-03-01T00:00:00.000Z' })

    // 待办：优先级权重 urgent=0 high=1 medium=2 low=3 none=4，同级按 position 再按 number
    insertTask(store, { id: 'todo-low', projectId: project.id, botId: dev.id, status: 'todo', priority: 'low', position: 1, number: 4 })
    insertTask(store, { id: 'todo-urgent', projectId: project.id, botId: dev.id, status: 'todo', priority: 'urgent', position: 9, number: 5 })
    insertTask(store, { id: 'todo-high-a', projectId: project.id, botId: dev.id, status: 'todo', priority: 'high', position: 2, number: 6 })
    insertTask(store, { id: 'todo-high-b', projectId: project.id, botId: dev.id, status: 'backlog', priority: 'high', position: 1, number: 7 })
    insertTask(store, { id: 'todo-none', projectId: project.id, botId: dev.id, status: 'backlog', priority: 'none', position: 0, number: 8 })
    insertTask(store, { id: 'todo-medium', projectId: project.id, botId: dev.id, status: 'todo', priority: 'medium', position: 0, number: 9 })

    const view = await service.state(project.id, dev.id)
    assert.deepEqual(view.dispatch.tasks.active.map(task => task.id), ['wip-new', 'wip-mid', 'wip-old'])
    assert.deepEqual(view.dispatch.tasks.pending.map(task => task.id), [
      'todo-urgent', 'todo-high-b', 'todo-high-a', 'todo-medium', 'todo-low', 'todo-none',
    ])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('调度视图：只统计 active 项目，归档项目的任务不出现', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const active = await service.createProject({ name: 'Active 项目', key: 'ACTV', ownerBotId: director.id, memberIds: [dev.id] })
    const archived = await service.createProject({ name: 'Archived 项目', key: 'ARCH', ownerBotId: director.id, memberIds: [dev.id] })
    insertTask(store, { id: 'task-active', projectId: active.id, botId: dev.id, status: 'in_progress', number: 1 })
    insertTask(store, { id: 'task-archived', projectId: archived.id, botId: dev.id, status: 'in_progress', number: 2 })
    insertTask(store, { id: 'task-archived-pending', projectId: archived.id, botId: dev.id, status: 'todo', number: 3 })

    service.archiveProject(archived.id, { type: 'user', id: 'owner' })

    const view = await service.state(active.id, dev.id)
    assert.deepEqual(view.dispatch.tasks.active.map(task => task.id), ['task-active'])
    assert.deepEqual(view.dispatch.tasks.pending.map(task => task.id), [])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('调度视图：在办与待办各限 50 条', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'Big 项目', key: 'BIG', ownerBotId: director.id, memberIds: [dev.id] })
    for (let i = 1; i <= 60; i += 1) {
      insertTask(store, { id: `wip-${i}`, projectId: project.id, botId: dev.id, status: 'in_progress', number: i, updatedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z` })
      insertTask(store, { id: `todo-${i}`, projectId: project.id, botId: dev.id, status: 'todo', priority: 'medium', position: i, number: 100 + i })
    }

    const view = await service.state(project.id, dev.id)
    assert.equal(view.dispatch.tasks.active.length, 50)
    assert.equal(view.dispatch.tasks.pending.length, 50)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('调度视图：运行只取 queued/running，项目外运行标「单聊」（新语义：同 bot 至多一条活跃）', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const alpha = await service.createProject({ name: 'Alpha 项目', key: 'ALPHA', ownerBotId: director.id, memberIds: [dev.id] })
    // one_active_run_per_bot（DSHBOTS-291）：同 bot 至多一条 queued/running，旧「queued+
    // running+solo 三活同 bot」夹具不再可造——前一条先置终态再播下一条，逐段快照断言。
    const finalize = (runId) =>
      store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?", new Date().toISOString(), runId)

    // 第一段：queued 任务运行进视图；终态与别的 bot 的运行不进来。
    insertRun(store, { id: 'run-queued', projectId: alpha.id, botId: dev.id, status: 'queued', queuedAt: '2026-01-01T00:00:00.000Z' })
    insertRun(store, { id: 'run-done', projectId: alpha.id, botId: dev.id, status: 'succeeded', queuedAt: '2026-04-01T00:00:00.000Z' })
    insertRun(store, { id: 'run-failed', projectId: alpha.id, botId: dev.id, status: 'failed', queuedAt: '2026-05-01T00:00:00.000Z' })
    insertRun(store, { id: 'run-other', projectId: alpha.id, botId: director.id, status: 'running' })
    let view = await service.state(alpha.id, dev.id)
    assert.deepEqual(view.dispatch.runs.map(run => run.id), ['run-queued'], 'queued 运行进视图，终态与他人的不进')
    // 复用 runView 形状
    const queued = view.dispatch.runs.find(run => run.id === 'run-queued')
    assert.equal(queued.botName, 'Builder')
    assert.equal(queued.kind, 'task')
    assert.equal(queued.projectKey, 'ALPHA')

    // 第二段：running 状态照常进视图。
    finalize('run-queued')
    insertRun(store, { id: 'run-running', projectId: alpha.id, botId: dev.id, status: 'running', queuedAt: '2026-02-01T00:00:00.000Z' })
    view = await service.state(alpha.id, dev.id)
    assert.deepEqual(view.dispatch.runs.map(run => run.id), ['run-running'], 'running 运行进视图')

    // 第三段：项目外单聊运行进视图且没有项目 key，标「单聊」。
    finalize('run-running')
    insertRun(store, { id: 'run-solo', projectId: null, botId: dev.id, kind: 'solo_chat', status: 'running', queuedAt: '2026-03-01T00:00:00.000Z' })
    view = await service.state(alpha.id, dev.id)
    assert.deepEqual(view.dispatch.runs.map(run => run.id), ['run-solo'])
    const solo = view.dispatch.runs.find(run => run.id === 'run-solo')
    assert.equal(solo.botName, 'Builder')
    assert.equal(solo.kind, 'solo_chat')
    assert.equal(solo.projectKey, '单聊')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
