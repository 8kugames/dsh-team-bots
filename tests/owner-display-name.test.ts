// tests/owner-display-name.test.ts —— DSHBOTS-341 守门：本地用户显示名 You→Owner。
// 锁定四件事：
//  ① 初始化后 users.name 与工作台 state().me.name 均为 'Owner'（新库种子与旧库 'You' 收敛两条路都覆盖）；
//  ② 用户消息 messageView senderName='Owner'（时间线/署名全链取 actorName，根改即全改）；
//  ③ owner 评论直通文案含 "from Owner:" 且不含 "from You"；
//  ④ 预置自定义名（'张三'）二次初始化不被覆盖（收敛只认哨兵值）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { nowIso } from '../src/util.js'

class StubRuntime {
  steered: string[] = []
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async steer(_sessionId: string, message: string) { this.steered.push(message) }
}

async function openService(root: string) {
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new StubRuntime()
  service.attachRuntime(runtime)
  return { store, service, runtime, config }
}

async function withService(fn: (ctx: ReturnType<typeof openService> extends Promise<infer T> ? T : never) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-owner-name-'))
  const ctx = await openService(root)
  try {
    await fn(ctx)
  } finally {
    try { ctx.store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

test('初始化后本地用户显示名为 Owner（新库种子与旧库 You 收敛）', async () => {
  await withService(async ({ store, service }) => {
    // 旧库路径：先手写 'You' 哨兵行再初始化，收敛 UPDATE 应翻成 'Owner'。
    store.run(`INSERT INTO users(id, name, role, created_at) VALUES (?, 'You', 'admin', ?)`, service.localUserId, nowIso())
    await service.initialize()
    assert.equal(store.get('SELECT name FROM users WHERE id = ?', service.localUserId)?.name, 'Owner')
    const view = await service.state(null, null)
    assert.equal(view.me.name, 'Owner')
  })
  await withService(async ({ store, service }) => {
    // 新库路径：无预置行，种子直接落 'Owner'。
    await service.initialize()
    assert.equal(store.get('SELECT name FROM users WHERE id = ?', service.localUserId)?.name, 'Owner')
    const view = await service.state(null, null)
    assert.equal(view.me.name, 'Owner')
  })
})

test('用户消息 messageView senderName 为 Owner', async () => {
  await withService(async ({ store, service }) => {
    await service.initialize()
    service.started = true
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
    const project = await service.createProject({ name: 'OwnerName', key: 'OWN', ownerBotId: director.id, memberIds: [dev.id] })
    const messageId = service.insertMessage({ projectId: project.id, senderType: 'user', senderId: service.localUserId, body: '本地用户发言' })
    const row = store.get('SELECT * FROM messages WHERE id = ?', messageId)
    assert.equal(service.messageView(row).senderName, 'Owner')
  })
})

test('owner 评论直通文案为 from Owner 且不含 from You', async () => {
  await withService(async ({ store, service, runtime }) => {
    await service.initialize()
    service.started = true
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
    const project = await service.createProject({ name: 'Steer', key: 'STR', ownerBotId: director.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: '评论直通署名', assigneeBotId: dev.id })
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, attempt, idempotency_key, session_id, queued_at, started_at)
       VALUES (?, ?, ?, ?, 'task', 'write', 'manual', 'running', 1, ?, ?, ?, ?)`,
      'run_steer_1', project.id, dev.id, task.id, 'test:run_steer_1', 'sess_steer_1', nowIso(), nowIso(),
    )
    const result = await service.addComment(task.id, '请把署名改成 Owner', { type: 'user', id: service.localUserId })
    assert.equal(result.steered, true)
    assert.equal(runtime.steered.length, 1)
    assert.match(runtime.steered[0], /from Owner:/)
    assert.doesNotMatch(runtime.steered[0], /from You/)
  })
})

test('预置自定义名二次初始化不被覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-owner-name-'))
  try {
    const first = await openService(root)
    await first.service.initialize()
    first.store.run(`UPDATE users SET name = '张三' WHERE id = ?`, first.service.localUserId)
    first.store.close()
    // 同一数据目录重开服务模拟重启：INSERT ON CONFLICT DO NOTHING 与收敛 UPDATE 都不得覆盖自定义名。
    const second = await openService(root)
    await second.service.initialize()
    assert.equal(second.store.get('SELECT name FROM users WHERE id = ?', second.service.localUserId)?.name, '张三')
    second.store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
