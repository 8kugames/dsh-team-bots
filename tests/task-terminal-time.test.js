import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { ensureTaskTerminalTimeBackfill } from '../src/services/tasks.js'

// DSHBOTS-69：createTask 以终态（done/canceled）建档时在创建侧补齐终态时间列，
// 与 updateTask 的对称维护同口径；历史空行由 tasks_terminal_time_backfill 回填，仅补空、幂等。

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-terminal-'))
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

async function primeProject(service) {
  const director = service.store.get("SELECT * FROM bots WHERE name = 'director'")
  return service.createProject({ name: 'Task Terminal', key: 'TASKTERM', ownerBotId: director.id })
}

const rowOf = (store, id) => store.get('SELECT * FROM tasks WHERE id = ?', id)

test('以 done 建档：completed_at 取同一 created_at，canceled_at 为空', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(service)
    const task = await service.createTask({ projectId: project.id, title: '生而完成', status: 'done' }, service.actor())
    const row = rowOf(store, task.id)
    assert.ok(row.completed_at, 'done 建档应写 completed_at')
    assert.equal(row.completed_at, row.created_at, 'completed_at 应取同一 created_at')
    assert.equal(row.canceled_at, null, 'done 与 canceled 互斥：canceled_at 应为空')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('以 canceled 建档：canceled_at 取同一 created_at，completed_at 为空', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(service)
    const task = await service.createTask({ projectId: project.id, title: '生而取消', status: 'canceled' }, service.actor())
    const row = rowOf(store, task.id)
    assert.ok(row.canceled_at, 'canceled 建档应写 canceled_at')
    assert.equal(row.canceled_at, row.created_at, 'canceled_at 应取同一 created_at')
    assert.equal(row.completed_at, null, 'canceled 与 done 互斥：completed_at 应为空')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('默认建档（非终态）：两列终态时间均为 NULL', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(service)
    const task = await service.createTask({ projectId: project.id, title: '普通任务' }, service.actor())
    const row = rowOf(store, task.id)
    assert.equal(row.completed_at, null, '非终态建档 completed_at 应为空')
    assert.equal(row.canceled_at, null, '非终态建档 canceled_at 应为空')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('回填迁移：done 空行补 completed_at=updated_at，已有值不动，幂等可重跑', async () => {
  const { root, store, service } = await setup()
  try {
    const project = await primeProject(service)
    const stamp = '2026-10-01T00:00:00.000Z'
    // 手工插两行迁移前的存量：dirty 缺 completed_at 待回填，kept 已有值不得被覆盖。
    store.run(
      `INSERT INTO tasks(id, project_id, number, title, status, creator_type, creator_id, created_at, updated_at)
       VALUES ('task_dirty_done', ?, 999, '脏行', 'done', 'user', 'u', ?, ?)`,
      project.id, stamp, stamp,
    )
    store.run(
      `INSERT INTO tasks(id, project_id, number, title, status, creator_type, creator_id, created_at, updated_at, completed_at)
       VALUES ('task_kept_done', ?, 998, '已有值', 'done', 'user', 'u', ?, ?, '1999-01-01T00:00:00.000Z')`,
      project.id, stamp, stamp,
    )
    // initialize() 已登记过迁移名：先抹掉，模拟迁移前的库再跑。
    store.run("DELETE FROM schema_migrations WHERE name = 'tasks_terminal_time_backfill'")

    ensureTaskTerminalTimeBackfill(store)

    assert.equal(rowOf(store, 'task_dirty_done').completed_at, stamp, '空行应回填 completed_at=updated_at')
    assert.equal(rowOf(store, 'task_kept_done').completed_at, '1999-01-01T00:00:00.000Z', '已有值的行绝不被覆盖')
    assert.equal(
      store.get('SELECT 1 AS ok FROM schema_migrations WHERE name = ?', 'tasks_terminal_time_backfill')?.ok, 1,
      '迁移名应登记',
    )

    // 幂等：带登记重跑直接短路；抹掉登记再跑也只碰空行，两行值均不变。
    ensureTaskTerminalTimeBackfill(store)
    store.run("DELETE FROM schema_migrations WHERE name = 'tasks_terminal_time_backfill'")
    ensureTaskTerminalTimeBackfill(store)
    assert.equal(rowOf(store, 'task_dirty_done').completed_at, stamp, '重跑不改变已回填的值')
    assert.equal(rowOf(store, 'task_kept_done').completed_at, '1999-01-01T00:00:00.000Z', '重跑仍不覆盖已有值')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
