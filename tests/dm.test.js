import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// 手动完成的 runtime：sessionBusy 可切换，steer 记录入数组。
class ManualRuntime {
  constructor() {
    this.started = []
    this.steers = []
    this.busySessions = new Set()
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  sessionBusy(sessionId) { return this.busySessions.has(sessionId) }

  async startRun({ run }) {
    this.started.push({ runId: run.id, kind: run.kind, botId: run.bot_id })
    return `session-${run.id}`
  }

  async steer(sessionId, text) {
    this.steers.push({ sessionId, text })
    return true
  }

  async cancelRun() { return true }

  complete(runId, status = 'succeeded', output = 'done') {
    return this.handler({ runId, status, output, error: null })
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-dm-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = false
  const builder = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Alpha', key: 'ALPHA', memberIds: [builder.id] })
  // Builder 的任务会话绑定：私信从这条会话发起。
  const originSession = 'sess-builder-task-1'
  const task = await service.createTask({ projectId: project.id, title: '做登录页', description: 'x', assigneeBotId: builder.id }, { type: 'user', id: 'u' })
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
     VALUES (?, ?, ?, 'task', ?, ?)`,
    originSession, builder.id, project.id, task.id, new Date().toISOString(),
  )
  return { root, store, service, runtime, project, builder, task, originSession }
}

async function closeQuietly(store, timeout = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      const active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
      if (active === 0) break
    } catch { break }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  store.db.close()
  await rm(globalThis.DM_ROOT, { recursive: true, force: true })
}

test('messageFromBot 建立幂等私信并驱动 dm 运行与空闲投递', async () => {
  const state = await setup()
  globalThis.DM_ROOT = state.root
  try {
    const { store, service, runtime, builder, originSession, task } = state
    const chief = store.get("SELECT * FROM bots WHERE name = 'chief'")
    const first = service.messageFromBot({ sessionId: originSession, toName: 'chief', requestId: 'ask-auth', textBody: '登录接口返回结构是什么？' })
    assert.equal(first.created, true)
    assert.equal(first.status, 'delivered')
    const again = service.messageFromBot({ sessionId: originSession, toName: 'chief', requestId: 'ask-auth', textBody: '登录接口返回结构是什么？' })
    assert.equal(again.created, false)
    assert.equal(again.status, 'delivered')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM bot_messages').n, 1)
    // 同一 request_id 换内容是语义碰撞：直接报冲突，避免新问题被旧请求静默吞掉。
    assert.throws(
      () => service.messageFromBot({ sessionId: originSession, toName: 'chief', requestId: 'ask-auth', textBody: '再问一次' }),
      error => error?.status === 409 && /ask-auth/.test(error?.message ?? ''),
    )

    await service.tick()
    const dmRun = store.get("SELECT * FROM runs WHERE kind = 'dm'")
    assert.ok(dmRun, 'dm run 应已入队')
    assert.equal(dmRun.trigger_ref, store.get('SELECT id FROM bot_messages').id)
    assert.equal(dmRun.bot_id, chief.id)
    // dm/dm_reply 运行不携带 task_id（one_active_run_per_task 不限 kind）。
    assert.equal(dmRun.task_id, null)

    await runtime.complete(dmRun.id, 'succeeded', '返回 { code, token }')
    const row = store.get('SELECT * FROM bot_messages')
    assert.equal(row.status, 'replied')
    assert.equal(row.reply, '返回 { code, token }')

    // 发起方任务会话空闲：应排 dm_reply 运行而非 steer。
    await service.tick()
    const replyRun = store.get("SELECT * FROM runs WHERE kind = 'dm_reply'")
    assert.ok(replyRun, '空闲时应排 dm_reply 运行')
    assert.equal(replyRun.bot_id, builder.id)
    assert.equal(replyRun.task_id, null)
    assert.equal(runtime.steers.length, 0)
    await runtime.complete(replyRun.id, 'succeeded', '收到')
  } finally {
    await closeQuietly(state.store)
  }
})

test('发起会话正忙时回信走 steer 注入', async () => {
  const state = await setup()
  globalThis.DM_ROOT = state.root
  try {
    const { store, service, runtime, originSession } = state
    const chief = store.get("SELECT * FROM bots WHERE name = 'chief'")
    service.messageFromBot({ sessionId: originSession, toName: 'chief', requestId: 'busy-ask', textBody: '在吗' })
    await service.tick()
    const dmRun = store.get("SELECT * FROM runs WHERE kind = 'dm'")
    runtime.busySessions.add(originSession)
    await runtime.complete(dmRun.id, 'succeeded', '在的')
    assert.equal(runtime.steers.length, 1, '忙时应 steer 而不是排运行')
    assert.match(runtime.steers[0].text, /Reply from chief/)
    assert.match(runtime.steers[0].text, /在的/)
    assert.equal(runtime.steers[0].sessionId, originSession)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE kind = 'dm_reply'")?.n, 0)
  } finally {
    await closeQuietly(state.store)
  }
})

test('自私信与非成员被拒，目标不可用时私信失败留痕', async () => {
  const state = await setup()
  globalThis.DM_ROOT = state.root
  try {
    const { store, service, originSession, project, builder } = state
    assert.throws(() => service.messageFromBot({ sessionId: originSession, toName: 'Builder', requestId: 'x', textBody: '自言自语' }), /不能给自己发私信/)
    assert.throws(() => service.messageFromBot({ sessionId: originSession, toName: 'nobody', requestId: 'x', textBody: '你是谁' }), /没有叫 nobody 的成员/)
    // 重试路径：直接落一条 pending 私信与 pending outbox（模拟投递失败后待重试），
    // 目标已被归档 → applyOutboxRow 应把私信置 failed 并留痕，而不是排运行。
    const chief = store.get("SELECT * FROM bots WHERE name = 'chief'")
    store.run(
      `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_session_id, origin_kind, status, created_at)
       VALUES ('botm_dead1', ?, ?, ?, 'dead-ask', '在吗', ?, 'task', 'pending', ?)`,
      project.id, builder.id, chief.id, originSession, new Date().toISOString(),
    )
    store.run("UPDATE bots SET status = 'archived' WHERE id = ?", chief.id)
    store.run(
      `INSERT INTO outbox(id, kind, project_id, idempotency_key, payload_json, status, attempts, available_at, created_at)
       VALUES ('out_dead1', 'dm_run', ?, 'dm_run:botm_dead1', ?, 'pending', 0, ?, ?)`,
      project.id, JSON.stringify({ messageId: 'botm_dead1' }), new Date().toISOString(), new Date().toISOString(),
    )
    service.applyOutboxRow(store.get("SELECT * FROM outbox WHERE id = 'out_dead1'"))
    const row = store.get("SELECT * FROM bot_messages WHERE request_id = 'dead-ask'")
    assert.equal(row.status, 'failed')
    assert.match(row.reply, /目标 Bot 不可用/)
  } finally {
    await closeQuietly(state.store)
  }
})
