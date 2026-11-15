import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// state() 视图只读数据库，不需要真实 runtime：给一个空的模型目录即可。
class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-stub' }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-panel-limit-test-'))
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

// 直接落库一条任务：需要精确控制 status/position/updated_at 时比走 API 更省事。
function insertTask(store, { id: taskId, projectId, botId, status = 'done', priority = 'medium', position = 0, number: num, updatedAt = new Date().toISOString(), title = '任务' }) {
  store.run(
    `INSERT INTO tasks(id, project_id, number, title, description, status, priority, assignee_bot_id,
      creator_type, creator_id, review_target, position, write_scopes, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, 'user', 'owner', 'user', ?, '[]', 1, ?, ?)`,
    taskId, projectId, num, title, status, priority, botId, position, updatedAt, updatedAt,
  )
}

test('任务面板：state 视图任务全量下发，不按 300 截断，最新任务必须在列', async () => {
  const { root, store, service, director, dev } = await setup()
  try {
    const project = await service.createProject({ name: 'Big 项目', key: 'BIG', ownerBotId: director.id, memberIds: [dev.id] })
    const OLD = '2026-01-01T00:00:00.000Z' // 远超任何时间档窗口：服务端不做时间过滤
    const total = 320
    for (let i = 1; i <= total; i += 1) {
      // 前 300 条用旧时间戳：状态权重同桶下按 position 升序，旧 LIMIT 300 恰好留下这批最旧的
      insertTask(store, { id: `done-${i}`, projectId: project.id, botId: dev.id, status: 'done', position: i, number: i, updatedAt: i <= 300 ? OLD : new Date().toISOString() })
    }
    // 最新创建的一条（position 最大），以及一条远早于 7 天窗口的非终态任务
    insertTask(store, { id: 'task-newest', projectId: project.id, botId: dev.id, status: 'done', position: total + 1, number: total + 1 })
    insertTask(store, { id: 'task-wip-old', projectId: project.id, botId: dev.id, status: 'in_progress', position: 0, number: total + 2, updatedAt: OLD })

    const view = await service.state(project.id)
    assert.equal(view.tasks.length, total + 2, '全量下发：条数等于库内任务总数')
    const ids = new Set(view.tasks.map(task => task.id))
    assert.ok(ids.has('task-newest'), '最新创建的任务必须在列（LIMIT 300 语义下它正是被截掉的那批）')
    assert.ok(ids.has(`done-${total}`), '越过 300 条界线的任务必须在列')
    assert.ok(ids.has('task-wip-old'), '非终态任务不受任何时间窗影响，永远下发')
    assert.ok(ids.has('done-1'), '时间档外的终态任务也随全量下发，7d/30d/全部的裁剪只发生在前端')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
