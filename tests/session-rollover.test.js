// DSHBOTS-145：会话结转（单 bot 聊天会话超阈值后结转新会话并注入 bot 自写摘要）。
// 覆盖：阈值未触发/触发、摘要未就绪继续复用旧会话（含幂等补排）、摘要就绪删旧绑定走新建、
// 新会话首轮提示词注入摘要一次且清零后不重复注入、0=关闭、task/dm 不结转、
// 摘要运行路由回旧会话、finishRun 成功落库/失败留痕、单聊（无项目）结转、
// 支撑索引迁移幂等、executeRun→摘要提示词→finishRun→下次复用开新会话的完整链路。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig, rolloverSummaryKey } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { ensureRolloverSchema, ROLLOVER_MIGRATION } from '../src/services/rollover-schema.js'

const logger = { info() {}, warn() {}, error() {} }
const TURNS = 3

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup({ turns = TURNS } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-rollover-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0, schedulerIntervalMs: 30_000, sessionRolloverTurns: turns,
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

// 捕获版最小宿主替身：录下每次下发的提示词，并给出可控的新建会话 id。
const captureHost = (sink) => {
  const created = []
  return {
    created,
    sessionController: {
      resolveAgent: async () => ({}),
      selectModel: async () => ({}),
      create: async () => {
        const sessionId = `sess-new-${created.length + 1}`
        created.push(sessionId)
        return { sessionId }
      },
      prompt: async (request) => { sink.push(request.content.map(part => part.text ?? '').join('\n')) },
      cancel: async () => {},
    },
  }
}

const newRuntime = (ctx, config, store) => new DshRuntime({ ctx, config, store, logger })

async function primeProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Rollover', key: 'RLV', ownerBotId: director.id, memberIds: [dev.id] })
  return { director, dev, project }
}

const bindSession = (store, { botId, projectId, sessionId, kind = 'project', taskId = null }) => {
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    sessionId, botId, projectId, kind, taskId, new Date().toISOString(),
  )
}

// 轮次口径 = runs 表按 session_id 的 COUNT(*)（不限 status），直接落库模拟历史运行。
const seedRuns = (store, { projectId, botId, sessionId, count, kind = 'chat' }) => {
  const at = new Date().toISOString()
  for (let i = 0; i < count; i += 1) {
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, session_id, queued_at)
       VALUES (?, ?, ?, ?, 'read', 'test', 'succeeded', 1, ?, ?, ?)`,
      `run_seed_${sessionId}_${i}`, projectId, botId, kind, `seed:${sessionId}:${i}`, sessionId, at,
    )
  }
}

const rolloverRuns = (store) => store.all("SELECT * FROM runs WHERE kind = 'rollover_summary'")

test('阈值未触发：轮数低于阈值时复用旧会话，且不排摘要运行', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: TURNS - 1 })

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    const sessionId = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })

    assert.equal(sessionId, 'sess-old', '低于阈值应复用旧会话')
    assert.equal(rolloverRuns(ctx.store).length, 0, '低于阈值不得排摘要运行')
  } finally {
    await cleanup(ctx)
  }
})

test('阈值触发且摘要未就绪：幂等补排一条摘要运行，并继续复用旧会话（不阻塞对话）', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: TURNS })

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    const sessionId = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })

    assert.equal(sessionId, 'sess-old', '摘要未就绪不得开新会话')
    const queued = rolloverRuns(ctx.store)
    assert.equal(queued.length, 1, '应恰好补排一条摘要运行')
    assert.equal(queued[0].status, 'queued')
    assert.equal(queued[0].mode, 'read', '摘要运行只读')
    assert.equal(queued[0].session_id, 'sess-old', '摘要运行必须复用旧会话')
    assert.equal(queued[0].trigger_ref, 'sess-old')
    assert.equal(queued[0].idempotency_key, 'rollover_summary:sess-old')
    assert.equal(
      ctx.store.all("SELECT type FROM run_events WHERE run_id = ? AND type = 'queued'", queued[0].id).length,
      1,
      '应留 queued 事件',
    )

    const again = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    assert.equal(again, 'sess-old')
    assert.equal(rolloverRuns(ctx.store).length, 1, '摘要运行未结束不得重复排队')
  } finally {
    await cleanup(ctx)
  }
})

test('摘要就绪后：删旧绑定走新建会话，旧 session 宿主侧不受影响', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: TURNS })

    const host = captureHost([])
    const runtime = newRuntime(host, ctx.config, ctx.store)
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'chat' } }), 'sess-old')
    assert.equal(rolloverRuns(ctx.store).length, 1)

    ctx.store.setSetting(rolloverSummaryKey(dev.id, project.id), '旧会话交接：任务 A 完成 80%，未决问题 B。')
    const sessionId = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })

    assert.equal(sessionId, 'sess-new-1', '摘要就绪后应开新会话')
    assert.equal(ctx.store.get('SELECT * FROM session_bindings WHERE session_id = ?', 'sess-old'), undefined, '旧绑定应删除')
    assert.ok(ctx.store.get('SELECT * FROM session_bindings WHERE session_id = ?', 'sess-new-1'), '新绑定应建立')
    assert.deepEqual(host.created, ['sess-new-1'], '只新建一次会话；旧 session 只删绑定不删宿主会话')
  } finally {
    await cleanup(ctx)
  }
})

test('新会话首轮提示词注入摘要块一次，清零后不重复注入', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    ctx.store.setSetting(rolloverSummaryKey(dev.id, project.id), '交接摘要正文。')

    const first = runtime.promptFor({ run: { kind: 'chat' }, bot: dev, project, chatMessage: { body: '在吗' }, sessionId: 'sess-new-1' })
    assert.ok(first.includes('# Handoff summary from the previous session'), '首轮应注入摘要块')
    assert.ok(first.includes('交接摘要正文。'), '摘要正文应原样注入')
    assert.equal(ctx.store.setting(rolloverSummaryKey(dev.id, project.id)), '', '注入后应即刻清零')

    const second = runtime.promptFor({ run: { kind: 'chat' }, bot: dev, project, chatMessage: { body: '继续' }, sessionId: 'sess-new-1' })
    assert.ok(!second.includes('# Handoff summary from the previous session'), '清零后不得重复注入')
  } finally {
    await cleanup(ctx)
  }
})

test('0=关闭：阈值 0 时不结转、不排摘要运行', async () => {
  const ctx = await setup({ turns: 0 })
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: 999 })

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    const sessionId = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })

    assert.equal(sessionId, 'sess-old', '关闭时应继续复用旧会话')
    assert.equal(rolloverRuns(ctx.store).length, 0, '关闭时不得排摘要运行')
  } finally {
    await cleanup(ctx)
  }
})

test('摘要运行路由回旧会话：ensureSession 直接复用 run.session_id，不新建也不再排摘要', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: TURNS })

    const host = captureHost([])
    const runtime = newRuntime(host, ctx.config, ctx.store)
    await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    const summary = rolloverRuns(ctx.store)[0]

    const sessionId = await runtime.ensureSession(dev, project, { run: summary })
    assert.equal(sessionId, 'sess-old', '摘要运行应回到旧会话')
    assert.equal(host.created.length, 0, '摘要运行不得新建会话')
    assert.equal(rolloverRuns(ctx.store).length, 1, '摘要运行自身不得再触发结转')
  } finally {
    await cleanup(ctx)
  }
})

test('finishRun 收尾：成功落 settings 并留 ready 痕，失败留 failed 痕且不写摘要', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const project2 = await ctx.service.createProject({ name: 'Rollover 2', key: 'RL2', ownerBotId: project.owner_bot_id, memberIds: [dev.id] })
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old-1' })
    bindSession(ctx.store, { botId: dev.id, projectId: project2.id, sessionId: 'sess-old-2' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old-1', count: TURNS })
    seedRuns(ctx.store, { projectId: project2.id, botId: dev.id, sessionId: 'sess-old-2', count: TURNS })

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    await runtime.ensureSession(dev, project2, { run: { kind: 'chat' } })
    const [summary1, summary2] = rolloverRuns(ctx.store)

    await ctx.service.finishRun({ runId: summary1.id, status: 'succeeded', output: '交接：进行中任务 X。' })
    assert.equal(ctx.store.setting(rolloverSummaryKey(dev.id, project.id)), '交接：进行中任务 X。')
    assert.equal(
      ctx.store.all("SELECT type FROM run_events WHERE run_id = ? AND type = 'rollover_summary_ready'", summary1.id).length,
      1,
      '成功应留 rollover_summary_ready 事件',
    )

    await ctx.service.finishRun({ runId: summary2.id, status: 'failed', output: '', error: { message: 'boom' } })
    assert.equal(ctx.store.setting(rolloverSummaryKey(dev.id, project2.id)), null, '失败不得写摘要')
    assert.equal(
      ctx.store.all("SELECT type FROM run_events WHERE run_id = ? AND type = 'rollover_summary_failed'", summary2.id).length,
      1,
      '失败应留 rollover_summary_failed 事件',
    )
  } finally {
    await cleanup(ctx)
  }
})

test('单聊结转：无项目上下文也能排摘要运行、落库并注入', async () => {
  const ctx = await setup({ turns: 2 })
  try {
    const { dev } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: null, sessionId: 'sess-solo', kind: 'solo' })
    seedRuns(ctx.store, { projectId: null, botId: dev.id, sessionId: 'sess-solo', count: 2, kind: 'solo_chat' })

    const host = captureHost([])
    const runtime = newRuntime(host, ctx.config, ctx.store)
    assert.equal(await runtime.ensureSession(dev, null, { run: { kind: 'solo_chat' } }), 'sess-solo')

    const summary = rolloverRuns(ctx.store)[0]
    assert.equal(summary.project_id, null, '单聊摘要运行不带项目')
    assert.equal(summary.session_id, 'sess-solo')

    await ctx.service.finishRun({ runId: summary.id, status: 'succeeded', output: '单聊交接摘要' })
    assert.equal(ctx.store.setting(rolloverSummaryKey(dev.id, null)), '单聊交接摘要')

    const second = await runtime.ensureSession(dev, null, { run: { kind: 'solo_chat' } })
    assert.equal(second, 'sess-new-1', '摘要就绪后单聊也应开新会话')
    const prompt = runtime.promptFor({ run: { kind: 'solo_chat' }, bot: dev, chatMessage: { body: '在吗' }, sessionId: second })
    assert.ok(prompt.includes('# Handoff summary from the previous session'), '单聊新会话应注入摘要块')
    assert.ok(prompt.includes('单聊交接摘要'))
  } finally {
    await cleanup(ctx)
  }
})

test('并发兜底：同一会话重复补排摘要运行不抛唯一约束错，也不产生第二条', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)

    runtime.enqueueRolloverSummary({ bot: dev, project, sessionId: 'sess-old' })
    assert.doesNotThrow(() => runtime.enqueueRolloverSummary({ bot: dev, project, sessionId: 'sess-old' }), '重复补排不得抛错（否则会带崩当前对话运行）')
    assert.equal(rolloverRuns(ctx.store).length, 1, '重复补排不得产生第二条摘要运行')
  } finally {
    await cleanup(ctx)
  }
})

test('task 与 dm 会话不结转：超阈值也不排摘要运行', async () => {
  const ctx = await setup({ turns: 1 })
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const task = await ctx.service.createTask({ projectId: project.id, title: '任务会话', assigneeBotId: dev.id }, ctx.service.actor())
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-task', kind: 'task', taskId: task.id })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-task', count: 50, kind: 'task' })
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-dm', kind: 'dm' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-dm', count: 50, kind: 'dm' })

    const runtime = newRuntime(captureHost([]), ctx.config, ctx.store)
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'task' }, task }), 'sess-task')
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'dm' } }), 'sess-dm')
    assert.equal(rolloverRuns(ctx.store).length, 0, 'task/dm 不结转')
  } finally {
    await cleanup(ctx)
  }
})

test('支撑索引迁移幂等：建库后建索引并登记恰一次，重开库不重复登记', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rollover-schema-'))
  try {
    const workspace = join(root, 'workspace')
    const dataDir = join(root, 'data')
    await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
    const config = resolveConfig({
      workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000,
    })
    const store = openDatabase(config.dbPath)
    const hasIndex = () => store.all("PRAGMA index_list('runs')").some(row => row.name === 'runs_session_idx')
    const ledgerCount = () => store.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?', ROLLOVER_MIGRATION).n

    // 建库 SCHEMA（db.js）不含该索引——索引由结转域自管迁移负责。
    assert.equal(hasIndex(), false, '建库 DDL 不含 runs_session_idx')
    ensureRolloverSchema(store)
    assert.equal(hasIndex(), true, '迁移后应有 runs_session_idx')
    assert.equal(ledgerCount(), 1)
    ensureRolloverSchema(store)
    assert.equal(ledgerCount(), 1, '同 store 重跑不得重复登记')

    store.close()
    const reopened = openDatabase(config.dbPath)
    try {
      ensureRolloverSchema(reopened)
      assert.equal(reopened.all("PRAGMA index_list('runs')").some(row => row.name === 'runs_session_idx'), true)
      assert.equal(
        reopened.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?', ROLLOVER_MIGRATION).n,
        1,
        '重开库不重复登记',
      )
    } finally {
      reopened.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('完整链路：executeRun 下发生成摘要提示词 → finishRun 落库 → 下次复用开新会话并注入', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: TURNS })

    const prompts = []
    const runtime = newRuntime(captureHost(prompts), ctx.config, ctx.store)
    // 把真实 runtime 挂到 service，executeRun 才会走真实 startRun。
    ctx.service.attachRuntime(runtime)

    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'chat' } }), 'sess-old')
    const summary = rolloverRuns(ctx.store)[0]

    await ctx.service.executeRun(summary.id)
    const pending = runtime.pendingByRun.get(summary.id)
    if (pending?.timer) clearTimeout(pending.timer)

    assert.ok(prompts[0]?.includes('# Handoff summary request'), '摘要运行应下发摘要请求提示词')
    assert.ok(!prompts[0]?.includes('# Handoff summary from the previous session'), '旧会话不得注入新会话摘要块')

    await ctx.service.finishRun({ runId: summary.id, status: 'succeeded', output: '交接摘要：进行中任务 Y，未决问题 Z。' })
    assert.equal(ctx.store.setting(rolloverSummaryKey(dev.id, project.id)), '交接摘要：进行中任务 Y，未决问题 Z。')

    const second = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    assert.equal(second, 'sess-new-1', '摘要就绪后应开新会话')
    const chatPrompt = runtime.promptFor({ run: { kind: 'chat' }, bot: dev, project, chatMessage: { body: '继续' }, sessionId: second })
    assert.ok(chatPrompt.includes('交接摘要：进行中任务 Y，未决问题 Z。'), '新会话首轮提示词应注入摘要')
  } finally {
    await cleanup(ctx)
  }
})
