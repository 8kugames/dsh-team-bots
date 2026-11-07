// DSHBOTS-285（ADR §5.2-1）库与绑定收敛守门：
// ①新库索引面：one_bot_binding 存在、旧三车道索引已删；one_active_run_per_bot 已随
//   runMigrations 接线 activateBotRunSerialization（§5.2-2 已合），新库开库即建；
// ②one_bot_binding 约束：同 bot 恰一条 kind='bot' 活跃绑定，alias 行不受限；
// ③one_active_run_per_bot 约束：同 bot 至多一条 queued/running，终态释放后可再入队；
// ④存量迁移：旧四道活跃行 alias 化、project 会话转 kind='bot' 复用、幂等重跑不变；
// ⑤存量运行串行化：同 bot 多条 queued 只留最早一条，其余 canceled 留痕；
// ⑥ensureBotBinding：无绑定 bot 运行期补建控制面绑定，重复调用复用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { runMigrations, activateBotRunSerialization } from '../src/db-migrations.js'
import { resolveConfig } from '../src/config.js'
import { sessionMethods } from '../src/services/runtime/session.js'
import { TeamService } from '../src/service.js'

const MIGRATION_NAME = 'session_binding_bot_convergence'
const OLD_LANE_INDEXES = `
  CREATE UNIQUE INDEX one_project_binding
    ON session_bindings(bot_id, project_id, kind) WHERE task_id IS NULL AND project_id IS NOT NULL AND alias = 0;
  CREATE UNIQUE INDEX one_task_binding
    ON session_bindings(bot_id, project_id, kind, task_id) WHERE task_id IS NOT NULL AND alias = 0;
  CREATE UNIQUE INDEX one_solo_binding
    ON session_bindings(bot_id) WHERE kind = 'solo' AND project_id IS NULL AND task_id IS NULL AND alias = 0;
`

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-binding-convergence-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0, schedulerIntervalMs: 30_000,
  })
  const store = openDatabase(config.dbPath)
  return { root, store, config }
}

const cleanup = async ({ root, store }) => {
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const indexNames = (store) =>
  store.all("SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row.name)

const addBot = (store, id) => store.run(
  'INSERT INTO bots(id, name, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  id, id, 'fake', 'model-a', 'active', new Date().toISOString(), new Date().toISOString(),
)

const addProject = (store, id, ownerBotId) => store.run(
  'INSERT INTO projects(id, name, key, slug, owner_bot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  id, id, id.toUpperCase(), id.toLowerCase(), ownerBotId, new Date().toISOString(), new Date().toISOString(),
)

const addBinding = (store, { sessionId, botId, projectId = null, kind, taskId = null, alias = 0 }) => store.run(
  'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at, alias) VALUES (?, ?, ?, ?, ?, ?, ?)',
  sessionId, botId, projectId, kind, taskId, new Date().toISOString(), alias,
)

const addRun = (store, { id, botId, projectId = null, status = 'queued', queuedAt }: { id: string; botId: string; projectId?: string; status?: string; queuedAt?: string }) => store.run(
  `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
   VALUES (?, ?, ?, 'chat', 'read', 'test', ?, 1, ?, ?)`,
  id, projectId, botId, status, `ik:${id}`, queuedAt ?? new Date().toISOString(),
)

// 把已迁移的新库回退成「四车道旧库」形状：清掉收敛账本、重建旧三索引、恢复旧道活跃行。
const revertToLegacyLanes = (store, rows) => {
  store.run('DELETE FROM schema_migrations WHERE name = ?', MIGRATION_NAME)
  store.run('DROP INDEX IF EXISTS one_bot_binding')
  store.run('DROP INDEX IF EXISTS one_active_run_per_bot')
  store.exec(OLD_LANE_INDEXES)
  store.run("DELETE FROM session_bindings WHERE kind = 'bot'")
  for (const row of rows) addBinding(store, row)
}

test('新库索引面：one_bot_binding 存在、旧三车道索引已删；one_active_run_per_bot 随 runMigrations 激活', async (t) => {
  const ctx = await setup()
  t.after(() => cleanup(ctx))
  const names = indexNames(ctx.store)
  assert.ok(names.includes('one_bot_binding'), 'one_bot_binding 应存在')
  assert.ok(names.includes('one_active_run_per_bot'), 'runMigrations 已接线 activateBotRunSerialization，新库应自带 one_active_run_per_bot')
  for (const old of ['one_project_binding', 'one_task_binding', 'one_solo_binding']) {
    assert.ok(!names.includes(old), `旧索引 ${old} 应已删除`)
  }
})

test('one_bot_binding：同 bot 第二条 kind=bot 活跃绑定被拒，alias 行不受限', async (t) => {
  const ctx = await setup()
  t.after(() => cleanup(ctx))
  const { store } = ctx
  addBot(store, 'bot-a')
  addBinding(store, { sessionId: 'sess-bot-a', botId: 'bot-a', kind: 'bot' })
  assert.throws(
    () => addBinding(store, { sessionId: 'sess-bot-a-2', botId: 'bot-a', kind: 'bot' }),
    /UNIQUE/i,
    '同 bot 第二条 kind=bot 活跃绑定应撞唯一约束',
  )
  addBinding(store, { sessionId: 'sess-bot-a-old', botId: 'bot-a', kind: 'bot', alias: 1 })
  const active = store.all("SELECT * FROM session_bindings WHERE bot_id = 'bot-a' AND kind = 'bot' AND alias = 0")
  assert.equal(active.length, 1, 'alias 行不占活跃名额')
})

test('one_active_run_per_bot：同 bot 至多一条 queued，终态释放后可再入队，异 bot 并行不受限', async (t) => {
  const ctx = await setup()
  t.after(() => cleanup(ctx))
  const { store } = ctx
  activateBotRunSerialization(store.db)
  addBot(store, 'bot-a')
  addBot(store, 'bot-b')
  addRun(store, { id: 'run-a1', botId: 'bot-a' })
  assert.throws(
    () => addRun(store, { id: 'run-a2', botId: 'bot-a' }),
    /UNIQUE/i,
    '同 bot 第二条 queued 运行应撞唯一约束',
  )
  addRun(store, { id: 'run-b1', botId: 'bot-b' })
  store.run("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = 'run-a1'", new Date().toISOString())
  addRun(store, { id: 'run-a3', botId: 'bot-a' })
  const active = store.all("SELECT id FROM runs WHERE bot_id = 'bot-a' AND status = 'queued'")
  assert.deepEqual(active.map((row) => row.id), ['run-a3'])
})

test('存量迁移：旧四道活跃行 alias 化，最新 project 会话转 kind=bot 复用，幂等重跑不变', async (t) => {
  const ctx = await setup()
  t.after(() => cleanup(ctx))
  const { store } = ctx
  addBot(store, 'bot-a')
  addBot(store, 'bot-b')
  addProject(store, 'proj-1', 'bot-b')
  addProject(store, 'proj-2', 'bot-b')
  revertToLegacyLanes(store, [
    { sessionId: 'sess-a-proj1', botId: 'bot-a', projectId: 'proj-1', kind: 'project' },
    { sessionId: 'sess-a-proj2', botId: 'bot-a', projectId: 'proj-2', kind: 'project' },
    { sessionId: 'sess-a-task', botId: 'bot-a', projectId: 'proj-1', kind: 'task' },
    { sessionId: 'sess-a-dm', botId: 'bot-a', projectId: 'proj-1', kind: 'dm' },
    { sessionId: 'sess-b-proj', botId: 'bot-b', projectId: 'proj-1', kind: 'project' },
    { sessionId: 'sess-b-solo', botId: 'bot-b', kind: 'solo' },
  ])
  const snapshot = () => store.all(
    'SELECT session_id, bot_id, kind, alias FROM session_bindings ORDER BY session_id',
  )
  runMigrations(store.db)
  const after = snapshot()
  const botRow = (bot) => store.get(
    "SELECT * FROM session_bindings WHERE bot_id = ? AND kind = 'bot' AND alias = 0", bot,
  )
  assert.equal(botRow('bot-a')?.session_id, 'sess-a-proj2', '多项目 bot 复用最新 project 会话')
  assert.equal(botRow('bot-a')?.project_id, 'proj-2')
  assert.equal(botRow('bot-b')?.session_id, 'sess-b-proj', '单项目 bot 复用唯一 project 会话')
  assert.equal(
    store.get("SELECT COUNT(*) AS n FROM session_bindings WHERE alias = 0 AND kind != 'bot'").n,
    0,
    '旧四道活跃行应归零',
  )
  for (const session of ['sess-a-proj1', 'sess-a-task', 'sess-a-dm', 'sess-b-solo']) {
    assert.equal(store.get('SELECT alias FROM session_bindings WHERE session_id = ?', session).alias, 1)
  }
  const names = indexNames(store)
  assert.ok(names.includes('one_bot_binding'))
  assert.ok(names.includes('one_active_run_per_bot'), 'runMigrations 已接线激活，迁移后 one_active_run_per_bot 应在场')
  for (const old of ['one_project_binding', 'one_task_binding', 'one_solo_binding']) {
    assert.ok(!names.includes(old), `旧索引 ${old} 应被迁移删除`)
  }
  assert.ok(store.get('SELECT 1 FROM schema_migrations WHERE name = ?', MIGRATION_NAME))
  runMigrations(store.db)
  assert.deepEqual(snapshot(), after, '幂等重跑不应改变绑定表')
})

test('存量运行串行化：同 bot 多条 queued 只留最早一条，其余 canceled 留痕', async (t) => {
  const ctx = await setup()
  t.after(() => cleanup(ctx))
  const { store } = ctx
  addBot(store, 'bot-a')
  // 新库开库即带 one_active_run_per_bot（runMigrations 已接线激活）：先撤索引才能种出
  // 存量老库「同 bot 多条 queued 并存」的形状，再走激活迁移验证串行化收口。
  store.run('DROP INDEX IF EXISTS one_active_run_per_bot')
  const at = (ms) => new Date(Date.parse('2026-11-06T00:00:00Z') + ms).toISOString()
  addRun(store, { id: 'run-early', botId: 'bot-a', queuedAt: at(0) })
  addRun(store, { id: 'run-late', botId: 'bot-a', queuedAt: at(1_000) })
  addRun(store, { id: 'run-done', botId: 'bot-a', status: 'succeeded', queuedAt: at(2_000) })
  activateBotRunSerialization(store.db)
  assert.equal(store.get("SELECT status FROM runs WHERE id = 'run-early'").status, 'queued')
  const canceled = store.get("SELECT * FROM runs WHERE id = 'run-late'")
  assert.equal(canceled.status, 'canceled')
  assert.equal(canceled.error_code, 'BOT_SERIALIZATION')
  assert.ok(indexNames(store).includes('one_active_run_per_bot'), '串行化后索引应建成')
})

test('ensureBotBinding：无绑定 bot 运行期新建控制面会话，重复调用复用不重建', async (t) => {
  const ctx = await setup()
  t.after(() => cleanup(ctx))
  const { store, config } = ctx
  const created = []
  const host = {
    sessionController: {
      resolveAgent: async () => ({}),
      selectModel: async () => ({}),
      create: async () => {
        const sessionId = `sess-ctl-${created.length + 1}`
        created.push(sessionId)
        return { sessionId }
      },
    },
  }
  const rt = {
    store, config, ctx: host, logger: { info() {}, warn() {}, error() {} },
    sessionCreates: new Map(),
    selectModel: async () => {},
    defaultAgentPreset: async () => ({}),
    // DSHBOTS-289 后 ensureBotBinding 自带策略面；本测只钉建行/复用，全部空实现。
    applyFilePolicy() {},
    shouldRolloverSession: () => false,
    maybeCompactSession() {},
    retireBinding: sessionMethods.retireBinding,
  }
  addBot(store, 'bot-a')
  addProject(store, 'proj-1', 'bot-a')
  const bot = store.get("SELECT * FROM bots WHERE id = 'bot-a'")
  const project = store.get("SELECT * FROM projects WHERE id = 'proj-1'")
  const first = await sessionMethods.ensureBotBinding.call(rt, bot, project)
  const second = await sessionMethods.ensureBotBinding.call(rt, bot, project)
  assert.equal(first, second)
  assert.equal(created.length, 1, '已有控制面绑定时不应新建会话')
  const binding = store.get("SELECT * FROM session_bindings WHERE session_id = ?", first)
  assert.equal(binding.kind, 'bot')
  assert.equal(binding.alias, 0)
  assert.equal(binding.project_id, 'proj-1')
  assert.equal(
    store.get("SELECT COUNT(*) AS n FROM session_bindings WHERE bot_id = 'bot-a' AND kind = 'bot' AND alias = 0").n,
    1,
    '每 bot 恰一条 kind=bot 活跃绑定',
  )
})

// ── V1 四路合并（DSHBOTS-296，ADR §6 V1 终验）──────────────────────────
// 同一 bot 相继触发任务派发/群聊/私信/单聊四条入站路，断言收敛不变量：
// alias=0 绑定恰 1 行 kind='bot'，四类运行全部落同一条控制面会话。
// startRun 只镜像真实现的会话面（ensureSession 解析 + runs.session_id 写回，
// 见 src/services/runtime/session.ts startRun），不拉起 prompt 管线。
class ControlPlaneRuntime {
  declare started: any[]; declare steers: any[]; declare busySessions: any; declare handler: any
  declare store: any; declare config: any; declare ctx: any; declare logger: any
  declare sessionCreates: any; declare sessionCounter: any

  constructor(config: any) {
    this.started = []
    this.steers = []
    this.busySessions = new Set()
    this.sessionCounter = 0
    this.config = config
    this.logger = { info() {}, warn() {}, error() {} }
    this.sessionCreates = new Map()
    this.ctx = {
      sessionController: {
        resolveAgent: async () => ({}),
        selectModel: async () => ({}),
        create: async () => ({ sessionId: `sess-cp-${++this.sessionCounter}` }),
      },
    }
  }

  setCompletionHandler(handler: any) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  sessionBusy(sessionId: string) { return this.busySessions.has(sessionId) }
  async selectModel() {}
  async defaultAgentPreset() { return {} }
  applyFilePolicy() {}
  shouldRolloverSession() { return false }
  maybeCompactSession() {}
  taskAffinityBinding(task: any) { return sessionMethods.taskAffinityBinding.call(this, task) }
  ensureBotBinding(bot: any, project: any, opts: any) { return sessionMethods.ensureBotBinding.call(this, bot, project, opts) }
  retireBinding(sessionId: string) { return sessionMethods.retireBinding.call(this, sessionId) }

  async startRun({ run, bot, project, task }: any) {
    const sessionId = await sessionMethods.ensureSession.call(this, bot, project, { run, task })
    this.store.run('UPDATE runs SET session_id = ? WHERE id = ?', sessionId, run.id)
    this.started.push({ runId: run.id, kind: run.kind })
    return sessionId
  }

  async steer(sessionId: string, text: string) { this.steers.push({ sessionId, text }); return true }
  async cancelRun() { return true }
  complete(runId: string, status = 'succeeded', output = 'done') {
    return this.handler({ runId, status, output, error: null })
  }
}

test('V1 四路合并（DSHBOTS-299 三分域）：任务/群聊/私信落 (bot,project) 控制面，单聊落 (bot,NULL) solo 会话', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-binding-v1-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0, schedulerIntervalMs: 60_000,
  })
  t.after(async () => {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ControlPlaneRuntime(config)
  runtime.store = store
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = false
  store.setSetting('memory_review', '0')
  store.setSetting('chat_memory_review', '0')

  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'V1', key: 'VONE', memberIds: [dev.id] })
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")

  // 任务派发（autoStart 立即落 queued 占道，其余三路随后到达全部挂起）。
  await service.createTask({ projectId: project.id, title: 'V1 四路合并', assigneeBotId: dev.id, autoStart: true })
  // 群聊：@提及路由到 Builder。
  await service.sendMessage(project.id, '@Builder 群里报个进度')
  // 私信：总监 → Builder（与 dm.test.ts 同款 bot_messages 形状），忙时入队挂起。
  store.run(
    `INSERT INTO bot_messages(id, project_id, from_bot_id, to_bot_id, request_id, text, origin_session_id, origin_kind, status, created_at)
     VALUES ('botm_v1_dm', ?, ?, ?, 'v1-dm', '私聊问一句', 'sess-director-ui', 'dm', 'pending', ?)`,
    project.id, director.id, dev.id, new Date().toISOString(),
  )
  const dmMessage = store.get('SELECT * FROM bot_messages WHERE id = ?', 'botm_v1_dm')
  assert.equal(service.enqueueDmRun(dmMessage, dev), null, 'bot 忙时 dm 不落 runs 行，挂待处理队列')
  // 单聊。
  await service.sendSoloMessage(dev.id, '单聊问一句')

  // 串行放行：开闸后逐拍启动/收尾，直到挂起队列与活跃运行清空。startRun 的会话解析
  // 异步落地（executeRun 不阻塞 tick），完成运行前先等 runs.session_id 写回。
  const waitFor = async (fn: () => any, ms = 3000) => {
    const deadline = Date.now() + ms
    for (;;) {
      const value = fn()
      if (value) return value
      if (Date.now() >= deadline) return value
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  service.started = true
  for (let i = 0; i < 16; i++) {
    await service.tick()
    const running = store.get("SELECT id FROM runs WHERE status = 'running' LIMIT 1")
    if (running) {
      const landed = await waitFor(() =>
        store.get('SELECT session_id AS s FROM runs WHERE id = ?', running.id).s)
      assert.ok(landed, '运行启动应完成会话解析并写回 session_id')
      await runtime.complete(running.id, 'succeeded', 'done')
      continue
    }
    const held = JSON.parse(store.setting(`bot_pending_msgs:${dev.id}`) ?? '[]')
    const active = store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')").n
    if (!held.length && !active) break
  }
  assert.equal(JSON.parse(store.setting(`bot_pending_msgs:${dev.id}`) ?? '[]').length, 0, '挂起队列应清空')

  // V1 核心断言（DSHBOTS-299 会话域三分）：alias=0 绑定恰 2 行——项目域 (bot,project)
  // 一条承接 task/chat/dm，solo 域 (bot,NULL) 一条承接 solo_chat（各 bot 专属工作区）。
  const activeBindings = store.all("SELECT * FROM session_bindings WHERE bot_id = ? AND alias = 0", dev.id)
  assert.equal(activeBindings.length, 2, '四路触发后 alias=0 绑定应为项目域+solo 域各 1 行')
  assert.ok(activeBindings.every(row => row.kind === 'bot'), '绑定 kind 应均为 bot')
  const projectBinding = activeBindings.find(row => row.project_id === project.id)
  const soloBinding = activeBindings.find(row => row.project_id === null)
  assert.ok(projectBinding, '项目域控制面绑定应存在（project_id 命中）')
  assert.ok(soloBinding, 'solo 域绑定应存在（project_id NULL）')
  assert.equal(
    store.get("SELECT COUNT(*) AS n FROM session_bindings WHERE kind != 'bot'").n,
    0,
    '四路全程不应建出任何旧车道绑定',
  )
  for (const kind of ['task', 'chat', 'dm']) {
    const run = store.get("SELECT * FROM runs WHERE bot_id = ? AND kind = ?", dev.id, kind)
    assert.ok(run, `四路中缺少 ${kind} 运行`)
    assert.equal(run.session_id, projectBinding.session_id, `${kind} 运行应落 (bot,project) 控制面会话`)
  }
  const soloRun = store.get("SELECT * FROM runs WHERE bot_id = ? AND kind = 'solo_chat'", dev.id)
  assert.ok(soloRun, '四路中缺少 solo_chat 运行')
  assert.equal(soloRun.session_id, soloBinding.session_id, 'solo_chat 运行应落 bot 专属工作区 solo 会话，不混项目控制面')
  // dm 回信（dm_reply）落发起方 director 自己的控制面绑定，不影响 Builder 的绑定不变量。
  assert.equal(
    store.all('SELECT DISTINCT session_id FROM runs WHERE bot_id = ? AND kind IN (\'task\',\'chat\',\'dm\',\'solo_chat\')', dev.id).length,
    2,
    'Builder 四路运行应只用到项目域与 solo 域两条会话',
  )
})
