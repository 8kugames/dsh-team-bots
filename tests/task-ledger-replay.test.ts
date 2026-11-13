// tests/task-ledger-replay.test.ts —— 日志导向存储（吸收 dsh-agent-team「账本为权威、
// 投影可重放」理念的最小落地）：
// ① setTaskStatus 统一状态迁移落点：UPDATE 与权威 'status' 事件（from/to）同事务，
//    守卫未命中为 no-op；
// ② 交付（in_review）/受阻（blocked）/开工（in_progress）/取消回退（todo）四条直改路径
//    均补写 status 事件，事件流可完整重放状态机；
// ③ taskProjectionDrift 巡检：正常流转零漂移；手工把 tasks.status 改离事件流终态即报漂移；
// ④ 嵌套事务：setTaskStatus 在外层事务内调用随外层一并回滚（db.ts 深度计数）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class HoldingRuntime {
  declare started: unknown[]
  constructor() { this.started = [] }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { this.started.push({ id: run.id, kind: run.kind }); return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ledger-replay-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Ledger', key: 'LED', ownerBotId: director.id, memberIds: [dev.id] })
  return { root, store, service, director, dev, project, close: async () => {
    for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
      try { await service.cancelRunInternal(run.id, false) } catch {}
    }
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  } }
}

async function bareTask(t) {
  const task = await t.service.assignFromBot('sess-ledger-owner', {
    assignee: 'Builder', title: '账本卡', description: '正常实施。', write_scopes: ['src/l.js'],
  })
  for (const run of t.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", task.id)) {
    await t.service.cancelRunInternal(run.id, false)
  }
  // tick 可能已把卡置 in_progress 并写过 status 事件：统一归一到 todo 并清掉 tick 的
  // status 事件（保留 created），测试从干净事件序列开始。
  t.store.run("UPDATE tasks SET status = 'todo' WHERE id = ?", task.id)
  t.store.run(
    "DELETE FROM task_events WHERE task_id = ? AND type = 'status' AND json_extract(data_json, '$.field') = 'status'",
    task.id,
  )
  return t.store.get('SELECT * FROM tasks WHERE id = ?', task.id)
}

const bindOwner = (t) => t.store.run(
  'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
  'sess-ledger-owner', t.director.id, t.project.id, 'project', new Date().toISOString(),
)

const statusEvents = (t, taskId) => t.store.all(
  `SELECT * FROM task_events WHERE task_id = ? AND type = 'status' AND json_extract(data_json, '$.field') = 'status' ORDER BY rowid`,
  taskId,
)

test('① setTaskStatus：UPDATE 与权威 status 事件同事务；守卫未命中为 no-op', async () => {
  const t = await setup()
  try {
    await bindOwner(t)
    const task = await bareTask(t)
    const actor = { type: 'system', id: 'system' }
    assert.equal(t.service.setTaskStatus(task.id, 'in_progress', actor), true, '正常迁移返回 true')
    const events = statusEvents(t, task.id)
    assert.equal(events.length, 1)
    assert.deepEqual(
      JSON.parse(events[0].data_json),
      { field: 'status', from: 'todo', to: 'in_progress' },
    )
    // 终态守卫：done 卡再迁移被拒，且不再追加事件。
    t.service.setTaskStatus(task.id, 'done', actor)
    assert.equal(t.service.setTaskStatus(task.id, 'in_progress', actor), false, 'done 卡 no-op')
    assert.equal(statusEvents(t, task.id).length, 2, '守卫拒绝不写事件')
    // ifIs 守卫：源态不匹配 no-op。
    assert.equal(t.service.setTaskStatus(task.id, 'todo', actor, { ifIs: 'in_progress' }), false)
  } finally { await t.close() }
})

test('② 交付/受阻/开工/取消四条直改路径均补写 status 事件，事件流可重放', async () => {
  const t = await setup()
  try {
    await bindOwner(t)
    const task = await bareTask(t)
    const actor = { type: 'system', id: 'system' }
    t.service.setTaskStatus(task.id, 'in_progress', actor)
    t.service.setTaskStatus(task.id, 'in_review', actor)
    t.service.setTaskStatus(task.id, 'in_progress', actor)
    t.service.setTaskStatus(task.id, 'todo', actor, { ifIs: 'in_progress' })
    // created 事件带初始 todo + 四条 status 事件 → 重放终态 todo。
    const events = t.store.all(
      `SELECT type, data_json FROM task_events WHERE task_id = ? ORDER BY rowid`,
      task.id,
    )
    let replayed = null
    for (const event of events) {
      const data = JSON.parse(event.data_json ?? '{}')
      if (event.type === 'created') replayed = data.status
      else if (event.type === 'status' && data.field === 'status') replayed = data.to
    }
    assert.equal(replayed, t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status)
    assert.equal(replayed, 'todo')
  } finally { await t.close() }
})

test('③ taskProjectionDrift：正常流转零漂移；投影被改离事件流即报', async () => {
  const t = await setup()
  try {
    await bindOwner(t)
    const task = await bareTask(t)
    t.service.setTaskStatus(task.id, 'in_progress', { type: 'system', id: 'system' })
    assert.deepEqual(t.service.taskProjectionDrift(), [], '正常流转零漂移')
    // 模拟投影脱节：手工直改 tasks.status（跳过账本）。
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
    const drift = t.service.taskProjectionDrift()
    assert.equal(drift.length, 1)
    assert.equal(drift[0].identifier, 'LED-1')
    assert.equal(drift[0].recorded, 'in_review')
    assert.equal(drift[0].replayed, 'in_progress')
  } finally { await t.close() }
})

test('④ 嵌套事务：setTaskStatus 随外层事务一并回滚', async () => {
  const t = await setup()
  try {
    await bindOwner(t)
    const task = await bareTask(t)
    const actor = { type: 'system', id: 'system' }
    assert.throws(() => {
      t.store.transaction(() => {
        t.service.setTaskStatus(task.id, 'in_progress', actor)
        throw new Error('外层失败，整体回滚')
      })
    }, /外层失败/)
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'todo', '状态未变')
    assert.equal(statusEvents(t, task.id).length, 0, '事件也未落')
  } finally { await t.close() }
})
