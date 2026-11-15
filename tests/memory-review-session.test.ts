// 记忆审查独立会话守门：
// ①端到端：群聊回复派生的 memory_review 运行落 kind='review' 独立绑定会话，
//   不再进 bot 控制面绑定（审查提示词自包含，控制面历史整段重放是纯成本）；
// ②有界复用：同一 review 绑定服务 MEMORY_REVIEW_BINDING_MAX_RUNS 次审查后退役
//   （alias=1）换新会话，宿主会话数与上下文都被钉在有界范围；
// ③审查模型覆盖：配置 provider/model 对时随运行落 runs.model_*，未配置为 NULL。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { sessionMethods, MEMORY_REVIEW_BINDING_MAX_RUNS } from '../src/services/runtime/session.js'
import { memoryMethods, memoryReviewModelTarget } from '../src/services/memory.js'
import { TeamService } from '../src/service.js'

// 只镜像真实现的会话面（ensureSession 解析 + runs.session_id 写回），不拉起 prompt 管线；
// 形状同 binding-convergence.test.ts 的 ControlPlaneRuntime。
class ReviewRuntime {
  declare handler: any
  declare store: any; declare config: any; declare ctx: any; declare logger: any
  declare sessionCreates: any; declare sessionCounter: any

  constructor(config: any) {
    this.sessionCounter = 0
    this.config = config
    this.logger = { info() {}, warn() {}, error() {} }
    this.sessionCreates = new Map()
    this.ctx = {
      sessionController: {
        resolveAgent: async () => ({}),
        selectModel: async () => ({}),
        create: async () => ({ sessionId: `sess-rv-${++this.sessionCounter}` }),
      },
    }
  }

  setCompletionHandler(handler: any) { this.handler = handler }
  async catalog() { return [] }
  async validateBotConfig() {}
  async selectModel() {}
  async defaultAgentPreset() { return {} }
  applyFilePolicy() {}
  shouldRolloverSession() { return false }
  maybeCompactSession() {}
  ensureReviewSession(bot: any, project: any, opts: any) { return sessionMethods.ensureReviewSession.call(this, bot, project, opts) }
  ensureBotBinding(bot: any, project: any, opts: any) { return sessionMethods.ensureBotBinding.call(this, bot, project, opts) }
  ensureTaskSession(bot: any, project: any, opts: any) { return sessionMethods.ensureTaskSession.call(this, bot, project, opts) }
  taskAffinityBinding(task: any) { return sessionMethods.taskAffinityBinding.call(this, task) }
  retireBinding(sessionId: string) { return sessionMethods.retireBinding.call(this, sessionId) }

  async startRun({ run, bot, project, task }: any) {
    const sessionId = await sessionMethods.ensureSession.call(this, bot, project, { run, task })
    this.store.run('UPDATE runs SET session_id = ? WHERE id = ?', sessionId, run.id)
    return sessionId
  }

  async steer() { return true }
  async cancelRun() { return true }
  complete(runId: string, status = 'succeeded', output = 'done') {
    return this.handler({ runId, status, output, error: null })
  }
}

async function setup(configOverride: any = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-review-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir: join(root, 'data'), skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0, schedulerIntervalMs: 30_000, ...configOverride,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new ReviewRuntime(config)
  runtime.store = store
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  return { root, store, config, service, runtime }
}

const cleanup = async ({ root, store }: any) => {
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const waitFor = async (fn: () => any, ms = 3000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() >= deadline) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// 驱动 tick 直到条件成立：领取中的运行等 session_id 写回后按给定产出收尾。
const drive = async (service: any, store: any, runtime: any, done: () => boolean, outputFor: (run: any) => string) => {
  for (let i = 0; i < 32 && !done(); i++) {
    await service.tick()
    const running = store.get("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
    if (running) {
      await waitFor(() => store.get('SELECT session_id AS s FROM runs WHERE id = ?', running.id)?.s)
      await runtime.complete(running.id, 'succeeded', outputFor(running))
      continue
    }
    if (done()) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(done(), '驱动条件未达成')
}

test('群聊回复的 memory_review 落独立 review 会话，不进控制面绑定', async (t) => {
  const ctx = await setup()
  t.after(async () => { await cleanup(ctx) })
  const { store, service, runtime } = ctx

  const dev = await service.createBot({ name: 'memoscribe', role: '开发', instructions: 'Review.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'RV', key: 'RVIEW', memberIds: [dev.id] })
  await service.sendMessage(project.id, '@memoscribe 生图先暂停，其余照旧，回复确认后我会继续安排')

  await drive(
    service, store, runtime,
    () => Boolean(store.get("SELECT id FROM runs WHERE kind = 'memory_review' AND status IN ('succeeded', 'failed', 'canceled')")),
    run => run.kind === 'chat'
      ? '收到。生图保持暂停，待生成清单原样保留，等你后续指令再恢复；其余工作照常推进。'
      : '[]',
  )

  const chatRun = store.get("SELECT session_id AS s FROM runs WHERE kind = 'chat' AND status = 'succeeded'")
  const reviewRun = store.get("SELECT session_id AS s FROM runs WHERE kind = 'memory_review'")
  assert.ok(chatRun?.s, '群聊运行应已写回会话')
  assert.ok(reviewRun?.s, '审查运行应已写回会话')
  assert.notEqual(reviewRun.s, chatRun.s, '审查运行不得复用控制面会话')

  const control = store.get("SELECT * FROM session_bindings WHERE session_id = ?", chatRun.s)
  const reviewBinding = store.get("SELECT * FROM session_bindings WHERE session_id = ?", reviewRun.s)
  assert.equal(control?.kind, 'bot', '群聊会话仍是 kind=bot 控制面绑定')
  assert.equal(reviewBinding?.kind, 'review', '审查会话是 kind=review 独立绑定')
  assert.equal(reviewBinding?.alias, 0, '审查绑定活跃')
  assert.equal(reviewBinding?.bot_id, dev.id)
  assert.equal(reviewBinding?.project_id, project.id)
})

test('review 绑定有界复用：到量退役换新，旧行 alias=1', async (t) => {
  const ctx = await setup()
  t.after(async () => { await cleanup(ctx) })
  const { store, service, runtime } = ctx

  const dev = await service.createBot({ name: 'Bounder', role: '开发', instructions: 'B.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'BD', key: 'BOUND', memberIds: [dev.id] })

  const sessions: string[] = []
  const insertSourceRun = (i: number) => {
    const runId = `src-run-${i}`
    store.run(
      `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, output, queued_at, started_at, ended_at)
       VALUES (?, ?, ?, 'chat', 'read', 'mention', 'succeeded', 1, ?, ?, ?, ?, ?)`,
      runId, project.id, dev.id, `src:${runId}`,
      `第 ${i} 条源回复，内容足够长，供审查提示词切片使用。`.repeat(3),
      new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
    )
    return runId
  }

  for (let i = 0; i <= MEMORY_REVIEW_BINDING_MAX_RUNS; i++) {
    service.enqueueMemoryReview(project, dev, null, insertSourceRun(i))
    const expected = sessions.at(-1) ?? null
    await drive(
      service, store, runtime,
      () => {
        const row = store.get("SELECT session_id AS s FROM runs WHERE kind = 'memory_review' AND trigger_ref = ?", `src-run-${i}`)
        return row?.s ? row.s : false
      },
      () => '[]',
    )
    const landed = store.get("SELECT session_id AS s FROM runs WHERE kind = 'memory_review' AND trigger_ref = ?", `src-run-${i}`).s
    if (expected && i < MEMORY_REVIEW_BINDING_MAX_RUNS) assert.equal(landed, expected, `第 ${i + 1} 次审查应复用同一 review 会话（未到上限）`)
    sessions.push(landed)
  }

  const first = sessions[0]
  const last = sessions.at(-1)
  assert.notEqual(last, first, '超过上限后应换新会话')
  const retired = store.get('SELECT * FROM session_bindings WHERE session_id = ?', first)
  assert.equal(retired?.alias, 1, '到量旧绑定应退役为 alias 行')
  const active = store.get("SELECT * FROM session_bindings WHERE bot_id = ? AND kind = 'review' AND alias = 0", dev.id)
  assert.equal(active?.session_id, last, '新的活跃 review 绑定指向新会话')
})

test('审查模型覆盖：配置对随运行落 runs.model_*，未配置为 NULL', async (t) => {
  assert.deepEqual(memoryReviewModelTarget({}), null, '空配置不启用')
  assert.deepEqual(memoryReviewModelTarget({ memoryReviewProvider: 'p', memoryReviewModel: '' }), null, '只配一半不启用')
  assert.deepEqual(memoryReviewModelTarget({ memoryReviewProvider: 'p', memoryReviewModel: 'm' }), { provider: 'p', model: 'm' })

  const plain = await setup()
  t.after(async () => { await cleanup(plain) })
  const dev = await plain.service.createBot({ name: 'Plain', role: '开发', instructions: 'P.', provider: 'fake', model: 'model-a' })
  const project = await plain.service.createProject({ name: 'PL', key: 'PLAIN', memberIds: [dev.id] })
  const source = 'src-plain-1'
  plain.store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, output, queued_at, started_at, ended_at)
     VALUES (?, ?, ?, 'chat', 'read', 'mention', 'succeeded', 1, ?, ?, ?, ?, ?)`,
    source, project.id, dev.id, 'src:plain', '一条足够长的源回复，供模型切片审查。'.repeat(2),
    new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
  )
  memoryMethods.enqueueMemoryReview.call(plain.service, project, dev, null, source)
  const plainRow = plain.store.get("SELECT model_provider AS p, model_model AS m FROM runs WHERE kind = 'memory_review' AND trigger_ref = ?", source)
  assert.equal(plainRow?.p, null, '未配置审查模型时不覆盖')
  assert.equal(plainRow?.m, null)

  const cheap = await setup({ memoryReviewProvider: 'fake', memoryReviewModel: 'model-cheap' })
  t.after(async () => { await cleanup(cheap) })
  const dev2 = await cheap.service.createBot({ name: 'Cheap', role: '开发', instructions: 'C.', provider: 'fake', model: 'model-a' })
  const project2 = await cheap.service.createProject({ name: 'CP', key: 'CHEAP', memberIds: [dev2.id] })
  const source2 = 'src-cheap-1'
  cheap.store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key, output, queued_at, started_at, ended_at)
     VALUES (?, ?, ?, 'chat', 'read', 'mention', 'succeeded', 1, ?, ?, ?, ?, ?)`,
    source2, project2.id, dev2.id, 'src:cheap', '另一条足够长的源回复，供模型切片审查。'.repeat(2),
    new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
  )
  memoryMethods.enqueueMemoryReview.call(cheap.service, project2, dev2, null, source2)
  const cheapRow = cheap.store.get("SELECT model_provider AS p, model_model AS m FROM runs WHERE kind = 'memory_review' AND trigger_ref = ?", source2)
  assert.equal(cheapRow?.p, 'fake', '配置对时审查运行带模型覆盖')
  assert.equal(cheapRow?.m, 'model-cheap')
})
