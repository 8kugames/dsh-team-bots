import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { sandboxModeForRun } from '../src/services/runtime/prompt.js'

// 读运行强制只读沙箱：写权限按运行类型收紧。一切 mode!=='write' 的运行
// （dm/dm_reply/chat/memory_review/solo_chat/review/handle）会话物理降 read-only，
// 越权写入由宿主沙箱层拒绝；写运行沿用 bot.file_policy；run 为空保持现行为。

class FakeRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-runsandbox-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'), modelCacheMs: 0 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new FakeRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service, config }
}

async function closeQuietly(store) {
  try { store.close() } catch {}
}

// fake ctx 沿用 tests/bot-file-policy.test.js 的口径：services Map + get(name)。
// trackOverride 时 overrideOf 返回最近一次 sandbox/mode 追加值，模拟宿主持久覆盖。
function fakeCtx({ trackOverride = false } = {}) {
  const appended = []
  let currentOverride
  const session = {
    append(type, data) {
      appended.push({ type, data })
      if (trackOverride && type === 'sandbox/mode') currentOverride = data.mode
    },
  }
  const agent = { agent: { session } }
  const services = new Map()
  services.set('sandboxPolicy', { overrideOf: () => currentOverride })
  return {
    appended,
    session,
    services,
    get(name) { return services.get(name) },
    sessionController: {
      async resolveAgent() { return agent },
      async create() { return { sessionId: 'sess-1' } },
      async selectModel() { return { selected: {} } },
    },
    sessionTitle: { rename() {} },
  }
}

function runtimeOf(ctx, store, config, warns = []) {
  return new DshRuntime({ ctx, config, store, logger: { info() {}, warn: m => warns.push(m), error() {} } })
}

async function seedProject(store, service) {
  const director = await service.createBot({ name: 'director2', role: '头', instructions: 'x', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Alpha', ownerBotId: director.id })
  const bot = service.botRow((await service.createBot({ name: 'Worker', role: '干', instructions: 'x', provider: 'fake', model: 'model-a', filePolicy: 'workspace-write' })).id)
  return { project, bot }
}

test('读运行（dm）强制 read-only：ensureSession 新建与复用两条路径都收到覆盖', async () => {
  const { root, store, service, config } = await setup()
  try {
    const { project, bot } = await seedProject(store, service)
    const ctx = fakeCtx()
    const runtime = await runtimeOf(ctx, store, config)
    const run = { kind: 'dm', mode: 'read' }

    // 新建路径：bot.file_policy=workspace-write 仍必须收到 read-only 覆盖。
    const sessionId = await runtime.ensureSession(bot, project, { run })
    assert.equal(sessionId, 'sess-1')
    const created = ctx.appended.filter(call => call.type === 'sandbox/mode')
    assert.equal(created.length, 1, '新建会话应写一次 sandbox/mode')
    assert.deepEqual(created[0].data, { mode: 'read-only' }, 'dm 读运行应覆盖为 read-only')

    // 复用路径（session_bindings 命中 → resolveAgent）同样收紧。
    ctx.appended.length = 0
    const reused = await runtime.ensureSession(bot, project, { run })
    assert.equal(reused, 'sess-1')
    const reusedModes = ctx.appended.filter(call => call.type === 'sandbox/mode')
    assert.equal(reusedModes.length, 1, '复用会话也应应用权限')
    assert.deepEqual(reusedModes[0].data, { mode: 'read-only' })
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('写运行（task, mode=write）沿用 bot.file_policy 原值', async () => {
  const { root, store, service, config } = await setup()
  try {
    const { project, bot } = await seedProject(store, service)
    await service.createTask({ projectId: project.id, title: 'T1' })
    const task = store.get('SELECT * FROM tasks WHERE project_id = ?', project.id)
    const ctx = fakeCtx()
    const runtime = await runtimeOf(ctx, store, config)

    const sessionId = await runtime.ensureSession(bot, project, { run: { kind: 'task', mode: 'write', task_id: task.id }, task })
    assert.equal(sessionId, 'sess-1')
    const modes = ctx.appended.filter(call => call.type === 'sandbox/mode')
    assert.equal(modes.length, 1)
    assert.deepEqual(modes[0].data, { mode: 'workspace-write' }, '写运行应原样应用 bot.file_policy')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('run 为空保持 bot.file_policy 现行为；档位选择纯函数边界', async () => {
  const { root, store, config } = await setup()
  try {
    const ctx = fakeCtx()
    const runtime = await runtimeOf(ctx, store, config)
    runtime.applyFilePolicy({ agent: { session: ctx.session } }, { name: 'A', file_policy: 'danger-full-access' })
    const modes = ctx.appended.filter(call => call.type === 'sandbox/mode')
    assert.equal(modes.length, 1)
    assert.deepEqual(modes[0].data, { mode: 'danger-full-access' }, '无运行上下文时保持现行为')

    assert.equal(sandboxModeForRun({ kind: 'dm', mode: 'read' }, { file_policy: 'danger-full-access' }), 'read-only')
    assert.equal(sandboxModeForRun({ kind: 'task', mode: 'write' }, { file_policy: 'danger-full-access' }), 'danger-full-access')
    assert.equal(sandboxModeForRun(null, { file_policy: 'workspace-write' }), 'workspace-write')
    // mode 缺失按只读处理（库列 NOT NULL DEFAULT 'write'，缺失即异常数据，向安全侧收敛）。
    assert.equal(sandboxModeForRun({ kind: 'chat' }, { file_policy: 'workspace-write' }), 'read-only')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('同一会话先读后写：append 以新档位调用，同档位不重复追加', async () => {
  const { root, store, config } = await setup()
  try {
    const ctx = fakeCtx({ trackOverride: true })
    const runtime = await runtimeOf(ctx, store, config)
    const bot = { name: 'A', file_policy: 'workspace-write' }
    const readRun = { kind: 'dm', mode: 'read' }
    const writeRun = { kind: 'task', mode: 'write' }
    const agent = { agent: { session: ctx.session } }

    runtime.applyFilePolicy(agent, bot, readRun)
    assert.deepEqual(ctx.appended.map(call => call.data.mode), ['read-only'])
    runtime.applyFilePolicy(agent, bot, readRun)
    assert.equal(ctx.appended.length, 1, '同档位不重复 append')

    runtime.applyFilePolicy(agent, bot, writeRun)
    assert.deepEqual(ctx.appended.map(call => call.data.mode), ['read-only', 'workspace-write'], '档位变化以新档位 append')
    runtime.applyFilePolicy(agent, bot, writeRun)
    assert.equal(ctx.appended.length, 2, '写档位稳定后不再重复 append')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('ctx.get 抛错只告警不阻断；ctx.get 缺失仍能直写覆盖', async () => {
  const { root, store, config } = await setup()
  try {
    const warns = []
    const ctx = fakeCtx()
    ctx.get = () => { throw new Error('cannot get service without inject') }
    const runtime = await runtimeOf(ctx, store, config, warns)
    runtime.applyFilePolicy({ agent: { session: ctx.session } }, { name: 'A', file_policy: 'read-only' }, { kind: 'dm', mode: 'read' })
    assert.equal(ctx.appended.length, 0, '读取失败不应写覆盖')
    assert.equal(warns.length, 1, '失败只告警')
    assert.match(warns[0], /read-only/)

    const ctx2 = fakeCtx()
    delete ctx2.get
    const runtime2 = await runtimeOf(ctx2, store, config)
    runtime2.applyFilePolicy({ agent: { session: ctx2.session } }, { name: 'A', file_policy: 'read-only' }, { kind: 'dm', mode: 'read' })
    const modes = ctx2.appended.filter(call => call.type === 'sandbox/mode')
    assert.equal(modes.length, 1, 'ctx.get 缺失按无覆盖处理，仍应写入')
    assert.deepEqual(modes[0].data, { mode: 'read-only' })
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
