import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { handleAction } from '../src/api.js'

// 只需要 runtime 存在即可：成员管理本身不启动 run，usage 用直接落库的 run 行验证聚合。
class StubRuntime {
  constructor() {
    this.models = [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a', name: 'Model A',
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
  }
  setCompletionHandler() {}
  async catalog() { return this.models }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-members-test-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service }
}

function insertRun(store, { id: runId, projectId, botId, status = 'succeeded', usage = {} }) {
  const ts = new Date().toISOString()
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, trigger_type, status, idempotency_key, queued_at, started_at, ended_at,
       usage_input, usage_cache_read, usage_cache_write, usage_output, usage_cost)
     VALUES (?, ?, ?, 'task', 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    runId, projectId, botId, status, `idem-${runId}`, ts, ts, ts,
    usage.input ?? 0, usage.cacheRead ?? 0, usage.cacheWrite ?? 0, usage.output ?? 0, usage.cost ?? 0,
  )
}

test('add_member / remove_member manage membership with precise error semantics', async () => {
  const { root, store, service } = await setup()
  try {
    const actor = { type: 'user', id: 'owner' }
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const builder = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build things.' })
    const project = await service.createProject({ name: 'Demo Project', key: 'DEMO', ownerBotId: director.id })

    // 邀请新成员：零值起步，busy=false、usage 全 0（含 0 值成员不缺行）
    const added = await handleAction(service, 'add_member', { projectId: project.id, botId: builder.id }, actor)
    const member = added.members.find(row => row.id === builder.id)
    assert.ok(member, 'added member should appear in project view')
    assert.equal(member.member_role, 'member')
    assert.equal(member.busy, false)
    assert.equal(member.usage_input, 0)
    assert.equal(member.usage_output, 0)
    assert.equal(member.usage_cost, 0)

    // 重复添加 → 409
    await assert.rejects(
      () => handleAction(service, 'add_member', { projectId: project.id, botId: builder.id }, actor),
      err => err.code === 'CONFLICT',
    )
    // 不存在的 bot → 404
    await assert.rejects(
      () => handleAction(service, 'add_member', { projectId: project.id, botId: 'bot_missing' }, actor),
      err => err.code === 'NOT_FOUND',
    )
    // 归档 bot 不可邀请 → 400
    const archived = await service.createBot({ name: 'Retired', role: '开发', instructions: 'None.' })
    await service.archiveBot(archived.id, actor)
    await assert.rejects(
      () => handleAction(service, 'add_member', { projectId: project.id, botId: archived.id }, actor),
      err => err.code === 'BAD_REQUEST',
    )
    // 移除非成员 → 404；总监不可移除 → 403
    await assert.rejects(
      () => handleAction(service, 'remove_member', { projectId: project.id, botId: archived.id }, actor),
      err => err.code === 'NOT_FOUND',
    )
    await assert.rejects(
      () => handleAction(service, 'remove_member', { projectId: project.id, botId: director.id }, actor),
      err => err.code === 'FORBIDDEN',
    )

    // 移除成员后不再出现在成员列表（mention 定向随 membersOf 自动失效）
    const removed = await handleAction(service, 'remove_member', { projectId: project.id, botId: builder.id }, actor)
    assert.equal(removed.members.some(row => row.id === builder.id), false)
    assert.equal(service.membersOf(project.id).some(row => row.member_id === builder.id), false)

    // 归档项目不可增删成员 → 400
    await service.archiveProject(project.id, actor)
    await assert.rejects(
      () => handleAction(service, 'add_member', { projectId: project.id, botId: builder.id }, actor),
      err => err.code === 'BAD_REQUEST',
    )
    await assert.rejects(
      () => handleAction(service, 'remove_member', { projectId: project.id, botId: director.id }, actor),
      err => err.code === 'BAD_REQUEST',
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('membersWithUsage aggregates busy state and per-project usage totals', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const builder = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build things.' })
    const idle = await service.createBot({ name: 'Watcher', role: '测试', instructions: 'Watch.' })
    const project = await service.createProject({
      name: 'Usage Project', key: 'USAGE', ownerBotId: director.id, memberIds: [builder.id, idle.id],
    })
    const other = await service.createProject({ name: 'Other Project', key: 'OTHER', ownerBotId: director.id })
    await service.addProjectMember(other.id, builder.id, { type: 'user', id: 'owner' })

    // builder 在本项目两条成功 run（各 input=100/output=50/cacheRead=10/cost=0.01），另有一条属于其他项目的 run
    insertRun(store, { id: 'run-u1', projectId: project.id, botId: builder.id, usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.01 } })
    insertRun(store, { id: 'run-u2', projectId: project.id, botId: builder.id, usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.01 } })
    insertRun(store, { id: 'run-x1', projectId: other.id, botId: builder.id, usage: { input: 999, output: 999, cost: 9 } })
    // director 有一条排队中的 run → busy
    insertRun(store, { id: 'run-q1', projectId: project.id, botId: director.id, status: 'queued' })

    const members = service.projectView(service.projectRow(project.id)).members
    const builderRow = members.find(row => row.id === builder.id)
    const directorRow = members.find(row => row.id === director.id)
    const idleRow = members.find(row => row.id === idle.id)

    // 只聚合本项目：两条 run 的和，其他项目的不算
    assert.equal(builderRow.usage_input, 200)
    assert.equal(builderRow.usage_output, 100)
    assert.equal(builderRow.usage_cache_read, 20)
    assert.equal(builderRow.usage_cache_write, 10)
    assert.ok(Math.abs(builderRow.usage_cost - 0.02) < 1e-9)
    assert.equal(builderRow.busy, false)

    // 排队中 → 任务中
    assert.equal(directorRow.busy, true)
    assert.equal(directorRow.usage_input, 0)

    // 无 run 的成员照常出现且全 0
    assert.ok(idleRow)
    assert.equal(idleRow.usage_input, 0)
    assert.equal(idleRow.usage_cost, 0)
    assert.equal(idleRow.busy, false)

    // owner 排在成员列表最前
    assert.equal(members[0].id, director.id)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
