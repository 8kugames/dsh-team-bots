// DSHBOTS-25：Bot 备用模型——主 provider 不可用时临时切备用模型继续执行任务，运行结束自动回退。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { modelOverrideFor } from '../src/services/runtime/session.js'

// 不真正启动会话：finishRun / 派生逻辑全部用直接落库的 run 行驱动。
class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-fallback-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 20 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service, config }
}

const mins = n => new Date(Date.now() + n * 60_000).toISOString()

// 落一条运行中的 run；kind 决定是否允许派生备用运行。
function insertRun(store, { id, projectId, botId, taskId = null, kind = 'task', attempt = 1 }) {
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status, attempt,
       idempotency_key, queued_at, started_at)
     VALUES (?, ?, ?, ?, ?, 'write', 'manual', 't', 'running', ?, ?, ?, ?)`,
    id, projectId, botId, taskId, kind, attempt, `idem-${id}`, mins(-2), mins(-2),
  )
}

// 给 bot 配上备用模型（走公开的 updateBot，顺带覆盖配置路径）。
async function withFallback(service, botId, { provider = 'openai', model = 'gpt-4o-mini', effort = null } = {}) {
  return service.updateBot(botId, { fallbackProvider: provider, fallbackModel: model, fallbackEffort: effort }, { type: 'user', id: 'u' })
}

test('备用模型配置：provider/model 成对校验，botView 透传', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await assert.rejects(
      () => service.updateBot(director.id, { fallbackProvider: 'openai' }, { type: 'user', id: 'u' }),
      /备用模型的 provider 和 model 必须同时提供/,
    )
    const view = await withFallback(service, director.id)
    assert.equal(view.fallbackConfigured, true)
    assert.equal(view.fallbackModelRef, 'openai/gpt-4o-mini')
    assert.equal(view.fallback_effort, null)
    // 审计留痕
    const audit = store.get("SELECT * FROM audit_log WHERE action = 'bot.update' ORDER BY created_at DESC LIMIT 1")
    assert.ok(audit, 'bot.update 应有审计记录')
    assert.match(audit.data_json ?? '', /fallback_provider/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('未配置备用模型：失败不派生', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'MF1', key: 'MF1', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '无备用', assigneeBotId: director.id })
    insertRun(store, { id: 'f1', projectId: project.id, botId: director.id, taskId: task.id })

    await service.finishRun({ runId: 'f1', status: 'failed', output: '', error: { code: 'AUTH', message: 'bad key' } } as any)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?', 'f1').n, 0)
    assert.equal(store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'blocked')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('错误码不在白名单：配了备用也不派生', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'MF2', key: 'MF2', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '非白名单', assigneeBotId: director.id })
    await withFallback(service, director.id)
    insertRun(store, { id: 'f2', projectId: project.id, botId: director.id, taskId: task.id })

    await service.finishRun({ runId: 'f2', status: 'failed', output: '', error: { code: 'MISSING_CONTEXT', message: 'no context' } } as any)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?', 'f2').n, 0)
    assert.equal(store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'blocked')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('主 provider 不可用：派生一次备用运行，任务不置 blocked、不转总监', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'MF3', key: 'MF3', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '切备用', assigneeBotId: director.id })
    await withFallback(service, director.id)
    insertRun(store, { id: 'f3', projectId: project.id, botId: director.id, taskId: task.id })

    await service.finishRun({ runId: 'f3', status: 'failed', output: '', error: { code: 'AUTH', message: 'bad key' } } as any)

    const derived = store.get('SELECT * FROM runs WHERE parent_run_id = ?', 'f3')
    assert.ok(derived, '应派生备用运行')
    assert.equal(derived.kind, 'task')
    assert.equal(derived.status, 'queued')
    assert.equal(derived.attempt, 2)
    assert.equal(derived.task_id, task.id)
    assert.equal(derived.model_provider, 'openai')
    assert.equal(derived.model_model, 'gpt-4o-mini')
    // 原 run 保持 failed，并留 model_fallback 事件
    assert.equal(store.get('SELECT status FROM runs WHERE id = ?', 'f3').status, 'failed')
    const evt = store.get("SELECT * FROM run_events WHERE run_id = 'f3' AND type = 'model_fallback'")
    assert.ok(evt, '原 run 应留 model_fallback 事件')
    assert.match(evt.message, /AUTH/)
    // 任务不置 blocked，也不派 owner handle
    assert.notEqual(store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'blocked')
    assert.equal(store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'owner_task_run'").n, 0)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('每条运行链只切一次：备用运行再失败不再派生', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'MF4', key: 'MF4', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '只切一次', assigneeBotId: director.id })
    await withFallback(service, director.id)
    insertRun(store, { id: 'f4', projectId: project.id, botId: director.id, taskId: task.id })

    await service.finishRun({ runId: 'f4', status: 'failed', output: '', error: { code: 'AUTH', message: 'bad key' } } as any)
    const derived = store.get('SELECT * FROM runs WHERE parent_run_id = ?', 'f4')
    assert.ok(derived)

    // 备用运行接手后再次失败：不再派生第二次备用
    store.run("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?", mins(-1), derived.id)
    await service.finishRun({ runId: derived.id, status: 'failed', output: '', error: { code: 'AUTH', message: 'still bad' } } as any)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?', derived.id).n, 0)
    assert.equal(store.get("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND model_provider IS NOT NULL", task.id).n, 1)
    // 链上已切过一次 → 任务回到常规失败处置
    assert.equal(store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'blocked')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('私信/单聊不派生：只标出主模型不可用', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await withFallback(service, director.id)
    insertRun(store, { id: 'd1', projectId: null, botId: director.id, kind: 'dm' })
    await service.finishRun({ runId: 'd1', status: 'failed', output: '', error: { code: 'AUTH', message: 'bad key' } } as any)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?', 'd1').n, 0)
    const view = service.runView(store.get('SELECT * FROM runs WHERE id = ?', 'd1'))
    assert.equal(view.modelFallback.configured, true)
    assert.equal(view.modelFallback.degraded, true)
    assert.equal(view.modelFallback.applied, false)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('runView 标记：派生运行 applied=true，普通失败运行 degraded=true', async () => {
  const { root, store, service } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    const project = await service.createProject({ name: 'MF5', key: 'MF5', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '标记', assigneeBotId: director.id })
    await withFallback(service, director.id, { provider: 'anthropic', model: 'claude-sonnet' })
    insertRun(store, { id: 'v1', projectId: project.id, botId: director.id, taskId: task.id })
    await service.finishRun({ runId: 'v1', status: 'failed', output: '', error: { code: 'SERVER', message: '5xx' } } as any)

    const derived = store.get('SELECT * FROM runs WHERE parent_run_id = ?', 'v1')
    const derivedView = service.runView(derived)
    assert.equal(derivedView.modelFallback.applied, true)
    assert.equal(derivedView.modelFallback.usedModel, 'anthropic/claude-sonnet')
    assert.equal(derivedView.modelFallback.degraded, false)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('自动回退：下一条运行不带 override，按 Bot 主模型下发', async () => {
  const { root, store, service, config } = await setup()
  try {
    const director = store.get("SELECT * FROM bots WHERE name = 'director'")
    await service.updateBot(director.id, { provider: 'anthropic', model: 'claude-opus' }, { type: 'user', id: 'u' })
    const project = await service.createProject({ name: 'MF6', key: 'MF6', ownerBotId: director.id })
    const task = await service.createTask({ projectId: project.id, title: '回退', assigneeBotId: director.id })

    // run 行 → 模型覆盖的映射
    assert.equal(modelOverrideFor({}), null)
    assert.deepEqual(modelOverrideFor({ model_provider: 'openai', model_model: 'gpt-4o-mini', model_effort: 'high' }),
      { provider: 'openai', model: 'gpt-4o-mini', effort: 'high' })

    const calls = []
    const ctx = {
      get: () => undefined,
      sessionController: {
        resolveAgent: async () => ({ agent: { session: null } }),
        selectModel: async (arg) => { calls.push(arg); return { selected: arg } },
      },
    }
    const runtime = new DshRuntime({ ctx, config, store, logger: { info() {}, warn() {}, error() {} } })
    const bot = store.get('SELECT * FROM bots WHERE id = ?', director.id)
    store.run(
      `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at)
       VALUES ('sess-1', ?, ?, 'task', ?, ?)`,
      bot.id, project.id, task.id, mins(-10),
    )

    // 备用运行：下发备用模型
    await runtime.ensureSession(bot, project, { run: { kind: 'task' }, task, modelOverride: { provider: 'openai', model: 'gpt-4o-mini' } })
    assert.deepEqual(
      { provider: calls.at(-1).provider, model: calls.at(-1).model },
      { provider: 'openai', model: 'gpt-4o-mini' },
    )

    // 下一条运行：没有 override → 回到主模型（自动回退）
    await runtime.ensureSession(bot, project, { run: { kind: 'task' }, task })
    assert.deepEqual(
      { provider: calls.at(-1).provider, model: calls.at(-1).model },
      { provider: 'anthropic', model: 'claude-opus' },
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
