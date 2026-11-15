// 宿主归档会话复用回归（ArchivedSessionGate）：归档会话在宿主侧不执行任何模型步骤，
// turn/end 记 blocked 且无 assistant 文本。插件若照常复用会把空回复当成功落库
// （群聊表现为「模型未返回文本」）。修复口径：复用时先查 workspaceRegistry.archivedSessionIds，
// 命中即与「宿主查不到」同等处理——旧绑定降级为授权别名，走新建会话路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

const logger = { info() {}, warn() {}, error() {} }

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-archived-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0, schedulerIntervalMs: 30_000,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service, config }
}

const cleanup = async ({ root, store, service }) => {
  try { service.started = false } catch {}
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

// 带归档名单的宿主替身：resolveAgent 永远「能解析」（模拟归档会话仍可 resolve 的宿主行为），
// 是否复用只由 archivedSessionIds 决定。
const hostWithArchive = (archived) => {
  const created = []
  return {
    created,
    get: (name) => (name === 'workspaceRegistry' ? { archivedSessionIds: archived } : undefined),
    sessionController: {
      resolveAgent: async () => ({}),
      selectModel: async () => ({}),
      create: async () => {
        const sessionId = `sess-new-${created.length + 1}`
        created.push(sessionId)
        return { sessionId }
      },
      prompt: async () => {},
      cancel: async () => {},
    },
  }
}

const newRuntime = (ctx, config, store) => new DshRuntime({ ctx, config, store, logger })

async function primeProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Archived', key: 'ARC', ownerBotId: director.id, memberIds: [dev.id] })
  return { director, dev, project }
}

const bindSession = (store, { botId, projectId, sessionId, kind = 'bot', taskId = null }) => {
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    sessionId, botId, projectId, kind, taskId, new Date().toISOString(),
  )
}

test('控制面绑定被归档：旧绑定降级别名并新建会话，不复用归档会话', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })

    const host = hostWithArchive(['sess-old'])
    const runtime = newRuntime(host, ctx.config, ctx.store)
    const sessionId = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })

    assert.equal(sessionId, 'sess-new-1', '归档绑定不得复用，应开新会话')
    assert.equal(ctx.store.get('SELECT * FROM session_bindings WHERE session_id = ?', 'sess-old')?.alias, 1, '旧绑定应降级为授权别名')
    assert.equal(ctx.store.get('SELECT * FROM session_bindings WHERE session_id = ?', 'sess-new-1')?.alias, 0, '新绑定应是活跃绑定')
    assert.deepEqual(host.created, ['sess-new-1'], '只新建一次会话')
  } finally {
    await cleanup(ctx)
  }
})

test('未归档且可解析：照常复用旧会话（回归护栏）', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })

    const host = hostWithArchive([])
    const runtime = newRuntime(host, ctx.config, ctx.store)
    const sessionId = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })

    assert.equal(sessionId, 'sess-old', '未归档应继续复用')
    assert.deepEqual(host.created, [], '不得新建会话')
  } finally {
    await cleanup(ctx)
  }
})

test('任务亲和会话被归档：未终态任务流量改落新建任务会话', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const task = await ctx.service.createTask({ projectId: project.id, title: '归档亲和', assigneeBotId: dev.id }, ctx.service.actor())
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-task', kind: 'task', taskId: task.id })
    ctx.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, attempt, idempotency_key, session_id, queued_at)
       VALUES ('run_seed', ?, ?, ?, 'task', 'read', 'test', 'succeeded', 1, 'seed:1', 'sess-task', ?)`,
      project.id, dev.id, task.id, new Date().toISOString(),
    )

    const host = hostWithArchive(['sess-task'])
    const runtime = newRuntime(host, ctx.config, ctx.store)
    const sessionId = await runtime.ensureSession(dev, project, { run: { kind: 'task' }, task })

    assert.equal(sessionId, 'sess-new-1', '归档的任务亲和会话不得复用，应开新任务会话')
    assert.equal(ctx.store.get('SELECT * FROM session_bindings WHERE session_id = ?', 'sess-task')?.alias, 1, '旧任务绑定应降级为授权别名')
  } finally {
    await cleanup(ctx)
  }
})

test('结转/压缩运行指向归档会话：旧绑定降级别名，运行改落新建控制面会话', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })

    const host = hostWithArchive(['sess-old'])
    const runtime = newRuntime(host, ctx.config, ctx.store)
    const sessionId = await runtime.ensureSession(dev, project, { run: { kind: 'rollover_summary', session_id: 'sess-old' } })

    assert.equal(sessionId, 'sess-new-1', '归档会话上的摘要运行不得原地执行，应落新会话')
    assert.equal(ctx.store.get('SELECT * FROM session_bindings WHERE session_id = ?', 'sess-old')?.alias, 1)
  } finally {
    await cleanup(ctx)
  }
})

// ── lifecycle：blocked 且无输出按失败上报，不再假成功 ──────────────────────

function seedRun(store, { runId = 'r1', sessionId = 'sess-root' } = {}) {
  const now = new Date().toISOString()
  store.run(
    `INSERT INTO bots(id, name, role, instructions, color, status, current_revision, created_at, updated_at)
     VALUES ('b1', 'Builder', '开发', '', 'blue', 'active', 0, ?, ?)`, now, now,
  )
  store.run(
    `INSERT INTO projects(id, key, name, slug, owner_bot_id, status, created_at, updated_at)
     VALUES ('p1', 'RUN', 'Run', 'run', 'b1', 'active', ?, ?)`, now, now,
  )
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
     VALUES (?, 'p1', 'b1', 'chat', 'write', 'chat_message', 'running', 1, ?, ?)`,
    runId, `key-${runId}`, now,
  )
  return sessionId
}

function makeRuntime(store, onComplete) {
  const runtime = new DshRuntime({
    ctx: {},
    config: { runTimeoutMs: 60_000 },
    store,
    logger,
  })
  runtime.pending.set('sess-root', {
    runId: 'r1', sessionId: 'sess-root', bot: { id: 'b1', provider: 'fake', model: 'model-a' },
    projectId: 'p1', started: false, texts: [], lastText: '', usageCounter: 0, tokens: 0, timeout: null,
  })
  runtime.pendingByRun.set('r1', runtime.pending.get('sess-root'))
  runtime.completionHandler = onComplete
  return runtime
}

async function withStore(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-archived-life-'))
  const store = openDatabase(join(root, 'team.sqlite'))
  try {
    await fn(store, root)
  } finally {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

test('turn/end blocked 且无输出：按失败上报 SESSION_BLOCKED，不落假成功', async () => {
  await withStore(async (store) => {
    seedRun(store)
    let captured = null
    const runtime = makeRuntime(store, async (result) => { captured = result })

    await runtime.handleEvent({ id: 'sess-root' }, { type: 'turn/start', data: { turn: 1 } })
    await runtime.handleEvent({ id: 'sess-root' }, { type: 'turn/end', data: { reason: { kind: 'blocked' } } })

    assert.equal(captured?.status, 'failed', 'blocked 无输出必须按失败收尾')
    assert.equal(captured?.error?.code, 'SESSION_BLOCKED')
    assert.equal(captured?.output, '', '无任何模型输出')
  })
})

test('turn/end blocked 但已有输出：不误判为失败（回归护栏）', async () => {
  await withStore(async (store) => {
    seedRun(store)
    let captured = null
    const runtime = makeRuntime(store, async (result) => { captured = result })

    await runtime.handleEvent({ id: 'sess-root' }, { type: 'turn/start', data: { turn: 1 } })
    await runtime.handleEvent({ id: 'sess-root' }, {
      type: 'assistant/message',
      time: Date.now(),
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '前文结论' }] } },
    })
    await runtime.handleEvent({ id: 'sess-root' }, { type: 'turn/end', data: { reason: { kind: 'blocked' } } })

    assert.equal(captured?.status, 'succeeded', '已有正文输出时按成功收尾')
    assert.equal(captured?.output, '前文结论')
  })
})
