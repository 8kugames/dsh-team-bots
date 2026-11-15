import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// 手动完成的 runtime：sessionBusy 可切换，steer 记录入数组。
class ManualRuntime { declare started: any[]; declare steers: any[]; declare busySessions: any; declare handler: any; declare store: any;
  constructor() {
    this.started = []
    this.steers = []
    this.busySessions = new Set()
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  sessionBusy(sessionId) { return this.busySessions.has(sessionId) }

  // 任务亲和绑定解析（对齐 src/services/runtime/session.ts 同名方法，DSHBOTS-286 亲和路由）：
  // 回信投递按 runs.session_id 归位原任务会话；终态任务/无运行归属不享亲和。
  taskAffinityBinding(task) {
    if (!task?.id) return undefined
    if (task.status === 'done' || task.status === 'canceled') return undefined
    const row = this.store.get(
      `SELECT session_id AS sid FROM runs
        WHERE task_id = ? AND session_id IS NOT NULL
        ORDER BY COALESCE(started_at, queued_at) DESC, rowid DESC LIMIT 1`,
      task.id,
    )
    if (!row?.sid) return undefined
    return this.store.get('SELECT * FROM session_bindings WHERE session_id = ?', row.sid)
  }

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
  // 任务的原执行运行（已终态，不占 builder 的活跃槽）：任务亲和绑定经 runs.session_id
  // 解析回这条会话（控制面收敛后 dm 回信仍按亲和优先归位）。
  const seededAt = new Date().toISOString()
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, attempt, idempotency_key, session_id, queued_at, ended_at)
     VALUES ('run_dm_seed', ?, ?, ?, 'task', 'write', 'test', 'succeeded', 1, 'seed:dm_fixture', ?, ?, ?)`,
    project.id, builder.id, task.id, originSession, seededAt, seededAt,
  )
  runtime.store = store
  return { root, store, service, runtime, project, builder, task, originSession }
}

// DSHBOTS-308 域化：挂起队列按 (bot, 域) 分键存放（bot_pending_msgs:<bot>:<domain>），
// 断言需跨域扫描合并本 bot 的全部域队列（不再有单一无域键）。
const heldItems = (store, botId) => {
  const rows = store.all("SELECT key, value FROM settings WHERE key LIKE ?", `bot_pending_msgs:${botId}:%`)
  const out = []
  for (const row of rows) {
    if (!row.key.startsWith(`bot_pending_msgs:${botId}:`)) continue
    const arr = JSON.parse(row.value ?? '[]')
    if (Array.isArray(arr)) out.push(...arr)
  }
  return out
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
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const first = service.messageFromBot({ sessionId: originSession, toName: 'director', requestId: 'ask-auth', textBody: '登录接口返回结构是什么？' })
    assert.equal(first.created, true)
    assert.equal(first.status, 'delivered')
    const again = service.messageFromBot({ sessionId: originSession, toName: 'director', requestId: 'ask-auth', textBody: '登录接口返回结构是什么？' })
    assert.equal(again.created, false)
    assert.equal(again.status, 'delivered')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM bot_messages').n, 1)
    // 同一 request_id 换内容是语义碰撞：直接报冲突，避免新问题被旧请求静默吞掉。
    assert.throws(
      () => service.messageFromBot({ sessionId: originSession, toName: 'director', requestId: 'ask-auth', textBody: '再问一次' }),
      (error: any) => error?.status === 409 && /ask-auth/.test(error?.message ?? ''),
    )

    await service.tick()
    const dmRun = store.get("SELECT * FROM runs WHERE kind = 'dm'")
    assert.ok(dmRun, 'dm run 应已入队')
    assert.equal(dmRun.trigger_ref, store.get('SELECT id FROM bot_messages').id)
    assert.equal(dmRun.bot_id, director.id)
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
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    service.messageFromBot({ sessionId: originSession, toName: 'director', requestId: 'busy-ask', textBody: '在吗' })
    await service.tick()
    const dmRun = store.get("SELECT * FROM runs WHERE kind = 'dm'")
    runtime.busySessions.add(originSession)
    await runtime.complete(dmRun.id, 'succeeded', '在的')
    assert.equal(runtime.steers.length, 1, '忙时应 steer 而不是排运行')
    assert.match(runtime.steers[0].text, /Reply from director/)
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
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    store.run(
      `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_session_id, origin_kind, status, created_at)
       VALUES ('botm_dead1', ?, ?, ?, 'dead-ask', '在吗', ?, 'task', 'pending', ?)`,
      project.id, builder.id, director.id, originSession, new Date().toISOString(),
    )
    store.run("UPDATE bots SET status = 'archived' WHERE id = ?", director.id)
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

// DSHBOTS-291 覆盖缺口补测①（D-289 红线臂实测发现 dm 逐条放行无覆盖）：
// 同一 bot 忙时挂起多条 dm，空闲 drain 后同一 tick 只放行一条（回信契约），余量留队列下一拍。
test('dm 逐条放行：忙时挂起多条，drain 同一 tick 只建一条运行，余量留队列', async () => {
  const state = await setup()
  globalThis.DM_ROOT = state.root
  try {
    const { store, service, project, builder, originSession } = state
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    // 总监忙：占一条 running 运行。
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
       VALUES ('run_dm_busy', ?, ?, 'chat', 'read', 'test', 'running', 1, 'busy:dm_one_by_one', ?)`,
      project.id, director.id, new Date().toISOString(),
    )
    const insertDm = (id: string) => {
      store.run(
        `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_session_id, origin_kind, status, created_at)
         VALUES (?, ?, ?, ?, ?, '在吗', ?, 'task', 'pending', ?)`,
        id, project.id, builder.id, director.id, `req-${id}`, originSession, new Date().toISOString(),
      )
      return store.get('SELECT * FROM bot_messages WHERE id = ?', id)
    }
    const pending = () => heldItems(store, director.id)
    // DSHBOTS-308 域化：dm 的串行域 = 私信所属工作区（message.project_id ?? '~solo'），
    // 本例私信都带 project_id → 挂起项落在该项目的域键上。
    const domainKey = `bot_pending_msgs:${director.id}:${project.id}`
    for (const mid of ['botm_dm1', 'botm_dm2', 'botm_dm3']) {
      assert.equal(service.enqueueDmRun(insertDm(mid), director), null, '忙时 dm 不落 runs 行，挂待处理队列')
    }
    assert.equal(pending().length, 3, '三条 dm 全部挂起')
    assert.equal(JSON.parse(store.setting(domainKey) ?? '[]').length, 3, '挂起项记在本工作区域键下')

    // 总监空闲：drain 只放行一条，两条留队列。
    store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = 'run_dm_busy'", new Date().toISOString())
    service.drainPendingMessages()
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE kind = 'dm'")?.n, 1, '同一 tick 只放行一条 dm')
    assert.equal(pending().length, 2, '余量留队列下一拍')

    // 下一拍：第一条终态后再放行第二条。
    store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE kind = 'dm'", new Date().toISOString())
    service.drainPendingMessages()
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE kind = 'dm'")?.n, 2, '下一拍再放行一条')
    assert.equal(pending().length, 1, '最后一条仍在队列')

    // DSHBOTS-308 域化反转：占道运行在「本工作区」域上，另一工作区的私信属他域，
    // 不被本域占道阻塞——直接落 runs 行，且不混入本域挂起队列。
    const other = await service.createProject({ name: 'Beta', key: 'BETA', memberIds: [builder.id] })
    store.run(
      `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_session_id, origin_kind, status, created_at)
       VALUES ('botm_dm_other', ?, ?, ?, 'req-other', '在吗', ?, 'task', 'pending', ?)`,
      other.id, builder.id, director.id, originSession, new Date().toISOString(),
    )
    const otherRunId = service.enqueueDmRun(store.get('SELECT * FROM bot_messages WHERE id = ?', 'botm_dm_other'), director)
    assert.ok(otherRunId, '跨域私信不被本域占道阻塞，直接落 runs 行')
    assert.equal(store.get('SELECT project_id FROM runs WHERE id = ?', otherRunId).project_id, other.id)
    assert.equal(pending().length, 1, '跨域私信不入本域挂起队列，本域挂起项原样保留')
  } finally {
    await closeQuietly(state.store)
  }
})

// DSHBOTS-291 覆盖缺口补测②（messageId 去重 + 建回护栏）：同一 bot 忙时重复入队同一
// messageId，队列不累积重复项。DSHBOTS-304 语义更新：挂起项之外已存在同 idempotency_key
// 运行（终态也算，双投胜利方已处理）时，drain 去重清扫直接消账该挂起项——旧口径「撞
// UNIQUE 返 null 留队列」即永生占位缺陷（每 tick 队头 break 阻塞该 bot 全部挂起组），已修。
test('messageId 去重：忙时重复挂起不累积；同幂等键运行已存在时挂起项清扫消账不永生', async () => {
  const state = await setup()
  globalThis.DM_ROOT = state.root
  try {
    const { store, service, project, builder, originSession } = state
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
       VALUES ('run_dup_busy', ?, ?, 'chat', 'read', 'test', 'running', 1, 'busy:dm_dedup', ?)`,
      project.id, director.id, new Date().toISOString(),
    )
    store.run(
      `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_session_id, origin_kind, status, created_at)
       VALUES ('botm_dup1', ?, ?, ?, 'req-dup', '在吗', ?, 'task', 'pending', ?)`,
      project.id, builder.id, director.id, originSession, new Date().toISOString(),
    )
    const message = store.get('SELECT * FROM bot_messages WHERE id = ?', 'botm_dup1')
    // DSHBOTS-308 域化：挂起队列按域分键，去重断言跨域扫描本 bot 的全部域队列。
    const pending = () => heldItems(store, director.id)
    assert.equal(service.enqueueDmRun(message, director), null)
    assert.equal(service.enqueueDmRun(message, director), null, '重复入队同一 messageId 同样挂起')
    assert.equal(pending().length, 1, '队列不累积重复项')
    assert.equal(
      JSON.parse(store.setting(`bot_pending_msgs:${director.id}:${project.id}`) ?? '[]').length,
      1,
      '挂起项记在本工作区域键下',
    )

    // DSHBOTS-304：挂起项之外已存在同 idempotency_key 的运行（终态也算）＝双投胜利方已
    // 处理该消息，失败方挂起副本作废——drain 清扫消账，不留永生占位，也不重复建行。
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, queued_at, ended_at)
       VALUES ('run_dup_collide', ?, ?, 'dm', 'read', 'dm', 'botm_dup1', 'succeeded', 1, 'dm:botm_dup1', ?, ?)`,
      project.id, director.id, new Date().toISOString(), new Date().toISOString(),
    )
    store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = 'run_dup_busy'", new Date().toISOString())
    service.drainPendingMessages()
    assert.equal(pending().length, 0, '同幂等键运行已存在：挂起副本清扫消账（不永生）')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM runs WHERE trigger_ref = 'botm_dup1' AND status IN ('queued', 'running')")?.n,
      0,
      '没有为重复挂起项建出第二条活跃运行',
    )
  } finally {
    await closeQuietly(state.store)
  }
})
