import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// DSHBOTS-30：把同项目写并行的闸门行为锁进套件。
// 走真实 tick() 出队路径（入队 → tick → 数同时 running 的任务运行），
// 不直接调私有函数绕过出队逻辑；写范围重叠/未声明的语义细节由
// tests/write-scopes.test.js 在纯函数层覆盖，这里只锁集成行为。
// DSHBOTS-290：one_active_run_per_bot 下同 bot 至多一条活跃运行，写闸门的
// 并行/串行只在跨 bot 维度可观测——并行/串行侧任务各挂一个成员 bot。

// 手动完成的 runtime：startRun 后运行保持 running，直到测试显式调用 complete。
// 构造与 tests/scheduling.test.js 的 ManualRuntime 保持一致，便于对照阅读。
class ManualRuntime { declare started: any[]; declare steers: any[]; declare pendingRuns: any; declare handler: any;
  constructor() {
    this.started = []
    this.steers = []
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

  async steer(sessionId, text) {
    this.steers.push({ sessionId, text })
    return true
  }

  async cancelRun() { return true }

  complete(runId, status = 'succeeded', output = 'done') {
    this.pendingRuns.delete(runId)
    return this.handler({ runId, status, output, error: null })
  }
}

async function manualSetup({ maxConcurrentRuns }: { maxConcurrentRuns?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-parallel-'))
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
  // 关闭自动调度，由测试显式驱动 tick。
  service.started = false
  // 种子总监 Bot 按 id 取第一条种子 Bot，避免耦合具体名字。
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  // DSHBOTS-290：bot 级串行（one_active_run_per_bot）下同 bot 双任务必串行（第二条直接挂起
  // 不落 runs 行）；写范围闸门与 bot 无关，需要同时排队的并行用例分属不同 bot 车道。
  const dev2 = await service.createBot({
    name: 'Builder2', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  const dev3 = await service.createBot({
    name: 'Builder3', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  return { root, store, service, runtime, director, dev, dev2, dev3 }
}

// 任务跑完会派生 chat/审查运行，统计并行度只看 kind='task'，避免被派生运行污染。
function taskRuns(store, projectId, status) {
  return store.all(
    "SELECT * FROM runs WHERE project_id = ? AND kind = 'task' AND status = ?",
    projectId, status,
  )
}

function runParallelEventCount(store, runId) {
  return Number(store.get(
    "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'run_parallel'",
    runId,
  ).n)
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

test('同项目两条写任务：目录级写范围不相交，一次 tick 后同时 running', async () => {
  const { root, store, service, director, dev, dev2 } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Parallel', key: 'PAR', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
    const first = await service.createTask({
      projectId: project.id, title: '改 UI 模块', assigneeBotId: dev.id,
      writeScopes: ['ui/modules'], autoStart: true,
    })
    // DSHBOTS-290：第二条走 dev2 车道，两条运行同时排队供闸门比对。
    const second = await service.createTask({
      projectId: project.id, title: '改服务模块', assigneeBotId: dev2.id,
      writeScopes: ['src/services'], autoStart: true,
    })

    service.started = true
    await service.tick()

    const running = taskRuns(store, project.id, 'running')
    assert.equal(running.length, 2, '写范围不相交的两条任务应同时 running')
    assert.equal(taskRuns(store, project.id, 'queued').length, 0)
    // 每条 run 的 write_scopes 快照与任务声明一致，不能串号。
    const scopesByTask = new Map(running.map(run => [run.task_id, JSON.parse(run.write_scopes)]))
    assert.deepEqual(scopesByTask.get(first.id), ['ui/modules'])
    assert.deepEqual(scopesByTask.get(second.id), ['src/services'])
    // 并行放行恰好记一条 run_parallel 事件，且落在其中一条任务运行上。
    const events = store.all("SELECT run_id FROM run_events WHERE type = 'run_parallel'")
    assert.equal(events.length, 1, '只应记一条并行放行事件')
    const runningIds = new Set(running.map(run => run.id))
    assert.ok(runningIds.has(events[0].run_id), '并行放行事件应落在并行放行的任务运行上')
  } finally {
    await cleanup(root, store)
  }
})

test('并行放行事件记在后领取的运行上：首条运行无事件，第二条与在跑写范围不重叠时放行', async () => {
  const { root, store, service, director, dev, dev2 } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Second', key: 'SEC', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
    const first = await service.createTask({
      projectId: project.id, title: '先改 UI 模块', assigneeBotId: dev.id,
      writeScopes: ['ui/modules'], autoStart: true,
    })

    service.started = true
    await service.tick()
    assert.equal(taskRuns(store, project.id, 'running').length, 1)
    // 项目里还没有其它在跑写运行时，首条运行不算并行放行。
    const firstRun = taskRuns(store, project.id, 'running').find(run => run.task_id === first.id)
    assert.ok(firstRun)
    assert.equal(runParallelEventCount(store, firstRun.id), 0, '首条写运行不应记并行放行事件')

    // DSHBOTS-290：第二条走 dev2 车道——首条在跑时同 bot 新任务只会挂起，不会落 runs 行。
    const second = await service.createTask({
      projectId: project.id, title: '再改服务模块', assigneeBotId: dev2.id,
      writeScopes: ['src/services'], autoStart: true,
    })
    await service.tick()

    const running = taskRuns(store, project.id, 'running')
    assert.equal(running.length, 2, '后入队任务应与在跑的写运行并行')
    const secondRun = running.find(run => run.task_id === second.id)
    assert.ok(secondRun, '后入队任务应被领取为运行')
    assert.equal(runParallelEventCount(store, secondRun.id), 1, '并行放行事件应记在第二条运行上')
    assert.deepEqual(JSON.parse(secondRun.write_scopes), ['src/services'])
  } finally {
    await cleanup(root, store)
  }
})

test('同项目两条写任务：写范围按目录前缀重叠时只放行一条', async () => {
  const { root, store, service, director, dev, dev2 } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'Overlap', key: 'OVL', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
    await service.createTask({
      projectId: project.id, title: '改单个文件', assigneeBotId: dev.id,
      writeScopes: ['ui/modules/chat.js'], autoStart: true,
    })
    // DSHBOTS-290：第二条走 dev2 车道，被闸门挡下时是它自己 bot 上的排队行。
    await service.createTask({
      projectId: project.id, title: '改整个目录', assigneeBotId: dev2.id,
      writeScopes: ['ui/modules'], autoStart: true,
    })

    service.started = true
    await service.tick()

    assert.equal(taskRuns(store, project.id, 'running').length, 1, '前缀重叠的写范围必须串行')
    const gated = taskRuns(store, project.id, 'queued')
    assert.equal(gated.length, 1, '被闸门挡下的任务应留在队列里')
    assert.equal(gated[0].bot_id, dev2.id, '被挡下的是另一条 bot 车道上的排队运行')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE bot_id = ? AND status = 'running'", dev2.id).n, 0, '被挡下任务的 bot 没有在跑的运行')
  } finally {
    await cleanup(root, store)
  }
})

test('同项目两条写任务：一侧声明一侧未声明时保守串行', async () => {
  const { root, store, service, director, dev, dev2 } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'HalfScope', key: 'HSC', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
    await service.createTask({
      projectId: project.id, title: '声明了范围', assigneeBotId: dev.id,
      writeScopes: ['src/app.js'], autoStart: true,
    })
    // DSHBOTS-290：第二条走 dev2 车道，未声明一侧被保守挡下时留它自己 bot 的排队行。
    await service.createTask({
      projectId: project.id, title: '没声明范围', assigneeBotId: dev2.id, autoStart: true,
    })

    service.started = true
    await service.tick()

    assert.equal(taskRuns(store, project.id, 'running').length, 1, '任一侧未声明写范围必须保守串行')
    const gated = taskRuns(store, project.id, 'queued')
    assert.equal(gated.length, 1)
    assert.equal(gated[0].bot_id, dev2.id, '被挡下的是另一条 bot 车道上的排队运行')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE bot_id = ? AND status = 'running'", dev2.id).n, 0, '被挡下任务的 bot 没有在跑的运行')
  } finally {
    await cleanup(root, store)
  }
})

test('同项目两条写任务：两侧都未声明时保守串行', async () => {
  const { root, store, service, director, dev, dev2 } = await manualSetup()
  try {
    const project = await service.createProject({ name: 'NoScope', key: 'NSC', ownerBotId: director.id, memberIds: [dev.id, dev2.id] })
    await service.createTask({ projectId: project.id, title: '任务甲', assigneeBotId: dev.id, autoStart: true })
    // DSHBOTS-290：第二条走 dev2 车道，两侧未声明的保守串行同样留它自己 bot 的排队行。
    await service.createTask({ projectId: project.id, title: '任务乙', assigneeBotId: dev2.id, autoStart: true })

    service.started = true
    await service.tick()

    assert.equal(taskRuns(store, project.id, 'running').length, 1, '两侧都未声明写范围必须保守串行')
    const gated = taskRuns(store, project.id, 'queued')
    assert.equal(gated.length, 1)
    assert.equal(gated[0].bot_id, dev2.id, '被挡下的是另一条 bot 车道上的排队运行')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE bot_id = ? AND status = 'running'", dev2.id).n, 0, '被挡下任务的 bot 没有在跑的运行')
  } finally {
    await cleanup(root, store)
  }
})

test('回归保护：maxConcurrentRuns=3 且写范围互不相交时，三条任务同时 running 不被误判冲突', async () => {
  const { root, store, service, director, dev, dev2, dev3 } = await manualSetup({ maxConcurrentRuns: 3 })
  try {
    const project = await service.createProject({ name: 'Trio', key: 'TRI', ownerBotId: director.id, memberIds: [dev.id, dev2.id, dev3.id] })
    // DSHBOTS-290：三条并行车道分属三个 bot，one_active_run_per_bot 不约束跨 bot 并行。
    const laneBots = [dev, dev2, dev3]
    const disjointScopes = [['ui/modules'], ['src/services'], ['tests/unit']]
    for (const [index, writeScopes] of disjointScopes.entries()) {
      await service.createTask({
        projectId: project.id, title: `并行任务 ${index + 1}`, assigneeBotId: laneBots[index].id,
        writeScopes, autoStart: true,
      })
    }

    service.started = true
    await service.tick()

    const running = taskRuns(store, project.id, 'running')
    assert.equal(running.length, 3, '互不相交的写范围应放行到并发上限')
    // 快照各自正确，顺序无关。
    const snapshots = running.map(run => JSON.parse(run.write_scopes)).sort()
    assert.deepEqual(snapshots, [['src/services'], ['tests/unit'], ['ui/modules']])
    // 三条同时并行应有两条并行放行事件（首条之外各记一条）。
    const eventCount = Number(store.get("SELECT COUNT(*) AS n FROM run_events WHERE type = 'run_parallel'").n)
    assert.equal(eventCount, 2, '第二、三条运行应各记一条并行放行事件')
  } finally {
    await cleanup(root, store)
  }
})
