// DSHBOTS-73：写范围占用只看「进行中」的任务，任务离开「进行中」即释放占用/锁定。
// 两层行为都锁进套件：
// ① 纯函数层（src/services/scheduler.js 的 write-lock-scope 块）：一条写运行是否占住项目写槽。
// ② 集成层：同项目两条相交写范围的任务，两个都在「进行中」时只放行一条；
//    先跑那条离开「进行中」后，下一拍另一条立刻放行（占用当场解除）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { runHoldsWriteLock } from '../src/services/scheduler.js'

// 手动完成的 runtime：startRun 后运行保持 running，直到测试显式调用 complete。
class ManualRuntime {
  declare started: Array<{ runId: string; botId: string; taskId: string | null; mode: string }>
  declare canceled: string[]
  declare pendingRuns: Map<string, unknown>
  declare handler: (result: { runId: string; status: string; output: string; error: null }) => unknown

  constructor() {
    this.started = []
    this.canceled = []
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

  async cancelRun(runId) {
    this.canceled.push(runId)
    return true
  }

  complete(runId, status = 'succeeded', output = 'done') {
    this.pendingRuns.delete(runId)
    return this.handler({ runId, status, output, error: null })
  }
}

async function setup({ maxConcurrentRuns }: { maxConcurrentRuns?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-write-lock-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  if (maxConcurrentRuns !== undefined) config.maxConcurrentRuns = maxConcurrentRuns
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  store.setSetting('subagent_delivery_gate', '0') // DSHBOTS-311 夹具：本文件用例非闸主题，关闸保持既有交付流
  // 关闭自动调度，由测试显式驱动 tick。
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  // DSHBOTS-290：bot 级串行（one_active_run_per_bot）下同 bot 双任务必串行（第二条直接挂起
  // 不落 runs 行）；写占用闸门与 bot 无关，需同时排队比对的两条任务分属两条 bot 车道。
  const dev2 = await service.createBot({
    name: 'Builder2', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  return { root, store, service, runtime, director, dev, dev2 }
}

const taskRuns = (store, projectId, status) => store.all(
  "SELECT * FROM runs WHERE project_id = ? AND kind = 'task' AND status = ?",
  projectId, status,
)

const runEventTypes = (store, runId) =>
  store.all('SELECT type FROM run_events WHERE run_id = ?', runId).map(row => row.type)

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timeout waiting for condition')
}

// 运行可能仍在异步收尾；关闭数据库前先等队列排空。
async function closeQuietly(store, timeout = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
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
}

async function cleanup(root, store) {
  await closeQuietly(store)
  await rm(root, { recursive: true, force: true })
}

const userActor = service => ({ type: 'user', id: service.localUserId })

test('纯函数：写占用只看任务是否处于「进行中」', () => {
  // ① 任务运行 + 写模式 + 任务进行中 → 占住写槽
  assert.equal(runHoldsWriteLock({ kind: 'task', mode: 'write', taskStatus: 'in_progress' }), true)
  // ② 任务运行 + 写模式 + 任务不在进行中 → 不占槽（离开进行中即释放）
  for (const status of ['backlog', 'todo', 'blocked', 'in_review', 'done', 'canceled', null, undefined]) {
    assert.equal(
      runHoldsWriteLock({ kind: 'task', mode: 'write', taskStatus: status }),
      false,
      `任务状态 ${status} 不该占写槽`,
    )
  }
  // ③ 只读运行（验收/受阻处理/聊天）任何情况下都不占写槽
  assert.equal(runHoldsWriteLock({ kind: 'task', mode: 'read', taskStatus: 'in_progress' }), false)
  assert.equal(runHoldsWriteLock({ kind: 'chat', mode: 'read', taskStatus: null }), false)
  assert.equal(runHoldsWriteLock({ kind: 'review', mode: 'read', taskStatus: 'in_review' }), false)
  // ④ 非任务运行（不绑任务）按运行自身判定，与任务状态无关
  assert.equal(runHoldsWriteLock({ kind: 'chat', mode: 'write', taskStatus: null }), true)
  assert.equal(runHoldsWriteLock({ kind: 'solo_chat', mode: 'write', taskStatus: null }), true)
  // 缺参不炸：既不是写模式，也不算占槽
  assert.equal(runHoldsWriteLock(), false)
})

test('同项目两条相交写范围：两个任务都在进行中时只放行一条', async () => {
  const { root, store, service, director, dev, dev2 } = await setup()
  try {
    const project = await service.createProject({ name: 'Lock', key: 'LCK', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
    const first = await service.createTask({
      projectId: project.id, title: '改单个文件', assigneeBotId: dev.id,
      writeScopes: ['ui/modules/chat.js'], autoStart: true,
    })
    // DSHBOTS-290：第二条走 dev2 车道，与第一条同时排队，写占用闸门行为与 bot 无关。
    const second = await service.createTask({
      projectId: project.id, title: '改整个目录', assigneeBotId: dev2.id,
      writeScopes: ['ui/modules'], autoStart: true,
    })

    service.started = true
    await service.tick()
    assert.equal(taskRuns(store, project.id, 'running').length, 1, '写范围相交只放行一条')
    const gated = taskRuns(store, project.id, 'queued')
    assert.equal(gated.length, 1, '被闸门挡下的留在队列')
    assert.equal(gated[0].bot_id, dev2.id, '被挡下的是另一条 bot 车道上的排队运行')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE bot_id = ? AND status = 'running'", dev2.id).n, 0, '被挡下任务的 bot 没有在跑的运行')

    // 把排队那条也拖到「进行中」：两个任务都在进行中，写槽仍只放行一条。
    await service.transitionTask(second.id, 'in_progress', userActor(service))
    await service.tick()
    assert.equal(store.get('SELECT status FROM tasks WHERE id = ?', first.id).status, 'in_progress')
    assert.equal(store.get('SELECT status FROM tasks WHERE id = ?', second.id).status, 'in_progress')
    assert.equal(taskRuns(store, project.id, 'running').length, 1, '两个任务都在进行中时写槽仍只放行一条')
    assert.equal(taskRuns(store, project.id, 'queued').length, 1)
  } finally {
    await cleanup(root, store)
  }
})

test('写占用随任务离开「进行中」释放：先跑那条取消后，下一拍另一条立刻放行', async () => {
  const { root, store, service, director, dev, dev2 } = await setup()
  try {
    const project = await service.createProject({ name: 'Release', key: 'RLS', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
    const first = await service.createTask({
      projectId: project.id, title: '改单个文件', assigneeBotId: dev.id,
      writeScopes: ['ui/modules/chat.js'], autoStart: true,
    })
    // DSHBOTS-290：第二条走 dev2 车道，占用释放后由它接棒。
    const second = await service.createTask({
      projectId: project.id, title: '改整个目录', assigneeBotId: dev2.id,
      writeScopes: ['ui/modules'], autoStart: true,
    })

    service.started = true
    await service.tick()
    const running = taskRuns(store, project.id, 'running')
    assert.equal(running.length, 1)
    const firstRun = running.find(run => run.task_id === first.id)
    assert.ok(firstRun, '先跑的是第一条任务')

    // 任务离开「进行中」→ 写运行当场中止，写占用/锁定解除。
    await service.transitionTask(first.id, 'canceled', userActor(service))
    const released = store.get('SELECT * FROM runs WHERE id = ?', firstRun.id)
    assert.equal(released.status, 'canceled', '离开进行中的写运行被中止')
    assert.equal(released.error_code, 'TASK_LEFT_IN_PROGRESS', '稳定错误码，便于事后区分')
    assert.ok(released.ended_at)
    assert.equal(released.cancel_requested, 1)
    assert.ok(runEventTypes(store, firstRun.id).includes('task_left_in_progress'), 'run 侧记写占用释放事件')

    await service.tick()
    const nowRunning = taskRuns(store, project.id, 'running')
    assert.equal(nowRunning.length, 1, '释放后下一拍另一条立刻放行')
    assert.equal(nowRunning[0].task_id, second.id)
    assert.equal(taskRuns(store, project.id, 'queued').length, 0)
  } finally {
    await cleanup(root, store)
  }
})

test('写占用随任务离开「进行中」释放：任务走到 done 后另一条立刻放行', async () => {
  const { root, store, service, director, dev, dev2 } = await setup()
  try {
    const project = await service.createProject({ name: 'Done', key: 'DNE', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
    const first = await service.createTask({
      projectId: project.id, title: '改单个文件', assigneeBotId: dev.id,
      writeScopes: ['ui/modules/chat.js'], autoStart: true,
    })
    // DSHBOTS-290：第二条走 dev2 车道，占用释放后由它接棒。
    const second = await service.createTask({
      projectId: project.id, title: '改整个目录', assigneeBotId: dev2.id,
      writeScopes: ['ui/modules'], autoStart: true,
    })

    service.started = true
    await service.tick()
    const firstRun = taskRuns(store, project.id, 'running').find(run => run.task_id === first.id)
    assert.ok(firstRun)

    // in_progress → in_review → done：离开「进行中」的那一刻写占用就释放。
    await service.transitionTask(first.id, 'in_review', userActor(service))
    const released = store.get('SELECT * FROM runs WHERE id = ?', firstRun.id)
    assert.equal(released.status, 'canceled')
    assert.equal(released.error_code, 'TASK_LEFT_IN_PROGRESS')
    await service.transitionTask(first.id, 'done', userActor(service))

    await service.tick()
    const nowRunning = taskRuns(store, project.id, 'running')
    assert.equal(nowRunning.length, 1, '离开进行中后另一条立刻放行')
    assert.equal(nowRunning[0].task_id, second.id)
  } finally {
    await cleanup(root, store)
  }
})

test('非任务运行不受写占用闸门影响：聊天运行不占写槽，也不被任务状态变更中止', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'Chat', key: 'CHT', ownerBotId: director.id, memberIds: [dev.id] })
    // 群里发一条消息 → 产生 kind='chat' 的只读运行（不绑任务）。
    await service.sendMessage(project.id, '汇报一下当前进度', { type: 'user', id: 'u1' })
    service.started = true
    await service.tick()
    const chatRun = store.get("SELECT * FROM runs WHERE kind = 'chat' AND project_id = ? AND status = 'running'", project.id)
    assert.ok(chatRun, '聊天运行已在跑')
    assert.equal(chatRun.mode, 'read')

    const task = await service.createTask({
      projectId: project.id, title: '写任务', assigneeBotId: dev.id,
      writeScopes: ['ui/modules'], autoStart: true,
    })
    await service.tick()
    const taskRun = store.get("SELECT * FROM runs WHERE kind = 'task' AND task_id = ? AND status = 'running'", task.id)
    assert.ok(taskRun)

    await service.transitionTask(task.id, 'canceled', userActor(service))
    assert.equal(store.get('SELECT status FROM runs WHERE id = ?', taskRun.id).status, 'canceled', '写运行被中止')
    assert.equal(store.get('SELECT status FROM runs WHERE id = ?', chatRun.id).status, 'running', '聊天运行不受任务状态变更影响')
  } finally {
    await cleanup(root, store)
  }
})

test('离开「进行中」只停写运行：验收用的只读运行照旧在跑', async () => {
  const { root, store, service, runtime, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'Review', key: 'RVW', ownerBotId: director.id, memberIds: [dev.id] })
    const task = await service.createTask({
      projectId: project.id, title: '交付待验收', assigneeBotId: dev.id,
      writeScopes: ['ui/modules'],
    })
    // 由 bot 派单 → 验收人变成总监（review_target='owner_bot'），交付后派生只读的 review 运行。
    await service.assignTask(task.id, dev.id, { type: 'bot', id: director.id })

    service.started = true
    await service.tick()
    const taskRun = store.get("SELECT * FROM runs WHERE kind = 'task' AND task_id = ? AND status = 'running'", task.id)
    assert.ok(taskRun)

    // 任务运行完成 → 任务转「验收中」，派生只读的 review 运行。
    await runtime.complete(taskRun.id, 'succeeded', '交付完成')
    await waitFor(() => store.get("SELECT * FROM runs WHERE kind = 'review' AND task_id = ? AND status = 'running'", task.id))
    const reviewRun = store.get("SELECT * FROM runs WHERE kind = 'review' AND task_id = ? AND status = 'running'", task.id)
    assert.equal(reviewRun.mode, 'read')

    // 验收通过 → 任务离开「进行中」：只读验收运行不被中止。
    await service.transitionTask(task.id, 'done', userActor(service))
    assert.equal(store.get('SELECT status FROM runs WHERE id = ?', reviewRun.id).status, 'running', '只读验收运行不被中止')
  } finally {
    await cleanup(root, store)
  }
})
