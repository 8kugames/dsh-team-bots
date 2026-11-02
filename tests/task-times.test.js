import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { ensureTaskTimesSchema } from '../src/services/tasks.js'

// DSHBOTS-34 后端：tasks.canceled_at 迁移与 done/canceled 终态时间戳对称维护。
// 覆盖：状态流转写列/清列、迁移回填只补空行、时间筛选的数据基础（taskView 带列）。

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-times-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service, config }
}

async function primeProject(service) {
  const director = service.store.get("SELECT * FROM bots WHERE name = 'director'")
  return service.createProject({ name: 'Task Times', key: 'TASKTIME', ownerBotId: director.id })
}

const rowOf = (store, id) => store.get('SELECT * FROM tasks WHERE id = ?', id)

test('状态流转对称维护：进终态写列、离开清列、两列互斥', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(service)
    const actor = service.actor()
    const task = await service.createTask({ projectId: project.id, title: '走完全程' }, actor)
    const flow = async status => service.updateTask(task.id, { status }, actor)

    await flow('todo')
    await flow('in_progress')
    await flow('in_review')
    await flow('done')
    let row = rowOf(store, task.id)
    assert.ok(row.completed_at, '进 done 应写 completed_at')
    assert.equal(row.canceled_at, null, 'done 与 canceled 互斥：canceled_at 应为空')

    await flow('todo')
    row = rowOf(store, task.id)
    assert.equal(row.completed_at, null, '离开 done 应清空 completed_at')

    await flow('in_progress')
    await flow('canceled')
    row = rowOf(store, task.id)
    assert.ok(row.canceled_at, '进 canceled 应写 canceled_at')
    assert.equal(row.completed_at, null, '进 canceled 时 completed_at 应为空')

    await flow('todo')
    row = rowOf(store, task.id)
    assert.equal(row.canceled_at, null, '离开 canceled（重开）应清空 canceled_at')
    assert.equal(row.completed_at, null, '重开任务两列皆空')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('迁移回填：canceled_at 仅补空行，已有值不动，幂等可重跑', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(service)
    const actor = service.actor()
    const fresh = await service.createTask({ projectId: project.id, title: '新取消' }, actor)
    const legacy = await service.createTask({ projectId: project.id, title: '老取消' }, actor)
    const kept = await service.createTask({ projectId: project.id, title: '已有值' }, actor)

    // 模拟迁移前的存量：三条都直改成 canceled，legacy 留空待回填，kept 已有值不得被覆盖。
    const stamp = '2026-11-01T08:00:00.000Z'
    store.run("UPDATE tasks SET status = 'canceled', updated_at = ?, canceled_at = NULL WHERE id = ?", stamp, legacy.id)
    store.run("UPDATE tasks SET status = 'canceled', updated_at = ?, canceled_at = '1999-01-01T00:00:00.000Z' WHERE id = ?", stamp, kept.id)
    store.run("UPDATE tasks SET status = 'canceled', updated_at = ?, canceled_at = NULL WHERE id = ?", stamp, fresh.id)
    store.run("DELETE FROM schema_migrations WHERE name = 'tasks_canceled_at'")

    ensureTaskTimesSchema(store)

    assert.equal(rowOf(store, legacy.id).canceled_at, stamp, '空行应回填 canceled_at=updated_at')
    assert.equal(rowOf(store, kept.id).canceled_at, '1999-01-01T00:00:00.000Z', '已有值的行绝不被覆盖')
    assert.equal(
      store.get('SELECT 1 AS ok FROM schema_migrations WHERE name = ?', 'tasks_canceled_at')?.ok, 1,
      '迁移名应登记',
    )

    // 幂等：再跑一遍不产生新变化（空行已不存在）。
    store.run("DELETE FROM schema_migrations WHERE name = 'tasks_canceled_at'")
    ensureTaskTimesSchema(store)
    assert.equal(rowOf(store, kept.id).canceled_at, '1999-01-01T00:00:00.000Z', '重跑仍不覆盖已有值')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('时间筛选数据基础：两列可按 ISO 字典序筛选，taskView 带出 canceled_at', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(service)
    const actor = service.actor()
    const doneTask = await service.createTask({ projectId: project.id, title: '完成的' }, actor)
    const canceledTask = await service.createTask({ projectId: project.id, title: '取消的' }, actor)
    for (const [task, path] of [[doneTask, ['in_progress', 'in_review', 'done']], [canceledTask, ['canceled']]]) {
      await service.updateTask(task.id, { status: 'todo' }, actor)
      for (const status of path) await service.updateTask(task.id, { status }, actor)
    }

    const doneRows = store.all("SELECT id FROM tasks WHERE completed_at >= '2000-01-01T00:00:00.000Z'")
    assert.deepEqual(doneRows.map(row => row.id), [doneTask.id], 'completed_at 支持字典序时间筛选且只命中 done 行')
    const canceledRows = store.all("SELECT id FROM tasks WHERE canceled_at >= '2000-01-01T00:00:00.000Z'")
    assert.deepEqual(canceledRows.map(row => row.id), [canceledTask.id], 'canceled_at 支持字典序时间筛选且只命中 canceled 行')

    const view = service.taskView(rowOf(store, canceledTask.id))
    assert.ok('canceled_at' in view, 'taskView 应平铺带出 canceled_at')
    assert.ok(Number.isFinite(Date.parse(view.canceled_at)), 'canceled_at 是可解析的 ISO 时间')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
