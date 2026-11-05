import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import {
  attachSessionToWorkspace,
  backfillWorkspaceGroupBindings,
  ensureWorkspaceForCwd,
  workspaceGroupTitle,
} from '../src/services/workspace-groups.js'

// bot 会话挂 DSH 原生工作区分组：原生侧栏按 workspaceRegistry.sessionIds 归组，
// 插件会话从未 attach 所以全落「未分组」。这里覆盖：纯函数语义、ensureSession
// 即时挂载（ctx.get 口径）、启动回填与幂等标记。

class FakeRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-wsgroups-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0 })
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

// 假 registry：记录 resolveByPath/create/attach 全部调用；existing 非空表示该 cwd 已有 workspace。
function fakeRegistry({ existing = null, createError = null, attachError = null } = {}) {
  const calls = { resolveByPath: [], create: [], attach: [] }
  const makeEntity = label => ({
    label,
    async attachSession(sessionId) {
      calls.attach.push({ label, sessionId })
      if (attachError) throw attachError
    },
  })
  return {
    calls,
    async resolveByPath(cwd) {
      calls.resolveByPath.push(cwd)
      return existing
    },
    async create(cwd, title) {
      calls.create.push({ cwd, title })
      if (createError) throw createError
      return makeEntity(`created:${cwd}`)
    },
  }
}

// 复刻宿主 cordis 上下文：可选服务一律经 ctx.get(name) 取；未声明 inject 的服务
// 属性读取直接抛错（bot-file-policy.test.js 同款口径）。
function fakeCtx() {
  const cwdCapture = []
  const agent = { agent: { session: { append() {} } } }
  const services = new Map()
  return {
    services,
    get(name) { return services.get(name) },
    sessionController: {
      async create(params) {
        cwdCapture.push(params.cwd)
        return { sessionId: 'sess-1' }
      },
      async resolveAgent() { return agent },
      async selectModel() { return { selected: {} } },
    },
    sessionTitle: { rename() {} },
    cwdCapture,
  }
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} } as unknown as Console
}

test('ensureWorkspaceForCwd：resolveByPath 命中时复用既有 workspace，不再 create', async () => {
  const existing = { async attachSession() {} }
  const registry = fakeRegistry({ existing })
  const entity = await ensureWorkspaceForCwd(registry, { cwd: '/tmp/alpha', title: 'Alpha' })
  assert.equal(entity, existing, '命中时应原样返回既有 entity')
  assert.equal(registry.calls.create.length, 0, '命中时不应调用 create')
})

test('attachSessionToWorkspace：未命中时按同一 cwd create，并挂到新建 entity', async () => {
  const registry = fakeRegistry()
  const ok = await attachSessionToWorkspace(registry, { cwd: '/tmp/alpha', title: 'Alpha', sessionId: 's1' }, silentLogger())
  assert.equal(ok, true)
  assert.deepEqual(registry.calls.create, [{ cwd: '/tmp/alpha', title: 'Alpha' }], 'create 必须收到与建会话相同的 cwd')
  assert.equal(registry.calls.attach[0].sessionId, 's1')
  assert.equal(registry.calls.attach[0].label, 'created:/tmp/alpha', '应挂到本次 create 的新 entity')
})

test('attachSessionToWorkspace：create/attachSession 抛错时不抛、只 warn、返回 false', async () => {
  const warns = []
  const logger = { warn: (...parts) => warns.push(parts.join(' ')), info() {}, error() {} } as unknown as Console
  const onCreate = await attachSessionToWorkspace(
    fakeRegistry({ createError: new Error('boom-create') }),
    { cwd: '/tmp/alpha', title: 'T', sessionId: 's1' },
    logger,
  )
  const onAttach = await attachSessionToWorkspace(
    fakeRegistry({ existing: { async attachSession() { throw new Error('boom-attach') } } }),
    { cwd: '/tmp/alpha', title: 'T', sessionId: 's1' },
    logger,
  )
  assert.equal(onCreate, false, 'create 失败应返回 false 而非抛出')
  assert.equal(onAttach, false, 'attachSession 失败应返回 false 而非抛出')
  assert.equal(warns.length, 2, '两条失败都应留下 warn 痕迹')
  assert.match(warns[0], /boom-create/)
})

test('workspaceGroupTitle：项目内会话归项目名，单聊归 bot 名 · 单聊', () => {
  const project = { name: '预算系统', slug: 'budget' }
  const bot = { name: '小程' }
  assert.equal(workspaceGroupTitle({ kind: 'project', project, bot }), '预算系统')
  assert.equal(workspaceGroupTitle({ kind: 'task', project, bot }), '预算系统', '任务会话也归项目组，不一个任务一组')
  assert.equal(workspaceGroupTitle({ kind: 'dm', project, bot }), '预算系统')
  assert.equal(workspaceGroupTitle({ kind: 'solo', project: null, bot }), '小程 · 单聊')
})

test('ensureSession：宿主未装 workspaceRegistry 时照常完成，且绝不走属性读取', async () => {
  const { root, store, service, config } = await setup()
  try {
    const director = await service.createBot({ name: 'lead', role: '头', instructions: 'x', provider: 'fake', model: 'model-a' })
    const project = await service.createProject({ name: 'Alpha', ownerBotId: director.id })
    const bot = service.botRow((await service.createBot({ name: 'Worker', role: '干', instructions: 'x', provider: 'fake', model: 'model-a' })).id)
    const ctx = fakeCtx()
    // 复刻宿主：ctx.workspaceRegistry 属性读取必须抛错——接入只能走 ctx.get。
    Object.defineProperty(ctx, 'workspaceRegistry', {
      get() { throw new Error('cannot get property "workspaceRegistry" without inject') },
    })
    const runtime = new DshRuntime({ ctx, config, store, logger: silentLogger() })
    const sessionId = await runtime.ensureSession(bot, project, {})
    assert.equal(sessionId, 'sess-1', '取不到 registry 时 ensureSession 应照常返回')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('ensureSession：registry 就位时新建会话即挂到与 cwd 一致的工作区', async () => {
  const { root, store, service, config } = await setup()
  try {
    const director = await service.createBot({ name: 'lead', role: '头', instructions: 'x', provider: 'fake', model: 'model-a' })
    const project = await service.createProject({ name: 'Alpha', ownerBotId: director.id })
    const bot = service.botRow((await service.createBot({ name: 'Worker', role: '干', instructions: 'x', provider: 'fake', model: 'model-a' })).id)
    const ctx = fakeCtx()
    const registry = fakeRegistry()
    ctx.services.set('workspaceRegistry', registry)
    const runtime = new DshRuntime({ ctx, config, store, logger: silentLogger() })
    const sessionId = await runtime.ensureSession(bot, project, {})
    assert.equal(sessionId, 'sess-1')
    assert.equal(registry.calls.attach.length, 1, '新建会话应即时挂载一次')
    assert.equal(registry.calls.attach[0].sessionId, 'sess-1')
    assert.equal(registry.calls.create[0].cwd, ctx.cwdCapture[0], '挂载 cwd 必须与建会话 cwd 完全一致')
    assert.equal(registry.calls.create[0].title, 'Alpha', '项目会话组标题应为 project.name')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('backfillWorkspaceGroupBindings：按 cwd 分组全量回填，标记写后幂等跳过', async () => {
  const { root, store, service, config } = await setup()
  try {
    // setup 的 initialize 已跑过启动钩子：测试桩 runtime 无 ctx，钩子应静默跳过且不写标记。
    assert.equal(store.setting('workspace_group_backfill'), null, 'ctx 缺失时启动钩子应跳过且不写标记')
    store.run("DELETE FROM settings WHERE key = 'workspace_group_backfill'")

    const director = await service.createBot({ name: 'lead', role: '头', instructions: 'x', provider: 'fake', model: 'model-a' })
    const worker = await service.createBot({ name: 'Worker', role: '干', instructions: 'x', provider: 'fake', model: 'model-a' })
    const project = await service.createProject({ name: 'Alpha', ownerBotId: director.id })
    const now = new Date().toISOString()
    for (const [sessionId, botId, projectId, kind] of [
      ['sess-p', worker.id, project.id, 'project'],
      ['sess-t', worker.id, project.id, 'task'],
      ['sess-solo', worker.id, null, 'solo'],
    ]) {
      store.run(
        'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
        sessionId, botId, projectId, kind, now,
      )
    }

    const registry = fakeRegistry()
    const logs = []
    const logger = { warn() {}, info: (...parts) => logs.push(parts.join(' ')), error() {} }
    const didRun = await backfillWorkspaceGroupBindings({ store, config, logger, ctx: { get: name => name === 'workspaceRegistry' ? registry : undefined } })
    assert.equal(didRun, true)
    assert.equal(registry.calls.attach.length, 3, '无标记时必须真的扫表挂载 3 条')
    assert.equal(registry.calls.create.length, 2, '同项目两条共用一组 + 单聊一组，只应 create 2 个 workspace')
    const byTitle = Object.fromEntries(registry.calls.create.map(call => [call.title, call.cwd]))
    assert.deepEqual(
      registry.calls.attach.filter(call => ['sess-p', 'sess-t'].includes(call.sessionId)).map(call => call.label),
      [`created:${byTitle['Alpha']}`, `created:${byTitle['Alpha']}`],
      '任务会话应与项目会话同组',
    )
    assert.match(logs.join('\n'), /挂载 3，失败 0/)
    assert.equal(store.setting('workspace_group_backfill'), '1', '跑完应写幂等标记')

    const registryAgain = fakeRegistry()
    const rerun = await backfillWorkspaceGroupBindings({ store, config, logger: silentLogger(), ctx: { get: name => name === 'workspaceRegistry' ? registryAgain : undefined } })
    assert.equal(rerun, false, '标记存在时应直接跳过')
    assert.equal(registryAgain.calls.resolveByPath.length, 0, '幂等跳过时不应再碰 registry')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('backfillWorkspaceGroupBindings：registry 缺失时跳过且不写标记，留待下次启动', async () => {
  const { root, store, config } = await setup()
  try {
    store.run("DELETE FROM settings WHERE key = 'workspace_group_backfill'")
    const didRun = await backfillWorkspaceGroupBindings({ store, config, logger: silentLogger(), ctx: { get: () => undefined } })
    assert.equal(didRun, false)
    assert.equal(store.setting('workspace_group_backfill'), null, 'registry 缺失不应写标记，宿主装好后下次启动可补')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})
