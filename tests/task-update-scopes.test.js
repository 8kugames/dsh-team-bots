// DSHBOTS-151 任务写范围 owner 可编辑：task_update_scopes 的行为测试（DB 行为）+ api.js 分发守门。
// 行为口径：
// ① owner-only：非 user actor 一律 forbidden；
// ② running 写运行拒改（400，提示先等运行结束或取消）；
// ③ queued 写运行允许改，且同步刷新其 write_scopes 快照 + run_events scopes_updated + 审计；
// ④ parseWriteScopes 归一（trim/去重/去尾斜杠）与空集合拒绝；终态卡（done/canceled）拒改。
// UI 编辑态（modal 编辑入口/表单/handler）的源码守门随 UI 段子卡补入本文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { readUiSource } from './helpers/ui-sources.js'

// 手动完成的 runtime：startRun 后运行保持 running，直到测试显式 complete。
class ManualRuntime {
  constructor() {
    this.pendingRuns = new Map()
    this.handler = null
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  async startRun({ run }) {
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

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-scopes-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new ManualRuntime())
  await service.initialize()
  // 关闭自动调度：queued 用例由测试显式 enqueueTaskRun 落运行，running 用例再显式开 tick。
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Scopes', key: 'SCP', ownerBotId: director.id, memberIds: [dev.id] })
  return { root, store, service, project, dev }
}

async function cleanup(root, store) {
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const userActor = service => ({ type: 'user', id: service.localUserId })

async function makeTask(service, project, dev, overrides = {}) {
  return service.createTask({
    projectId: project.id,
    title: '改范围',
    assigneeBotId: dev.id,
    writeScopes: ['src/old.js'],
    ...overrides,
  })
}

test('owner-only：非 user actor 拒绝，user actor 放行', async () => {
  const { root, store, service, project, dev } = await setup()
  try {
    const task = await makeTask(service, project, dev)
    await assert.rejects(
      service.taskUpdateScopes(task.id, ['src/new.js'], { type: 'bot', id: dev.id }),
      /只有工作台 owner 可以修改写范围/,
    )
    const updated = await service.taskUpdateScopes(task.id, ['src/new.js'], userActor(service))
    assert.deepEqual(updated.writeScopes, ['src/new.js'], 'owner 修改应成功落库')
  } finally {
    await cleanup(root, store)
  }
})

test('running 写运行拒改：400 提示先等运行结束或取消，任务声明原样保留', async () => {
  const { root, store, service, project, dev } = await setup()
  try {
    const task = await makeTask(service, project, dev, { autoStart: true })
    service.started = true
    await service.tick()
    const running = store.get("SELECT id FROM runs WHERE task_id = ? AND status = 'running'", task.id)
    assert.ok(running, '前置：写运行应已处于 running')
    await assert.rejects(
      service.taskUpdateScopes(task.id, ['src/new.js'], userActor(service)),
      /先等运行结束或取消/,
    )
    const row = store.get('SELECT write_scopes FROM tasks WHERE id = ?', task.id)
    assert.deepEqual(JSON.parse(row.write_scopes), ['src/old.js'], '拒改时任务声明不能被改动')
    assert.equal(store.get('SELECT write_scopes FROM runs WHERE id = ?', running.id).write_scopes, JSON.stringify(['src/old.js']), '运行快照不能被改动')
  } finally {
    await cleanup(root, store)
  }
})

test('queued 写运行：允许改，任务声明与运行快照同拍更新，事件与审计齐写', async () => {
  const { root, store, service, project, dev } = await setup()
  try {
    const task = await makeTask(service, project, dev)
    // 显式走真实入队路径（scheduler 派发 outbox 时调用的同一方法），快照来自任务当时的声明。
    const runId = service.enqueueTaskRun(service.taskRow(task.id), 'assigned', userActor(service))
    assert.equal(
      store.get('SELECT write_scopes FROM runs WHERE id = ?', runId).write_scopes,
      JSON.stringify(['src/old.js']),
      '前置：入队快照应等于旧声明',
    )
    const updated = await service.taskUpdateScopes(task.id, ['src/new/deep.js', 'tests/new.test.js'], userActor(service))
    assert.deepEqual(updated.writeScopes, ['src/new/deep.js', 'tests/new.test.js'])
    assert.deepEqual(
      JSON.parse(store.get('SELECT write_scopes FROM runs WHERE id = ?', runId).write_scopes),
      ['src/new/deep.js', 'tests/new.test.js'],
      '排队运行的写范围快照必须同步为新声明（下一拍调度按它判闸）',
    )
    const runEvent = store.get("SELECT type, message FROM run_events WHERE run_id = ? AND type = 'scopes_updated'", runId)
    assert.ok(runEvent, '运行事件应记 scopes_updated')
    assert.match(runEvent.message, /src\/new\/deep\.js/)
    const taskEvent = store.get("SELECT type, data_json FROM task_events WHERE task_id = ? AND type = 'scopes_updated'", task.id)
    assert.ok(taskEvent, '任务事件应记 scopes_updated')
    assert.deepEqual(JSON.parse(taskEvent.data_json), { from: ['src/old.js'], to: ['src/new/deep.js', 'tests/new.test.js'] })
    const audit = store.get("SELECT data_json FROM audit_log WHERE action = 'task.scopes_update' AND target_id = ?", task.id)
    assert.ok(audit, '审计应记 task.scopes_update')
    assert.deepEqual(JSON.parse(audit.data_json), { from: ['src/old.js'], to: ['src/new/deep.js', 'tests/new.test.js'] })
  } finally {
    await cleanup(root, store)
  }
})

test('归一化：trim/去重/去尾斜杠后落库；空集合与终态卡拒绝', async () => {
  const { root, store, service, project, dev } = await setup()
  try {
    const task = await makeTask(service, project, dev)
    const updated = await service.taskUpdateScopes(
      task.id,
      ['  src/api.js ', 'src/api.js/', 'src/api.js', 'tests/api.test.js'],
      userActor(service),
    )
    assert.deepEqual(updated.writeScopes, ['src/api.js', 'tests/api.test.js'], 'trim/去重/去尾斜杠后只留归一条目')
    await assert.rejects(
      service.taskUpdateScopes(task.id, [], userActor(service)),
      /写范围不能为空/,
    )
    await assert.rejects(
      service.taskUpdateScopes(task.id, ['/abs/path'], userActor(service)),
      /非法路径/,
    )
    const done = await makeTask(service, project, dev, { status: 'done', title: '已完结' })
    await assert.rejects(
      service.taskUpdateScopes(done.id, ['src/x.js'], userActor(service)),
      /任务已结束，不能修改写范围/,
    )
    const canceled = await makeTask(service, project, dev, { status: 'canceled', title: '已取消' })
    await assert.rejects(
      service.taskUpdateScopes(canceled.id, ['src/x.js'], userActor(service)),
      /任务已结束，不能修改写范围/,
    )
  } finally {
    await cleanup(root, store)
  }
})

// ── api.js 分发守门（UI 编辑态的接线守门随 UI 段子卡补齐）─────────────────────────
test('api.js 分发收录 task_update_scopes（ACTIONS + case 双口径）', () => {
  const apiSource = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8')
  assert.match(apiSource, /'task_update_scopes',/, 'ACTIONS Set 收录')
  assert.match(apiSource, /case 'task_update_scopes':/, 'switch 分发收录')
  assert.match(apiSource, /service\.taskUpdateScopes\(/, 'case 调用服务层 taskUpdateScopes')
})
