// DSHBOTS-286：512 轮结转 + 每 64 轮闲时总结压缩（忙时推后/合批）。
// 覆盖：默认值（512/64）与生效链、64 轮边界闲时触发、幂等不重排、忙时推后跨窗口合批、
// 压缩≠结转（不 alias 化/不新建/不排 rollover）、compact=0 关闭、压缩运行路由回原会话
// 与提示词/收尾留痕、结转后任务亲和路由（未终态任务落旧会话/新任务落活跃控制面绑定）、
// alias 会话不重复结转、旧会话（承接任务流量）仍被压缩触发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import {
  SESSION_COMPACT_TURNS_KEY,
  resolveConfig,
  effectiveSessionCompactTurns,
  rolloverSummaryKey,
  sessionCompactMarkerKey,
} from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'

const logger = { info() {}, warn() {}, error() {} }

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup({ rolloverTurns = 999, compactTurns = 4 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-compact-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0, schedulerIntervalMs: 30_000,
    sessionRolloverTurns: rolloverTurns, sessionCompactTurns: compactTurns,
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

const captureHost = (sink = []) => ({
  created: [] as string[],
  sessionController: {
    resolveAgent: async () => ({}),
    selectModel: async () => ({}),
    create: async () => {
      const sessionId = `sess-new-${captureCounter()}`
      return { sessionId }
    },
    prompt: async (request: any) => { sink.push(request.content.map((part: any) => part.text ?? '').join('\n')) },
    cancel: async () => {},
  },
})

let createdSeq = 0
const captureCounter = () => { createdSeq += 1; return createdSeq }

const newRuntime = (ctx: any, config: any, store: any) => new DshRuntime({ ctx, config, store, logger } as any)

async function primeProject(service: any, store: any) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Compact', key: 'CMP', ownerBotId: director.id, memberIds: [dev.id] })
  return { director, dev, project }
}

// 种子绑定默认即 bot 的 kind='bot' 控制面绑定（DSHBOTS-289 收敛后唯一活跃车道）。
const bindSession = (store: any, { botId, projectId, sessionId, kind = 'bot', taskId = null }) => {
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    sessionId, botId, projectId, kind, taskId, new Date().toISOString(),
  )
}

// 轮次口径 = runs 表按 session_id 的 COUNT(*)（不限 status），直接落库模拟历史运行。
const seedRuns = (store: any, { projectId, botId, sessionId, count, kind = 'chat', status = 'succeeded', idPrefix, taskId = null }: { projectId: string | null; botId: string; sessionId: string; count: number; kind?: string; status?: string; idPrefix?: string; taskId?: string | null }) => {
  const at = new Date().toISOString()
  for (let i = 0; i < count; i += 1) {
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, attempt, idempotency_key, session_id, queued_at)
       VALUES (?, ?, ?, ?, ?, 'read', 'test', ?, 1, ?, ?, ?)`,
      `${idPrefix ?? `run_seed_${sessionId}`}__${i}`, projectId, botId, taskId, kind, status, `seed:${idPrefix ?? sessionId}:${status}:${i}`, sessionId, at,
    )
  }
}

const compactRuns = (store: any) => store.all("SELECT * FROM runs WHERE kind = 'session_compact'")
const rolloverRuns = (store: any) => store.all("SELECT * FROM runs WHERE kind = 'rollover_summary'")

test('默认值与生效链：rollover 默认 512、compact 默认 64，设置页 0 可关闭压缩', () => {
  const config = resolveConfig({ workspace: '/tmp/x', dataDir: '/tmp/x' })
  assert.equal(config.sessionRolloverTurns, 512, '结转阈值默认应为 512')
  assert.equal(config.sessionCompactTurns, 64, '压缩窗口默认应为 64')
  assert.equal(effectiveSessionCompactTurns(config, () => 0), 0, '设置页保存 0 应关闭压缩')
  assert.equal(effectiveSessionCompactTurns(config, () => '96'), 96, '设置页保存值应覆盖默认')
})

test('64 轮边界闲时触发：跨窗口且闲时排一条压缩运行，复用不重排', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: 4 })

    const host = captureHost()
    const runtime = newRuntime(host, ctx.config, ctx.store)
    const sessionId = await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    assert.equal(sessionId, 'sess-old', '压缩不换会话')

    const queued = compactRuns(ctx.store)
    assert.equal(queued.length, 1, '跨过窗口边界应恰好排一条压缩运行')
    assert.equal(queued[0].status, 'queued')
    assert.equal(queued[0].mode, 'read', '压缩运行只读')
    assert.equal(queued[0].session_id, 'sess-old', '压缩运行必须复用原会话')
    assert.equal(queued[0].trigger_ref, 'sess-old')
    assert.equal(queued[0].idempotency_key, 'session_compact:sess-old:1', '幂等键带窗口号')
    assert.equal(ctx.store.setting(sessionCompactMarkerKey('sess-old')), '4', '窗口标记应推进到窗口下界')

    // 压缩运行自身入队后轮数 +1（仍在窗口 1 内）：再次复用不得重排。
    await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    assert.equal(compactRuns(ctx.store).length, 1, '同窗口不得重复排队')
  } finally {
    await cleanup(ctx)
  }
})

test('忙时推后并合批：会话有其他在跑运行时不排，空闲后跨窗口一次性补排', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: 4 })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: 1, status: 'running', idPrefix: 'run_busy' })

    const runtime = newRuntime(captureHost(), ctx.config, ctx.store)
    await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    assert.equal(compactRuns(ctx.store).length, 0, '忙时不得排压缩运行')

    ctx.store.run("UPDATE runs SET status = 'succeeded' WHERE id = 'run_busy__0'")
    await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    const queued = compactRuns(ctx.store)
    assert.equal(queued.length, 1, '空闲后应补排')
    assert.equal(queued[0].idempotency_key, 'session_compact:sess-old:1', '推后触发仍归原窗口（合批不重不漏）')
  } finally {
    await cleanup(ctx)
  }
})

test('压缩≠结转：不 alias 化绑定、不新建会话、不排 rollover；压缩运行回原会话并留痕', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: 4 })

    const host = captureHost()
    const runtime = newRuntime(host, ctx.config, ctx.store)
    await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    assert.equal(rolloverRuns(ctx.store).length, 0, '压缩不得触发结转摘要')
    assert.equal(host.created.length, 0, '压缩不得新建会话')
    assert.equal(ctx.store.get('SELECT alias FROM session_bindings WHERE session_id = ?', 'sess-old').alias, 0, '压缩后绑定仍是活跃绑定')

    const compact = compactRuns(ctx.store)[0]
    assert.equal(await runtime.ensureSession(dev, project, { run: compact }), 'sess-old', '压缩运行应回原会话')
    const prompt = runtime.promptFor({ run: compact, bot: dev, project, sessionId: 'sess-old' })
    assert.ok(prompt.includes('# Session compaction request'), '应下发压缩总结提示词')
    assert.ok(!prompt.includes('# Handoff summary'), '压缩提示词不得混入结转摘要块')

    await ctx.service.finishRun({ runId: compact.id, status: 'succeeded', output: '当前聚焦 X，进行中 Y，下一步 Z。' })
    assert.equal(
      ctx.store.all("SELECT type FROM run_events WHERE run_id = ? AND type = 'session_compact_done'", compact.id).length,
      1,
      '成功应留 session_compact_done 事件',
    )
    assert.equal(ctx.store.setting(rolloverSummaryKey(dev.id, project.id)), null, '压缩产出不得写入结转摘要槽')
  } finally {
    await cleanup(ctx)
  }
})

test('compact=0 关闭：跨任意轮数都不排压缩运行', async () => {
  const ctx = await setup({ compactTurns: 0 })
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: 300 })

    const runtime = newRuntime(captureHost(), ctx.config, ctx.store)
    await runtime.ensureSession(dev, project, { run: { kind: 'chat' } })
    assert.equal(compactRuns(ctx.store).length, 0, '关闭时不得排压缩运行')
  } finally {
    await cleanup(ctx)
  }
})

test('结转后任务亲和：未终态任务消息落旧会话，新任务落活跃控制面绑定，alias 不重复结转，旧会话仍可被压缩触发', async () => {
  const ctx = await setup({ rolloverTurns: 3, compactTurns: 0 })
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    // 任务 T1：未终态，历史运行都落在旧控制面会话 sess-old（单绑定模型：任务流量与控制面同会话）。
    const t1 = await ctx.service.createTask({ projectId: project.id, title: '旧任务', assigneeBotId: dev.id }, ctx.service.actor())
    ctx.store.run("UPDATE tasks SET status = 'in_progress' WHERE id = ?", t1.id)
    bindSession(ctx.store, { botId: dev.id, projectId: project.id, sessionId: 'sess-old' })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: 3 })
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: 2, kind: 'task', idPrefix: 'run_t1', taskId: t1.id })

    const host = captureHost()
    const runtime = newRuntime(host, ctx.config, ctx.store)
    // 项目会话超阈值且摘要就绪 → 结转：sess-old alias 化，新会话成为活跃绑定。
    ctx.store.setSetting(rolloverSummaryKey(dev.id, project.id), '交接摘要。')
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'chat' } }), 'sess-new-1', '超阈值应结转开新会话')
    assert.equal(ctx.store.get('SELECT alias FROM session_bindings WHERE session_id = ?', 'sess-old').alias, 1, '旧会话应 alias 化')
    const createdAfterRollover = host.created.length

    // ① 任务亲和：未终态 T1 的消息按 runs 归属落旧会话（活跃绑定已换新会话）。
    const task = ctx.store.get('SELECT * FROM tasks WHERE id = ?', t1.id)
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'task' }, task }), 'sess-old', '未终态任务消息应落旧会话')
    // ② 幂等：旧会话轮数远超阈值且摘要仍在，亲和复用也不得二次结转。
    seedRuns(ctx.store, { projectId: project.id, botId: dev.id, sessionId: 'sess-old', count: 5, idPrefix: 'run_more' })
    ctx.store.setSetting(rolloverSummaryKey(dev.id, project.id), '再次交接摘要。')
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'task' }, task }), 'sess-old', 'alias 会话不得重复结转')
    assert.equal(host.created.length, createdAfterRollover, '亲和复用不得再新建会话')
    assert.equal(rolloverRuns(ctx.store).length, 0, 'alias 会话不得重排结转摘要')

    // ③ 新任务（无 runs 归属）：不享亲和，落 bot 的活跃控制面绑定（DSHBOTS-289 收敛后
    //    不再开任务车道行，sess-new-1 即结转后的活跃控制面会话）。
    const t2 = await ctx.service.createTask({ projectId: project.id, title: '新任务', assigneeBotId: dev.id }, ctx.service.actor())
    const task2 = ctx.store.get('SELECT * FROM tasks WHERE id = ?', t2.id)
    const fresh = await runtime.ensureSession(dev, project, { run: { kind: 'task' }, task: task2 })
    assert.equal(fresh, 'sess-new-1', '新任务应落活跃控制面绑定')
    assert.equal(host.created.length, createdAfterRollover, '新任务不得新建会话')
    assert.equal(
      ctx.store.get("SELECT COUNT(*) AS n FROM session_bindings WHERE bot_id = ? AND kind = 'task'", dev.id)?.n,
      0,
      '不得再开任务车道绑定行',
    )
    assert.equal(
      ctx.store.get('SELECT COUNT(*) AS n FROM session_bindings WHERE bot_id = ? AND alias = 0', dev.id)?.n,
      1,
      '活跃绑定仍只有控制面一条',
    )
    assert.equal(
      ctx.store.get('SELECT COUNT(*) AS n FROM session_bindings WHERE bot_id = ?', dev.id)?.n,
      2,
      '绑定行总数 = 活跃控制面一条 + 旧会话别名',
    )

    // ④ 旧会话（alias、承接未终态任务流量）跨压缩窗口：仍应被压缩触发（设置页开压缩）。
    ctx.store.setSetting(SESSION_COMPACT_TURNS_KEY, '8')
    assert.equal(await runtime.ensureSession(dev, project, { run: { kind: 'task' }, task }), 'sess-old')
    const queued = compactRuns(ctx.store)
    assert.equal(queued.length, 1, '旧会话承接流量仍应被压缩触发')
    assert.equal(queued[0].session_id, 'sess-old')
    assert.equal(queued[0].idempotency_key, 'session_compact:sess-old:1', '10 轮跨入第 2 个窗口（窗口号 1）')
  } finally {
    await cleanup(ctx)
  }
})
