import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

// bot.file_policy：默认工作区内修改、可改、改了有审计、派发时写成宿主 sandbox/mode 覆盖。

class FakeRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-policy-'))
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

test('bots default to workspace-write file policy and expose it in views', async () => {
  const { root, store, service } = await setup()
  try {
    const seeded = store.all('SELECT * FROM bots')
    assert.ok(seeded.length > 0)
    for (const bot of seeded) assert.equal(bot.file_policy, 'workspace-write', `${bot.name} 应默认 workspace-write`)
    const created = await service.createBot({ name: 'Scribe', role: '测试', instructions: 'x' })
    assert.equal(created.file_policy, 'workspace-write')
    const strict = await service.createBot({ name: 'Vault', role: '测试', instructions: 'x', filePolicy: 'read-only' })
    assert.equal(strict.file_policy, 'read-only')
    await assert.rejects(
      () => service.createBot({ name: 'Ghost', role: '测试', instructions: 'x', filePolicy: 'all-access' }),
      /文件权限无效/,
    )
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('updating file policy persists, audits and does not bump revisions', async () => {
  const { root, store, service } = await setup()
  try {
    const bot = await service.createBot({ name: 'Builder', role: '开发', instructions: 'x' })
    const beforeRevision = bot.current_revision
    const updated = await service.updateBot(bot.id, { filePolicy: 'danger-full-access' })
    assert.equal(updated.file_policy, 'danger-full-access')
    assert.equal(updated.current_revision, beforeRevision, '权限变更不应产生新版本')
    const audit = store.get(
      "SELECT * FROM audit_log WHERE action = 'bot.update' AND target_id = ? ORDER BY rowid DESC",
      bot.id,
    )
    assert.equal(JSON.parse(audit.data_json).file_policy, 'danger-full-access')
    // 相同值不写无意义变更，非法值直接拒绝。
    await service.updateBot(bot.id, { filePolicy: 'danger-full-access' })
    const latest = store.get(
      "SELECT * FROM audit_log WHERE action = 'bot.update' AND target_id = ? ORDER BY rowid DESC",
      bot.id,
    )
    assert.ok(!JSON.parse(latest.data_json).file_policy, '相同权限值不应记审计')
    await assert.rejects(
      () => service.updateBot(bot.id, { filePolicy: 'yolo' }),
      /文件权限无效/,
    )
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

// ensureSession 派发断言：fake ctx 捕获 append('sandbox/mode') 参数。
// 宿主 cordis 上下文里未声明 inject 的服务不能被直接读取（读即抛错），可选服务
// 一律经 ctx.get(name) 取——fake ctx 按同一口径提供，并保留 services 便于改桩。
function fakeCtx({ sandboxPolicy = true } = {}) {
  const appended = []
  const session = {
    append(type, data) { appended.push({ type, data }) },
  }
  const agent = { agent: { session } }
  const services = new Map()
  if (sandboxPolicy) services.set('sandboxPolicy', { overrideOf: () => undefined })
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

async function runtimeOf(ctx, store, config) {
  return new DshRuntime({ ctx, config, store, logger: { info() {}, warn() {}, error() {} } })
}

test('ensureSession writes sandbox/mode with the bot file policy on both paths', async () => {
  const { root, store, service, config } = await setup()
  try {
    const project = await service.createProject({ name: 'Alpha', ownerBotId: (await service.createBot({ name: 'director2', role: '头', instructions: 'x', provider: 'fake', model: 'model-a' })).id })
    const bot = service.botRow((await service.createBot({ name: 'Worker', role: '干', instructions: 'x', provider: 'fake', model: 'model-a', filePolicy: 'read-only' })).id)
    const ctx = fakeCtx()
    const runtime = await runtimeOf(ctx, store, config)

    // 新建路径：session_bindings 没有记录 → create → resolveAgent → applyFilePolicy。
    const sessionId = await runtime.ensureSession(bot, project, {})
    assert.equal(sessionId, 'sess-1')
    const modes = ctx.appended.filter(call => call.type === 'sandbox/mode')
    assert.equal(modes.length, 1, '新建会话应写一次 sandbox/mode')
    assert.deepEqual(modes[0].data, { mode: 'read-only' })

    // 复用路径：第一次调用已写入 binding，再调走 resolveAgent 复用 → 同样应用权限。
    ctx.appended.length = 0
    const reused = await runtime.ensureSession(bot, project, {})
    assert.equal(reused, 'sess-1')
    const reuseModes = ctx.appended.filter(call => call.type === 'sandbox/mode')
    assert.equal(reuseModes.length, 1, '复用会话也应应用权限')
    assert.deepEqual(reuseModes[0].data, { mode: 'read-only' })
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('applyFilePolicy skips duplicate writes and tolerates missing host service', async () => {
  const { root, store, config } = await setup()
  try {
    const ctx = fakeCtx({ sandboxPolicy: false })
    const runtime = await runtimeOf(ctx, store, config)
    const session = ctx.session
    runtime.applyFilePolicy({ agent: { session } }, { name: 'A', file_policy: 'workspace-write' })
    assert.equal(ctx.appended.length, 1)
    // 宿主没有 sandboxPolicy 服务时无法比对，按无覆盖处理再写一次也无害；这里只验证不抛。
    runtime.applyFilePolicy({ agent: { session } }, { name: 'A', file_policy: 'read-only' })
    assert.equal(ctx.appended.length, 2)
    // 库里值非法（不该发生）时绝不向宿主写覆盖。
    runtime.applyFilePolicy({ agent: { session } }, { name: 'A', file_policy: 'rm -rf /' })
    assert.equal(ctx.appended.length, 2)
    // overrideOf 报告已是目标值 → 不重复追加。
    const ctx2 = fakeCtx()
    ctx2.services.get('sandboxPolicy').overrideOf = () => 'workspace-write'
    const runtime2 = await runtimeOf(ctx2, store, config)
    runtime2.applyFilePolicy({ agent: { session: ctx2.session } }, { name: 'A', file_policy: 'workspace-write' })
    assert.equal(ctx2.appended.length, 0, '已是目标档位不应重复追加')
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('applyFilePolicy reads the optional service through ctx.get, never as a property', async () => {
  const { root, store, config } = await setup()
  try {
    // 复刻宿主 cordis 上下文：未声明 inject 的服务属性读取直接抛错。
    const ctx = fakeCtx()
    const realGet = ctx.get.bind(ctx)
    Object.defineProperty(ctx, 'sandboxPolicy', {
      get() { throw new Error('cannot get property "sandboxPolicy" without inject') },
    })
    ctx.get = name => realGet(name)
    const runtime = await runtimeOf(ctx, store, config)
    runtime.applyFilePolicy({ agent: { session: ctx.session } }, { name: 'A', file_policy: 'read-only' })
    const modes = ctx.appended.filter(call => call.type === 'sandbox/mode')
    assert.equal(modes.length, 1, '上下文未 inject 时也必须成功写入 sandbox/mode')
    assert.deepEqual(modes[0].data, { mode: 'read-only' })
  } finally {
    await closeQuietly(store)
    await rm(root, { recursive: true, force: true })
  }
})

test('UI marks file policy dropdowns on both bot forms', async () => {
  // 按 tests/terminal-ui.test.js 先例：读 ui/app.js 源码做关键标记断言（不跑浏览器）。
  const source = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
  // 两个表单（单聊配置 + 总览编辑/新建）都有 name="filePolicy" 下拉。
  const selects = source.match(/name="filePolicy"/g) ?? []
  assert.equal(selects.length, 2, '单聊配置页与总览表单各应有一个文件权限下拉')
  // 三个档位的中文标签都注册在选项表里。
  assert.match(source, /'read-only': '只读'/)
  assert.match(source, /'workspace-write': '工作区内修改'/)
  assert.match(source, /'danger-full-access': '完全访问'/)
  // 表单提交管道把 filePolicy 带进 create/update patch。
  assert.match(source, /filePolicy: payload\.filePolicy \|\| undefined/)
  // 回填用 bot.file_policy（botView 自动带出）。
  assert.match(source, /filePolicyOptions\(bot\.file_policy\)/)
  assert.match(source, /filePolicyOptions\(bot\?\.file_policy\)/)
})
