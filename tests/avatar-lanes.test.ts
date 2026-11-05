// tests/avatar-lanes.test.js —— DSHBOTS-219 分身通道隔离守门。
// 用户拍板的分身模型：群里的 bot 视作本体分身——独立承担任务、独立交互、互不阻塞。
// 守两条边界：①单聊（含提权/提问 pending 卡住）不阻塞同 bot 的群聊等其它通道；
// ②同一条会话内仍严格串行（原 claimKey 注释意图不回退）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { id, nowIso } from '../src/util.js'

class ManualRuntime { declare started: any[]; declare pendingRuns: any; declare handler: any;
  constructor() { this.started = []; this.pendingRuns = new Map() }
  setCompletionHandler(handler) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { this.started.push(run.id); this.pendingRuns.set(run.id, run); return `session-${run.id}` }
  async steer() { return true }
  async cancelRun() { return true }
  complete(runId, status = 'succeeded', output = 'done') { this.pendingRuns.delete(runId); return this.handler({ runId, status, output, error: null }) }
}

async function laneSetup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-lanes-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = false
  const director = store.get("SELECT * FROM bots WHERE id = (SELECT id FROM bots ORDER BY created_at LIMIT 1)")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  return { root, store, service, runtime, director, dev }
}

// 直插一条 runs 行（键位守门用；不走业务入口，专测 claimKey 的通道推导）。
function seedRun(store, { kind, botId, projectId = null, taskId = null, triggerRef = null, sessionId = null, mode = 'read' }) {
  const runId = id('run')
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
       attempt, idempotency_key, session_id, queued_at)
     VALUES (?, ?, ?, ?, ?, ?, 'seed', ?, 'queued', 1, ?, ?, ?)`,
    runId, projectId, botId, taskId, kind, mode, triggerRef, `seed:${runId}`, sessionId, nowIso(),
  )
  return store.get('SELECT * FROM runs WHERE id = ?', runId)
}

async function cleanup(root, store) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

test('claimKey 键位守门：每类运行映射到自己的会话通道，同会话同键', async () => {
  const { root, store, service, director, dev } = await laneSetup()
  try {
    const project = await service.createProject({ name: 'Lane', key: 'LANE', ownerBotId: director.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: '键位任务', assigneeBotId: dev.id })
    // review/handle 各占一条任务（one_active_run_per_task 唯一索引：同 task 只能有一条 queued/running）。
    const reviewTask = await service.createTask({ projectId: project.id, title: '验收任务', assigneeBotId: dev.id })
    const handleTask = await service.createTask({ projectId: project.id, title: '受阻任务', assigneeBotId: dev.id })
    const key = (run) => service.claimKey(run)

    // 任务道：任务运行与其派生（retry 等 task_id 同源）同键。
    assert.equal(key(seedRun(store, { kind: 'task', botId: dev.id, projectId: project.id, taskId: task.id, mode: 'write' })), `task:${task.id}`)
    // 群聊 / 验收 / 受阻处理 / 记忆审查 / 带项目读图：项目会话道。
    assert.equal(key(seedRun(store, { kind: 'chat', botId: dev.id, projectId: project.id })), `project:${dev.id}:${project.id}`)
    assert.equal(key(seedRun(store, { kind: 'review', botId: director.id, projectId: project.id, taskId: reviewTask.id })), `project:${director.id}:${project.id}`)
    assert.equal(key(seedRun(store, { kind: 'handle', botId: director.id, projectId: project.id, taskId: handleTask.id })), `project:${director.id}:${project.id}`)
    assert.equal(key(seedRun(store, { kind: 'memory_review', botId: dev.id, projectId: project.id })), `project:${dev.id}:${project.id}`)
    assert.equal(key(seedRun(store, { kind: 'vision', botId: dev.id, projectId: project.id })), `project:${dev.id}:${project.id}`)
    // 单聊道：solo_chat 与无项目读图同键（同一 solo 会话），与项目道互斥分离。
    assert.equal(key(seedRun(store, { kind: 'solo_chat', botId: dev.id, mode: 'write' })), `solo:${dev.id}`)
    assert.equal(key(seedRun(store, { kind: 'vision', botId: dev.id })), `solo:${dev.id}`)
    // 私信道。
    assert.equal(key(seedRun(store, { kind: 'dm', botId: dev.id, projectId: project.id })), `dm:${dev.id}:${project.id}`)
  } finally {
    await cleanup(root, store)
  }
})

test('claimKey 键位守门：dm_reply 按来信 origin 归道，rollover_summary 按旧会话绑定归道', async () => {
  const { root, store, service, director, dev } = await laneSetup()
  try {
    const project = await service.createProject({ name: 'Origin', key: 'ORG', ownerBotId: director.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: 'origin 任务', assigneeBotId: dev.id })
    const seedDm = (originKind, originTaskId = null) => {
      const messageId = id('bm')
      store.run(
        `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_kind, origin_task_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, '来信', ?, ?, 'replied', ?)`,
        messageId, project.id, director.id, dev.id, `req-${messageId}`, originKind, originTaskId, nowIso(),
      )
      return seedRun(store, { kind: 'dm_reply', botId: director.id, projectId: project.id, triggerRef: messageId })
    }
    assert.equal(service.claimKey(seedDm('task', task.id)), `task:${task.id}`, 'dm_reply 回任务会话应归任务道')
    assert.equal(service.claimKey(seedDm('dm')), `dm:${director.id}:${project.id}`, 'dm_reply 回私信会话应归私信道')
    assert.equal(service.claimKey(seedDm('project')), `project:${director.id}:${project.id}`, 'dm_reply 回项目会话应归项目道')

    // rollover_summary 复用的旧会话还挂着项目绑定时，与该项目的群聊同道（防同会话并发）；
    // 绑定已不存在时退到会话自身键（没有别的运行会撞上）。
    const sessionId = `sess-${id('roll')}`
    store.run(
      "INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, 'project', NULL, ?)",
      sessionId, director.id, project.id, nowIso(),
    )
    const bound = seedRun(store, { kind: 'rollover_summary', botId: director.id, projectId: project.id, sessionId })
    assert.equal(service.claimKey(bound), `project:${director.id}:${project.id}`, 'rollover_summary 应与复用会话的通道对齐')
    store.run('DELETE FROM session_bindings WHERE session_id = ?', sessionId)
    assert.equal(service.claimKey(bound), `session:${sessionId}`, '绑定已删的 rollover_summary 退到会话键')
  } finally {
    await cleanup(root, store)
  }
})

test('单聊 pending 卡住不阻塞同 bot 群聊与跨项目分身，同 bot 第二条单聊仍串行', async () => {
  const { root, store, service, director, dev } = await laneSetup()
  try {
    const alpha = await service.createProject({ name: 'Alpha', key: 'ALP', ownerBotId: director.id, memberIds: [dev.id] })
    const beta = await service.createProject({ name: 'Beta', key: 'BET', ownerBotId: director.id, memberIds: [dev.id] })
    // 单聊先跑起来（ManualRuntime 不收尾即模拟卡在提权/提问 pending）。
    await service.sendSoloMessage(dev.id, '单聊里申请提权')
    await service.sendSoloMessage(dev.id, '单聊追问第二条')
    // 同 bot 在两个项目的群聊（两个分身）。
    await service.sendMessage(alpha.id, '@Builder 甲项目问一句')
    await service.sendMessage(beta.id, '@Builder 乙项目也问一句')

    service.started = true
    await service.tick()

    const running = store.all("SELECT * FROM runs WHERE status = 'running'")
    const runningKinds = running.map(row => `${row.kind}:${row.bot_id}:${row.project_id ?? 'solo'}`)
    assert.ok(running.some(row => row.kind === 'solo_chat' && row.bot_id === dev.id), '首条单聊应运行中')
    assert.ok(running.some(row => row.kind === 'chat' && row.project_id === alpha.id), '单聊卡住时甲项目群聊应并行启动')
    assert.ok(running.some(row => row.kind === 'chat' && row.project_id === beta.id), '跨项目分身群聊也应并行启动')
    assert.equal(running.filter(row => row.kind === 'solo_chat' && row.bot_id === dev.id).length, 1, '同 bot 同时只有一条单聊在跑')
    const queuedSolo = store.all("SELECT * FROM runs WHERE status = 'queued' AND kind = 'solo_chat'")
    assert.equal(queuedSolo.length, 1, '第二条单聊应留在 solo 通道排队')
    assert.equal(running.length, 3, '恰好三条分身运行（1 单聊 + 2 群聊）')
  } finally {
    await cleanup(root, store)
  }
})

test('私信与群聊同道分离：dm 运行不阻塞群聊，第二条 dm 在 dm 通道排队', async () => {
  const { root, store, service, director, dev } = await laneSetup()
  try {
    const project = await service.createProject({ name: 'DmLane', key: 'DML', ownerBotId: director.id, memberIds: [dev.id] })
    const seedDmMessage = () => {
      const messageId = id('bm')
      store.run(
        `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_kind, status, created_at)
         VALUES (?, ?, ?, ?, ?, '来信', 'project', 'pending', ?)`,
        messageId, project.id, director.id, dev.id, `req-${messageId}`, nowIso(),
      )
      return store.get('SELECT * FROM bot_messages WHERE id = ?', messageId)
    }
    service.enqueueDmRun(seedDmMessage(), dev)
    service.enqueueDmRun(seedDmMessage(), dev)
    await service.sendMessage(project.id, '@Builder 群里同步一句')

    service.started = true
    await service.tick()

    const running = store.all("SELECT * FROM runs WHERE status = 'running'")
    assert.equal(running.filter(row => row.kind === 'dm' && row.bot_id === dev.id).length, 1, 'dm 通道同时只有一条在跑')
    assert.ok(running.some(row => row.kind === 'chat' && row.bot_id === dev.id), 'dm 运行不应阻塞同 bot 群聊')
    assert.ok(store.get("SELECT 1 FROM runs WHERE kind = 'dm' AND status = 'queued'"), '第二条 dm 应排队')
  } finally {
    await cleanup(root, store)
  }
})

test('同会话串行不回退：总监验收运行占项目通道时，同项目群聊排队等待', async () => {
  const { root, store, service, director, dev } = await laneSetup()
  try {
    const project = await service.createProject({ name: 'Serial', key: 'SRL', ownerBotId: director.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: '待验收', assigneeBotId: dev.id })
    // 总监验收运行（review，落总监的项目会话）先入队。
    service.enqueueOwnerTaskRun(task, 'review')
    // 同项目 @总监 的群聊（同一会话）随后入队。
    const messageId = service.insertMessage({
      projectId: project.id, senderType: 'user', senderId: service.localUserId,
      body: '@director 群里问总监', mentions: [director.id],
    })
    service.enqueueChatRun(project, director, messageId)

    service.started = true
    await service.tick()

    const running = store.all("SELECT * FROM runs WHERE status = 'running'")
    assert.equal(running.length, 1, '同一条会话上一次只放一条')
    assert.equal(running[0].kind, 'review', '先入队的验收运行先跑')
    const chat = store.get("SELECT * FROM runs WHERE kind = 'chat' AND status = 'queued'")
    assert.ok(chat, '同会话群聊应排队，不能因通道解耦并发进同一会话')
  } finally {
    await cleanup(root, store)
  }
})
