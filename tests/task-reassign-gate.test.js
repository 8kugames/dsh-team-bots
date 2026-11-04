// DSHBOTS-169：assignTask 改派闸门——queued 占位运行（死队列）不再阻断换负责人，
// 按 SUPERSEDED 口径清理后放行并按新负责人重排 task_run；running 照旧阻断；同负责人重派不清理。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// 手动完成的 runtime：startRun 后运行保持 running，直到测试显式驱动。
class ManualRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async steer() { return true }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-reassign-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new ManualRuntime())
  await service.initialize()
  // 关闭自动调度：queued 占位运行停在队列里，正是「死队列」形态。
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const artist = await service.createBot({ name: 'Painter', role: '插画', instructions: 'Draw.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Reassign', key: 'RSG', ownerBotId: director.id, memberIds: [dev.id, artist.id] })
  return { root, store, service, director, dev, artist, project }
}

const userActor = service => ({ type: 'user', id: service.localUserId })
const activeTaskRuns = (store, taskId) => store.all(
  "SELECT * FROM runs WHERE task_id = ? AND kind = 'task' AND status IN ('queued', 'running')",
  taskId,
)
const runEventTypes = (store, runId) =>
  store.all('SELECT type FROM run_events WHERE run_id = ?', runId).map(row => row.type)

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

test('仅有 queued 占位：换负责人成功，旧运行被 SUPERSEDED 清理，新运行按新负责人入队', async () => {
  const { root, store, service, dev, artist, project } = await setup()
  try {
    const task = await service.createTask({
      projectId: project.id, title: '死队列改派', assigneeBotId: dev.id, writeScopes: ['ui/modules'], autoStart: true,
    })
    const placeholder = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task' AND status = 'queued'", task.id)
    assert.ok(placeholder, 'queued 占位运行已存在（死队列形态）')

    const view = await service.assignTask(task.id, artist.id, userActor(service))

    assert.equal(view.assigneeBotId ?? view.assignee_bot_id ?? artist.id, artist.id, '负责人已换成 artist')
    const old = store.get('SELECT * FROM runs WHERE id = ?', placeholder.id)
    assert.equal(old.status, 'canceled', '旧 queued 运行已清理')
    assert.equal(old.error_code, 'SUPERSEDED', '清理口径是 SUPERSEDED')
    assert.ok(runEventTypes(store, placeholder.id).includes('stale_superseded'), '清理留有 stale_superseded 事件')
    const actives = activeTaskRuns(store, task.id)
    assert.equal(actives.length, 1, '清理后恰好一条新任务运行')
    assert.equal(actives[0].status, 'queued', '新运行已入队')
    assert.equal(actives[0].bot_id, artist.id, '新运行按新负责人入队')
  } finally {
    await cleanup(root, store)
  }
})

test('重复改派仍能排出新运行：时间戳幂等键不撞首写者赢闸', async () => {
  const { root, store, service, dev, artist, project } = await setup()
  try {
    const task = await service.createTask({
      projectId: project.id, title: '连续改派', assigneeBotId: dev.id, writeScopes: ['ui/modules'], autoStart: true,
    })
    await service.assignTask(task.id, artist.id, userActor(service))
    // 时间戳幂等键按毫秒取值：两次改派间稍作间隔，避免同毫秒撞键。
    await new Promise(resolve => setTimeout(resolve, 3))
    await service.assignTask(task.id, dev.id, userActor(service))

    const superseded = store.all("SELECT id FROM runs WHERE task_id = ? AND status = 'canceled' AND error_code = 'SUPERSEDED'", task.id)
    assert.equal(superseded.length, 2, '两代 queued 占位都被 SUPERSEDED 清理')
    const actives = activeTaskRuns(store, task.id)
    assert.equal(actives.length, 1, '第二次改派仍排得出新运行（未被 outbox 先写者赢吞掉）')
    assert.equal(actives[0].bot_id, dev.id, '最终运行归属第二任负责人')
  } finally {
    await cleanup(root, store)
  }
})

test('running 时换负责人仍被阻断，文案不变', async () => {
  const { root, store, service, dev, artist, project } = await setup()
  try {
    const task = await service.createTask({
      projectId: project.id, title: '执行中不可改派', assigneeBotId: dev.id, writeScopes: ['ui/modules'], autoStart: true,
    })
    service.started = true
    await service.tick()
    const running = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task' AND status = 'running'", task.id)
    assert.ok(running, '任务运行已起跑')

    await assert.rejects(
      service.assignTask(task.id, artist.id, userActor(service)),
      /任务有正在执行的运行，不能更换负责人/,
    )
    assert.equal(store.get('SELECT assignee_bot_id FROM tasks WHERE id = ?', task.id).assignee_bot_id, dev.id, '负责人未变')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND error_code = 'SUPERSEDED'", task.id).n, 0, 'running 阻断不触发清理')
  } finally {
    service.started = false
    await cleanup(root, store)
  }
})

test('同负责人重派：queued 占位不清理、不另排新运行', async () => {
  const { root, store, service, dev, project } = await setup()
  try {
    const task = await service.createTask({
      projectId: project.id, title: '同负责人重派', assigneeBotId: dev.id, writeScopes: ['ui/modules'], autoStart: true,
    })
    const placeholder = store.get("SELECT * FROM runs WHERE task_id = ? AND kind = 'task' AND status = 'queued'", task.id)
    assert.ok(placeholder)

    await service.assignTask(task.id, dev.id, userActor(service))

    const same = store.get('SELECT * FROM runs WHERE id = ?', placeholder.id)
    assert.equal(same.status, 'queued', '同负责人重派不清 queued 占位')
    assert.equal(same.error_code, null, '未写 SUPERSEDED')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?", task.id).n, 1, '不另排新运行')
  } finally {
    await cleanup(root, store)
  }
})
