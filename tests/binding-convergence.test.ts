// DSHBOTS-285（ADR §5.2-1）库与绑定收敛守门：
// ①新库索引面：one_bot_binding 存在、旧三车道索引已删；one_active_run_per_bot 机制已落地但
//   激活与 §5.2-2 同车（现行合批=领取时合并，先建索引实测红 68 例），新库暂不建；
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

test('新库索引面：one_bot_binding 存在、旧三车道索引已删；one_active_run_per_bot 待 §5.2-2 激活', async (t) => {
  const ctx = await setup()
  t.after(() => cleanup(ctx))
  const names = indexNames(ctx.store)
  assert.ok(names.includes('one_bot_binding'), 'one_bot_binding 应存在')
  assert.ok(!names.includes('one_active_run_per_bot'), '激活前不应建 one_active_run_per_bot')
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
  assert.ok(!names.includes('one_active_run_per_bot'), '运行串行化索引随 §5.2-2 激活，本步不建')
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
