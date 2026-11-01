import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// 手动完成的 runtime：startRun 后运行保持 running，直到测试显式调用 complete。
class ManualRuntime {
  constructor() {
    this.started = []
    this.steers = []
    this.pendingRuns = new Map()
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() { return [] }

  async validateBotConfig() {}

  async startRun({ run, task, sessionKind }) {
    this.started.push({
      runId: run.id,
      botId: run.bot_id,
      taskId: run.task_id ?? null,
      mode: run.mode,
      task: task?.id ?? null,
      sessionKind: sessionKind ?? null,
    })
    this.pendingRuns.set(run.id, run)
    return `session-${run.id}`
  }

  async steer(sessionId, text) {
    this.steers.push({ sessionId, text })
    return true
  }

  async cancelRun() { return true }

  sessionBusy() { return false }

  complete(runId, status = 'succeeded', output = 'done') {
    this.pendingRuns.delete(runId)
    return this.handler({ runId, status, output, error: null })
  }
}

async function manualSetup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-rotation-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({ workspace, dataDir, modelCacheMs: 0, schedulerIntervalMs: 60_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ManualRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  // 关闭自动调度，由测试显式驱动 tick。
  service.started = false
  const chief = store.get("SELECT * FROM bots WHERE name = 'chief'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  return { root, store, service, runtime, chief, dev }
}

// 运行可能仍在异步收尾；关闭数据库前先等队列排空。
async function closeQuietly(store, timeout = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    let active = 0
    try {
      active = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    } catch {
      break
    }
    if (active === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try {
    store.close()
  } catch {}
}

// 手工种一个已逼近窗口上限的任务会话绑定，模拟 runtime 上报的上下文占用。
function insertTaskBinding(store, { sessionId, botId, projectId, taskId }) {
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at, last_ctx_tokens, ctx_window)
     VALUES (?, ?, ?, 'task', ?, ?, 400000, 500000)`,
    sessionId, botId, projectId, taskId, new Date().toISOString(),
  )
  return store.get('SELECT * FROM session_bindings WHERE session_id = ?', sessionId)
}

// 引导到「任务运行被延迟、steward 已排队」的状态，返回相关行。
async function deferWithSteward(ctx, sessionId) {
  const { store, service, chief, dev } = ctx
  const project = await service.createProject({ name: 'Rotate', key: 'ROT', ownerBotId: chief.id, memberIds: [dev.id] })
  await service.createTask({ projectId: project.id, title: '长任务', assigneeBotId: dev.id, autoStart: true })
  const task = store.get('SELECT * FROM tasks WHERE project_id = ?', project.id)
  const binding = insertTaskBinding(store, { sessionId, botId: dev.id, projectId: project.id, taskId: task.id })
  service.started = true
  await service.tick()
  return { project, task, binding }
}

test('上下文达到检查线的任务运行被延迟并触发 steward，重复入队幂等', async () => {
  const ctx = await manualSetup()
  const { store, service, dev } = ctx
  try {
    const { project, task, binding } = await deferWithSteward(ctx, 'session-task-one')

    // 原任务运行回到 queued，并留下 deferred_steward 事件。
    const taskRun = store.get("SELECT * FROM runs WHERE kind = 'task' AND task_id = ?", task.id)
    assert.ok(taskRun)
    assert.equal(taskRun.status, 'queued')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'deferred_steward'", taskRun.id).n,
      1,
    )

    // 出现以旧会话为 trigger 的 steward 运行。
    const stewardRun = store.get("SELECT * FROM runs WHERE kind = 'steward'")
    assert.ok(stewardRun)
    assert.equal(stewardRun.trigger_ref, binding.session_id)
    assert.equal(stewardRun.project_id, project.id)
    assert.equal(stewardRun.bot_id, dev.id)
    assert.ok(['queued', 'running'].includes(stewardRun.status))

    // 同一绑定重复入队不新建 steward 运行。
    const again = service.enqueueStewardRun(dev, project, binding)
    assert.equal(again, stewardRun.id)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE kind = 'steward'").n, 1)
  } finally {
    await closeQuietly(store)
    await rm(ctx.root, { recursive: true, force: true })
  }
})

test('steward 产出摘要后落 session_rotations 并删除旧绑定', async () => {
  const ctx = await manualSetup()
  const { store, service, runtime } = ctx
  try {
    const { task, binding } = await deferWithSteward(ctx, 'session-task-two')

    // 第二轮 tick 把 steward 领走执行。
    await service.tick()
    const stewardRun = store.get("SELECT * FROM runs WHERE kind = 'steward' AND status = 'running'")
    assert.ok(stewardRun)

    await runtime.complete(stewardRun.id, 'succeeded', [
      '```markdown',
      '# 工作现状',
      '做了 A，当前在等上游接口的返回结构确认。',
      '# 逐条结果',
      '1. 登录接口返回 { code, token }，成功码是 0。',
      '2. 错误码 401 表示令牌过期，需要重新授权。',
      '# 决策与理由',
      '把令牌过期当作可重试错误，不当作致命失败处理。',
      '# 依赖与约束',
      '依赖上游网关返回稳定的错误码表，别的地方照旧。',
      '# 未完成请求',
      '还有一个请求没做：确认分页参数在网关侧的默认值。',
      '```',
    ].join('\n'))

    const rotation = store.get('SELECT * FROM session_rotations')
    assert.ok(rotation)
    assert.equal(rotation.bot_id, stewardRun.bot_id)
    assert.equal(rotation.kind, 'task')
    assert.equal(rotation.task_id, task.id)
    assert.equal(rotation.old_session_id, binding.session_id)
    assert.equal(rotation.seq, 1)
    assert.equal(rotation.seeded, 0)
    assert.ok(rotation.checkpoint.includes('做了 A'))
    assert.ok(!rotation.checkpoint.includes('```'))

    // 旧会话绑定已删除，新会话将在下个运行时重建。
    assert.equal(store.get('SELECT * FROM session_bindings WHERE session_id = ?', binding.session_id), undefined)
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'rotated'", stewardRun.id).n,
      1,
    )
  } finally {
    await closeQuietly(store)
    await rm(ctx.root, { recursive: true, force: true })
  }
})

test('steward 无可用摘要时降级滚动：删绑定、不落 rotation', async () => {
  const ctx = await manualSetup()
  const { store, service, runtime } = ctx
  try {
    const { binding } = await deferWithSteward(ctx, 'session-task-three')

    await service.tick()
    const stewardRun = store.get("SELECT * FROM runs WHERE kind = 'steward' AND status = 'running'")
    assert.ok(stewardRun)

    await runtime.complete(stewardRun.id, 'succeeded', '')

    assert.equal(store.get('SELECT * FROM session_bindings WHERE session_id = ?', binding.session_id), undefined)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM session_rotations').n, 0)
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'rotated_degraded'", stewardRun.id).n,
      1,
    )
  } finally {
    await closeQuietly(store)
    await rm(ctx.root, { recursive: true, force: true })
  }
})

test('steward 跑在被总结的那个任务会话上，不降级成项目会话', async () => {
  const ctx = await manualSetup()
  const { store, service, runtime, chief, dev } = ctx
  try {
    const project = await service.createProject({ name: 'StewardTask', key: 'STK', ownerBotId: chief.id, memberIds: [dev.id] })
    await service.createTask({ projectId: project.id, title: '长任务', assigneeBotId: dev.id, autoStart: true })
    const task = store.get('SELECT * FROM tasks WHERE project_id = ?', project.id)
    insertTaskBinding(store, { sessionId: 'session-steward-task', botId: dev.id, projectId: project.id, taskId: task.id })

    service.started = true
    await service.tick()
    await service.tick()

    const stewardRun = store.get("SELECT * FROM runs WHERE kind = 'steward'")
    assert.ok(stewardRun)
    const started = runtime.started.find(entry => entry.runId === stewardRun.id)
    assert.ok(started, 'steward 运行应被启动')
    assert.equal(started.sessionKind, 'task', 'steward 应声明自己在任务会话里')
    assert.equal(started.task, task.id, 'steward 应带上被总结的任务，否则会被降级到项目会话')
  } finally {
    await closeQuietly(store)
    await rm(ctx.root, { recursive: true, force: true })
  }
})

test('私信回信跑在来源会话上，不投到项目会话', async () => {
  const ctx = await manualSetup()
  const { store, service, runtime, chief, dev } = ctx
  try {
    const project = await service.createProject({ name: 'DmReply', key: 'DMR', ownerBotId: chief.id, memberIds: [dev.id] })
    const task = await service.createTask({ projectId: project.id, title: '需求', assigneeBotId: dev.id })
    insertTaskBinding(store, { sessionId: 'session-dm-origin', botId: dev.id, projectId: project.id, taskId: task.id })

    const messageId = 'msg-origin-1'
    store.run(
      `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_session_id,
        origin_kind, origin_task_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'task', ?, 'replied', ?)`,
      messageId, project.id, chief.id, dev.id, 'req-1', '问题在这里', 'session-dm-origin', task.id,
      new Date().toISOString(),
    )
    const message = store.get('SELECT * FROM bot_messages WHERE id = ?', messageId)

    service.deliverBotReply(message)
    service.started = true
    await service.tick()

    const replyRun = store.get("SELECT * FROM runs WHERE kind = 'dm_reply'")
    assert.ok(replyRun)
    const started = runtime.started.find(entry => entry.runId === replyRun.id)
    assert.ok(started, '回信运行应被启动')
    assert.equal(started.sessionKind, 'task')
    assert.equal(started.task, task.id, '回信应落在来源任务会话')
  } finally {
    await closeQuietly(store)
    await rm(ctx.root, { recursive: true, force: true })
  }
})

test('群聊运行达到检查线时也能触发滚动：绑定是 project 不是 chat', async () => {
  const ctx = await manualSetup()
  const { store, service, chief, dev } = ctx
  try {
    const project = await service.createProject({ name: 'ChatRotate', key: 'CRT', ownerBotId: chief.id, memberIds: [dev.id] })
    // 群聊会话绑定落在项目会话（kind='project'）上，上下文已逼近窗口上限。
    store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at, last_ctx_tokens, ctx_window)
       VALUES (?, ?, ?, 'project', NULL, ?, 400000, 500000)`,
      'session-chat-one', dev.id, project.id, new Date().toISOString(),
    )

    service.started = true
    await service.sendMessage(project.id, '@Builder 继续推进')
    await service.tick()

    const chatRun = store.get("SELECT * FROM runs WHERE kind = 'chat'")
    assert.ok(chatRun)
    assert.equal(chatRun.status, 'queued', '群聊运行应被推迟等待滚动')
    assert.equal(
      store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'deferred_steward'", chatRun.id).n,
      1,
    )

    const stewardRun = store.get("SELECT * FROM runs WHERE kind = 'steward'")
    assert.ok(stewardRun, '群聊运行也应排 steward')
    assert.equal(stewardRun.trigger_ref, 'session-chat-one')
  } finally {
    await closeQuietly(store)
    await rm(ctx.root, { recursive: true, force: true })
  }
})

test('群聊回复完成后触发记忆审查，写入带密钥遮蔽的记忆', async () => {
  const ctx = await manualSetup()
  const { store, service, runtime, chief, dev } = ctx
  try {
    const project = await service.createProject({ name: 'ChatMem', key: 'CMEM', ownerBotId: chief.id, memberIds: [dev.id] })
    service.started = true

    await service.sendMessage(project.id, '@Builder 收工总结一下')
    await service.tick()

    const chatRun = store.get("SELECT * FROM runs WHERE kind = 'chat'")
    assert.ok(chatRun)
    assert.ok(['queued', 'running'].includes(chatRun.status))
    await runtime.complete(chatRun.id, 'succeeded', '好的')

    // 审查运行挂在整个聊天运行上，不关联具体任务。
    await service.tick()
    const reviewRun = store.get("SELECT * FROM runs WHERE kind = 'memory_review'")
    assert.ok(reviewRun)
    assert.equal(reviewRun.task_id, null)
    assert.equal(reviewRun.trigger_ref, chatRun.id)
    assert.ok(['queued', 'running'].includes(reviewRun.status))

    await runtime.complete(reviewRun.id, 'succeeded', JSON.stringify([
      { scope: 'bot', topic: '协作偏好', content: 'Builder 回复群聊时偏好中文短句', confidence: 0.9 },
      { scope: 'bot', topic: '凭据卫生', content: '群聊里出现过令牌 sk-abcdefghijklmnop 需要遮蔽', confidence: 0.5 },
    ]))

    const rows = store.all("SELECT * FROM memories WHERE scope_type = 'bot' AND scope_id = ? ORDER BY created_at", dev.id)
    assert.equal(rows.length, 2)

    // 高置信记忆直接生效，无存储密钥时内容原样保留。
    const active = rows.find(row => row.content.includes('中文短句'))
    assert.equal(active.status, 'active')
    assert.equal(active.content, 'Builder 回复群聊时偏好中文短句')
    assert.equal(active.source, `run:${chatRun.id}`)

    // 低置信记忆进待审，密钥形态的文本被遮蔽。
    const pending = rows.find(row => row.content.includes('REDACTED'))
    assert.equal(pending.status, 'pending')
    assert.ok(!pending.content.includes('sk-abcdefghijklmnop'))
    assert.equal(pending.source, `run:${chatRun.id}`)
  } finally {
    await closeQuietly(store)
    await rm(ctx.root, { recursive: true, force: true })
  }
})
