// tests/dispatch-policy-gate.test.ts —— DSHBOTS-314 派单策略闸。
// 写卡（write_scopes 非空）派 file_policy=read-only 的 bot 在 assignFromBot 两路（新卡/
// 重派）入口 badRequest 拒绝并回执指引——把「执行到落盘才撞只读沙箱」前移到派单时显式
// 拦截；可写策略放行、无 write_scopes 卡放行、无策略空值按可写放行（兼容存量）。
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
  async startRun({ run }) { this.started.push(run.id); return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dispatch-policy-'))
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
  const ro = await service.createBot({ name: 'Reader', role: '评审', instructions: 'Read.', provider: 'fake', model: 'model-a', filePolicy: 'read-only' })
  const project = await service.createProject({ name: 'Policy', key: 'POL', ownerBotId: director.id, memberIds: [dev.id, ro.id] })
  const sessionId = 'sess-policy-owner'
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  return { root, store, service, director, dev, ro, project, sessionId }
}

async function cleanup(root, service, store) {
  for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
    try { await service.cancelRunInternal(run.id, false) } catch {}
  }
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const rejectsPolicy = (promise, name) => assert.rejects(
  promise,
  (error: { status: number; message: string }) => {
    assert.equal(error.status, 400, 'badRequest 同款错误链')
    assert.match(error.message, new RegExp(`assignee ${name} 为只读策略，不能承接写任务`))
    assert.match(error.message, /改派可写 bot、或调整该 bot 文件策略后重派（DSHBOTS-314 派单策略闸）/)
    return true
  },
)

test('a) 写卡派只读 bot 被拒（新卡路）；b) 同卡派可写 bot 放行', async () => {
  const t = await setup()
  try {
    await rejectsPolicy(t.service.assignFromBot(t.sessionId, {
      assignee: 'Reader', title: '改表结构', description: '迁移脚本。', write_scopes: ['src/db.ts'],
    }), 'Reader')
    const task = await t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', title: '改表结构', description: '迁移脚本。', write_scopes: ['src/db.ts'],
    })
    assert.equal(task.identifier, 'POL-1', '同卡派可写 bot 放行')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('c) 无 write_scopes 卡（纯读）派只读 bot 放行（重派路）', async () => {
  const t = await setup()
  try {
    const task = await t.service.createTask({ projectId: t.project.id, title: '只读评审件', assigneeBotId: t.dev.id })
    const updated = await t.service.assignFromBot(t.sessionId, { assignee: 'Reader', task: 'POL-1' })
    assert.equal(updated.id, task.id, '无声明写范围的重派不受策略闸拦截')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('d) 重派带写范围的卡给只读 bot 同闸被拒；空策略值按可写放行（兼容存量）', async () => {
  const t = await setup()
  try {
    await t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', title: '写范围卡', description: '实施。', write_scopes: ['src/a.js'],
    })
    // 首卡 autoStart 的施工运行占住换负责人闸（D-169 既有口径）：清掉再验证重派闸。
    for (const run of t.store.all("SELECT id FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?) AND status IN ('queued', 'running')", t.project.id)) {
      await t.service.cancelRunInternal(run.id, false)
    }
    await rejectsPolicy(t.service.assignFromBot(t.sessionId, { assignee: 'Reader', task: 'POL-1' }), 'Reader')
    // 存量空值策略：按可写放行（锚：兼容无策略老 bot）。
    t.store.run("UPDATE bots SET file_policy = '' WHERE id = ?", t.ro.id)
    const updated = await t.service.assignFromBot(t.sessionId, { assignee: 'Reader', task: 'POL-1' })
    assert.ok(updated, '空策略值不拦（兼容存量）')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})
