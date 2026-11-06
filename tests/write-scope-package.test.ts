import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Store } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import {
  parseWriteScopes,
  parseWriteScopesFromDescription,
  effectiveWriteScopes,
} from '../src/services/write-scopes.js'

// DSHBOTS-133：package.json 是版本钩子的机械改动（pre-commit 每次提交 bump patch 位），
// 不纳入写范围锁。这里锁两件事：
//   ① 闸门侧：比对前双侧剥掉 package.json（存量 queued 运行快照也带它，靠闸门过滤兜住）；
//   ② 声明侧：parseWriteScopes 出口剥掉，新任务从源头不带。
// 走真实 tick() 出队路径，构造方式参照 tests/parallel-scheduling.test.js。

// 手动完成的 runtime：startRun 后运行保持 running，直到测试显式调用 complete。
class ManualRuntime {
  declare started: { runId: string; taskId: string | null; mode: unknown }[]
  declare pendingRuns: Map<string, unknown>
  declare handler: (result: { runId: string; status: string; output: string; error: null }) => unknown

  constructor() {
    this.started = []
    this.pendingRuns = new Map()
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  async startRun({ run }) {
    this.started.push({ runId: run.id, taskId: run.task_id ?? null, mode: run.mode })
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-write-scope-package-'))
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
  // 种子总监 Bot 按 id 取第一条种子 Bot，避免耦合具体名字。
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  // DSHBOTS-290：bot 级串行（one_active_run_per_bot）下并行断言需要异 bot——补第二成员。
  const dev2 = await service.createBot({
    name: 'Builder2', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  return { root, store, service, runtime, director, dev, dev2 }
}

function taskRuns(store, projectId, status) {
  return store.all(
    "SELECT * FROM runs WHERE project_id = ? AND kind = 'task' AND status = ?",
    projectId, status,
  )
}

function runParallelEventCount(store) {
  return Number(store.get(
    "SELECT COUNT(*) AS n FROM run_events WHERE type = 'run_parallel'",
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

// 建任务并入队一条写运行。snapshotScopes 用于模拟「存量快照带 package.json」：
// 声明侧 parseWriteScopes 已把它剥掉，这里在入队前注回任务行，让 run 快照与生产库里的
// 历史 queued 运行一致（闸门必须自己过滤，不能依赖声明侧干净）。
async function enqueueTask({ service, store, project, dev, actor, title, scopes, snapshotScopes }: { service: TeamService; store: Store; project: { id: string }; dev: { id: string }; actor: Actor; title: string; scopes: string[]; snapshotScopes?: string[] }) {
  const created = await service.createTask({
    projectId: project.id, title, assigneeBotId: dev.id,
    writeScopes: scopes, autoStart: false, postCard: false,
  })
  const finalScopes = snapshotScopes ?? scopes
  store.run('UPDATE tasks SET write_scopes = ? WHERE id = ?', JSON.stringify(finalScopes), created.id)
  const taskRow = store.get('SELECT * FROM tasks WHERE id = ?', created.id)
  service.enqueueTaskRun(taskRow, 'manual', actor)
  return taskRow
}

test('双方写范围快照都带 package.json、其余路径不相交：tick 后同时 running', async () => {
  const { root, store, service, director, dev, dev2 } = await manualSetup()
  const actor: Actor = { type: 'user', id: 'u1' }
  try {
    const project = await service.createProject({ name: 'PkgParallel', key: 'PKG', ownerBotId: director.id, memberIds: [dev.id, dev2.id] }, actor)
    await enqueueTask({
      service, store, project, dev, actor, title: '改 UI 模块',
      scopes: ['ui/modules'], snapshotScopes: ['package.json', 'ui/modules'],
    })
    await enqueueTask({
      service, store, project, dev: dev2, actor, title: '改服务模块',
      scopes: ['src/services'], snapshotScopes: ['package.json', 'src/services'],
    })

    service.started = true
    await service.tick()

    const running = taskRuns(store, project.id, 'running')
    assert.equal(running.length, 2, 'package.json 不纳入写范围锁，其余路径不相交应并行')
    assert.equal(taskRuns(store, project.id, 'queued').length, 0)
    // 快照里确实带着 package.json：是闸门过滤让它并行，而不是声明侧剥掉。
    const snapshots = running.map(run => JSON.parse(run.write_scopes)).sort()
    assert.deepEqual(snapshots, [['package.json', 'src/services'], ['package.json', 'ui/modules']])
    assert.equal(runParallelEventCount(store), 1, '应记一条并行放行事件')
  } finally {
    await cleanup(root, store)
  }
})

test('一方真实改动 scripts/version-bump.mjs 与另一方 src/x：不相交照常并行', async () => {
  const { root, store, service, director, dev, dev2 } = await manualSetup()
  const actor: Actor = { type: 'user', id: 'u1' }
  try {
    const project = await service.createProject({ name: 'RealPath', key: 'REA', ownerBotId: director.id, memberIds: [dev.id, dev2.id] }, actor)
    const first = await enqueueTask({
      service, store, project, dev, actor, title: '改版本脚本',
      scopes: ['scripts/version-bump.mjs'], snapshotScopes: ['package.json', 'scripts/version-bump.mjs'],
    })
    await enqueueTask({
      service, store, project, dev: dev2, actor, title: '改源码',
      scopes: ['src/x'],
    })

    service.started = true
    await service.tick()

    const running = taskRuns(store, project.id, 'running')
    assert.equal(running.length, 2, 'scripts/version-bump.mjs 是真实路径，不与 src/x 相交应并行')
    assert.equal(taskRuns(store, project.id, 'queued').length, 0)
    // 过滤只剥恰为 package.json 的条目，scripts/ 下的真实路径必须原样保留。
    const firstRun = running.find(run => run.task_id === first.id)
    assert.ok(firstRun)
    assert.deepEqual(JSON.parse(firstRun.write_scopes), ['package.json', 'scripts/version-bump.mjs'])
  } finally {
    await cleanup(root, store)
  }
})

test('过滤掉 package.json 后仍相交：保守串行', async () => {
  const { root, store, service, director, dev, dev2 } = await manualSetup()
  const actor: Actor = { type: 'user', id: 'u1' }
  try {
    const project = await service.createProject({ name: 'PkgOverlap', key: 'PKO', ownerBotId: director.id, memberIds: [dev.id, dev2.id] }, actor)
    const first = await enqueueTask({
      service, store, project, dev, actor, title: '改服务目录',
      scopes: ['src/services'], snapshotScopes: ['package.json', 'src/services'],
    })
    await enqueueTask({
      service, store, project, dev: dev2, actor, title: '改服务文件',
      scopes: ['src/services/tasks.js'], snapshotScopes: ['package.json', 'src/services/tasks.js'],
    })

    service.started = true
    await service.tick()

    const running = taskRuns(store, project.id, 'running')
    assert.equal(running.length, 1, '过滤后仍前缀相交必须串行')
    const gated = taskRuns(store, project.id, 'queued')
    assert.equal(gated.length, 1, '被闸门挡下的任务应留在队列里')
    assert.equal(gated[0].bot_id, dev2.id, '被挡下的是另一条 bot 车道上的排队运行')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE bot_id = ? AND status = 'running'", dev2.id).n, 0, '被挡下任务的 bot 没有在跑的运行')
    assert.equal(running[0].task_id, first.id, '先入队的任务应被领取')
    assert.equal(runParallelEventCount(store), 0, '串行时不记并行放行事件')
  } finally {
    await cleanup(root, store)
  }
})

test('过滤后任一为空：仍按未声明保守串行', async () => {
  const { root, store, service, director, dev, dev2 } = await manualSetup()
  const actor: Actor = { type: 'user', id: 'u1' }
  try {
    const project = await service.createProject({ name: 'PkgEmpty', key: 'PKE', ownerBotId: director.id, memberIds: [dev.id, dev2.id] }, actor)
    const first = await enqueueTask({
      service, store, project, dev, actor, title: '只碰版本号',
      scopes: ['package.json'], snapshotScopes: ['package.json'],
    })
    await enqueueTask({
      service, store, project, dev: dev2, actor, title: '改源码',
      scopes: ['src/x'],
    })

    service.started = true
    await service.tick()

    const running = taskRuns(store, project.id, 'running')
    assert.equal(running.length, 1, '一侧过滤后为空必须保守串行')
    const gated = taskRuns(store, project.id, 'queued')
    assert.equal(gated.length, 1, '另一侧应留在队列里')
    assert.equal(gated[0].bot_id, dev2.id, '被挡下的是另一条 bot 车道上的排队运行')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE bot_id = ? AND status = 'running'", dev2.id).n, 0, '被挡下任务的 bot 没有在跑的运行')
    assert.equal(running[0].task_id, first.id, '先入队的任务单独放行，随后占住写槽挡住下一条')
  } finally {
    await cleanup(root, store)
  }
})

test('parseWriteScopes/parseWriteScopesFromDescription 出口剥掉 package.json', () => {
  assert.deepEqual(parseWriteScopes(['package.json']), [])
  assert.deepEqual(parseWriteScopes(['package.json', 'ui/a.js']), ['ui/a.js'])
  assert.deepEqual(parseWriteScopes('["package.json","src/b.js"]'), ['src/b.js'])
  assert.deepEqual(parseWriteScopes(['scripts/version-bump.mjs', 'package.json']), ['scripts/version-bump.mjs'])
  assert.deepEqual(parseWriteScopesFromDescription('写范围：package.json, ui/a.js'), ['ui/a.js'])
  assert.deepEqual(parseWriteScopesFromDescription('write_scopes: package.json'), [])
  assert.deepEqual(parseWriteScopesFromDescription('写范围：scripts/version-bump.mjs'), ['scripts/version-bump.mjs'])
})

test('effectiveWriteScopes：只剥恰为 package.json 的条目，其余原样', () => {
  assert.deepEqual(effectiveWriteScopes(['package.json', 'src/x']), ['src/x'])
  assert.deepEqual(effectiveWriteScopes('["package.json"]'), [])
  assert.deepEqual(effectiveWriteScopes([]), [])
  assert.deepEqual(effectiveWriteScopes(null), [])
  assert.deepEqual(effectiveWriteScopes(['scripts/version-bump.mjs']), ['scripts/version-bump.mjs'])
  assert.deepEqual(effectiveWriteScopes(['package.json', 'package.json']), [])
})
