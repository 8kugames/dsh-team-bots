// DSHBOTS-135：recovery note 重启恢复（superagent 移植卡 A，机制③）。
// 覆盖：启动重排队置位（含 attempt 不受扰、既有清场行为保持）、任务提示词注入与不注入
// 两分支、startRun 消费清除（一次性语义）、多次重启多次注入（每次重排队后首跑各一次）、
// 域自管迁移幂等（老库无列 → 加列登记恰一次，进程重启语义下不重复登记）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'
import { DshRuntime } from '../src/runtime.js'
import { ensureRecoverySchema, RECOVERY_MIGRATION } from '../src/services/recovery-schema.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recovery-note-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  return { root, store, service, config }
}

// 模拟宿主重启：initialize 的 ready Promise 已缓存，置空后重跑才走到 running→queued 重排队。
const restartHost = async (service) => {
  service.ready = null
  await service.initialize()
}

// 捕获版最小宿主替身：把每次下发给 worker 的提示词文本录进 sink。
const captureHost = (sink) => ({
  sessionController: {
    resolveAgent: async () => ({}),
    selectModel: async () => ({}),
    prompt: async (request) => { sink.push(request.content.map(part => part.text ?? '').join('\n')) },
    cancel: async () => {},
  },
})

const insertTaskRun = (store, { runId, projectId, botId, taskId, sessionId }) => {
  const at = new Date().toISOString()
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, status, attempt, idempotency_key, queued_at)
     VALUES (?, ?, ?, ?, 'task', 'write', 'test', 'running', 1, ?, ?)`,
    runId, projectId, botId, taskId, `${runId}-1`, at,
  )
  store.run(
    `INSERT INTO session_bindings(session_id, bot_id, project_id, kind, task_id, created_at) VALUES (?, ?, ?, 'task', ?, ?)`,
    sessionId, botId, projectId, taskId, at,
  )
}

async function primeProject(service, store) {
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Recovery', key: 'RCV', ownerBotId: director.id, memberIds: [dev.id] })
  return { director, dev, project }
}

const cleanup = async ({ root, store, service }) => {
  try { service.started = false } catch {}
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const runRowOf = (store, id) => store.get('SELECT * FROM runs WHERE id = ?', id)

// 走「重启重排队→首跑消费」一次，返回捕获到的提示词文本（多次重启用例的复用单元）。
// 运行行须已存在（部分唯一索引 one_active_run_per_task：同任务活跃 run 至多一条，不得重复 INSERT）。
async function restartAndStartRun({ store, service, config, bot, project, task, runId }) {
  await restartHost(service)
  const prompts = []
  const runtime = new DshRuntime({ ctx: captureHost(prompts), config, store, logger: { info() {}, warn() {}, error() {} } })
  await runtime.startRun({ run: runRowOf(store, runId), bot, project, task, sessionKind: 'task' })
  const pending = runtime.pendingByRun.get(runId)
  if (pending?.timer) clearTimeout(pending.timer)
  return prompts[0] ?? ''
}

test('启动重排队置位：running→queued 且 recovery=1，attempt 不受扰，既有清场保持', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const task = await ctx.service.createTask({ projectId: project.id, title: '被重启打断的任务' }, ctx.service.actor())
    insertTaskRun(ctx.store, { runId: 'run-a', projectId: project.id, botId: dev.id, taskId: task.id, sessionId: 'sess-a' })

    await restartHost(ctx.service)

    const row = runRowOf(ctx.store, 'run-a')
    assert.equal(row.status, 'queued', '重启后应重排队为 queued')
    assert.equal(Number(row.recovery), 1, '重排队应置 recovery=1 供首条提示词消费')
    assert.equal(row.attempt, 1, '重排队不得 bump attempt（与 retryRun 的 +1 语义正交）')
    assert.equal(row.started_at, null, '既有清场行为保持：started_at 清空')
    assert.equal(row.session_id, null, '既有清场行为保持：session_id 清空')
    const events = ctx.store.all("SELECT type FROM run_events WHERE run_id = ? AND type = 'recovered'", 'run-a')
    assert.equal(events.length, 1, 'run_events 应留 recovered 痕')
  } finally {
    await cleanup(ctx)
  }
})

test('任务提示词注入两分支：recovery=1 注入恢复块，recovery=0 完全不注入', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const task = await ctx.service.createTask({ projectId: project.id, title: '提示词分支' }, ctx.service.actor())
    insertTaskRun(ctx.store, { runId: 'run-flag', projectId: project.id, botId: dev.id, taskId: task.id, sessionId: 'sess-flag' })
    await restartHost(ctx.service)
    const taskRow = ctx.store.get('SELECT * FROM tasks WHERE id = ?', task.id)

    const runtime = new DshRuntime({ ctx: null, config: ctx.config, store: ctx.store, logger: { info() {}, warn() {}, error() {} } })

    const flagged = runtime.promptFor({ run: runRowOf(ctx.store, 'run-flag'), bot: dev, project, task: taskRow })
    assert.ok(flagged.includes('# Recovery note'), '置位的运行应注入恢复块标题')
    assert.ok(
      flagged.includes('上次执行因宿主重启中断。先检查工作区与 git 状态核实现状，再从中断点继续；已执行过的外部动作（提交/发布/消息）不要重复。'),
      '恢复提醒文案应逐字对齐口径',
    )

    ctx.store.run('UPDATE runs SET recovery = 0 WHERE id = ?', 'run-flag')
    const plain = runtime.promptFor({ run: runRowOf(ctx.store, 'run-flag'), bot: dev, project, task: taskRow })
    assert.ok(!plain.includes('# Recovery note'), '未置位的运行不得出现恢复块')
  } finally {
    await cleanup(ctx)
  }
})

test('startRun 消费清除：首条提示词带恢复块，消费后标志清零且不再注入（一次性语义）', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const task = await ctx.service.createTask({ projectId: project.id, title: '消费清除' }, ctx.service.actor())
    insertTaskRun(ctx.store, { runId: 'run-consume', projectId: project.id, botId: dev.id, taskId: task.id, sessionId: 'sess-consume' })
    await restartHost(ctx.service)
    const taskRow = ctx.store.get('SELECT * FROM tasks WHERE id = ?', task.id)

    const prompts = []
    const runtime = new DshRuntime({ ctx: captureHost(prompts), config: ctx.config, store: ctx.store, logger: { info() {}, warn() {}, error() {} } })
    await runtime.startRun({ run: runRowOf(ctx.store, 'run-consume'), bot: dev, project, task: taskRow, sessionKind: 'task' })
    const pending = runtime.pendingByRun.get('run-consume')
    if (pending?.timer) clearTimeout(pending.timer)

    assert.ok(prompts[0].includes('# Recovery note'), '下发首条提示词应含恢复块')
    assert.equal(Number(runRowOf(ctx.store, 'run-consume').recovery), 0, '消费后标志应即刻清零')

    const second = runtime.promptFor({ run: runRowOf(ctx.store, 'run-consume'), bot: dev, project, task: taskRow })
    assert.ok(!second.includes('# Recovery note'), '同一运行再次生成提示词不得重复注入')
  } finally {
    await cleanup(ctx)
  }
})

test('多次重启多次注入：每次重排队后的首跑各注入一次，attempt 恒 1，recovered 逐次留痕', async () => {
  const ctx = await setup()
  try {
    const { dev, project } = await primeProject(ctx.service, ctx.store)
    const task = await ctx.service.createTask({ projectId: project.id, title: '两轮重启' }, ctx.service.actor())
    const taskRow = ctx.store.get('SELECT * FROM tasks WHERE id = ?', task.id)

    insertTaskRun(ctx.store, { runId: 'run-twice', projectId: project.id, botId: dev.id, taskId: task.id, sessionId: 'sess-twice' })
    const firstPrompt = await restartAndStartRun({
      store: ctx.store, service: ctx.service, config: ctx.config, bot: dev, project, task: taskRow, runId: 'run-twice',
    })
    assert.ok(firstPrompt.includes('# Recovery note'), '第一轮重启后的首跑应注入恢复块')
    assert.equal(Number(runRowOf(ctx.store, 'run-twice').recovery), 0, '第一轮消费后标志应清零')

    // 第二轮：同一运行再次处于 running（续跑中被再次重启），重新排队应重新置位。
    ctx.store.run("UPDATE runs SET status = 'running', started_at = ?, session_id = 'sess-twice' WHERE id = 'run-twice'", new Date().toISOString())
    const secondPrompt = await restartAndStartRun({
      store: ctx.store, service: ctx.service, config: ctx.config, bot: dev, project, task: taskRow, runId: 'run-twice',
    })
    assert.ok(secondPrompt.includes('# Recovery note'), '第二轮重启后的首跑应再次注入恢复块')
    assert.equal(Number(runRowOf(ctx.store, 'run-twice').recovery), 0, '第二轮消费后标志应再次清零')
    assert.equal(runRowOf(ctx.store, 'run-twice').attempt, 1, '两轮重排队后 attempt 仍为 1')
    const events = ctx.store.all("SELECT type FROM run_events WHERE run_id = 'run-twice' AND type = 'recovered'")
    assert.equal(events.length, 2, '两次重启应各留一条 recovered 事件')
  } finally {
    await cleanup(ctx)
  }
})

test('域自管迁移幂等：老库无列→加列并登记恰一次，重开库（进程重启语义）不重复登记', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recovery-schema-'))
  try {
    const workspace = join(root, 'workspace')
    const dataDir = join(root, 'data')
    await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
    const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
    const store = openDatabase(config.dbPath)

    const columns = () => store.all('PRAGMA table_info(runs)').map(column => column.name)
    assert.ok(!columns().includes('recovery'), '建库 DDL（db.js）不含 recovery 列——列由域迁移负责')
    const ledgerCount = () =>
      store.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?', RECOVERY_MIGRATION).n

    ensureRecoverySchema(store)
    assert.ok(columns().includes('recovery'), '老库迁移后应有 recovery 列')
    assert.equal(ledgerCount(), 1, '迁移账本应登记 runs_recovery_note 恰一次')

    ensureRecoverySchema(store)
    assert.equal(ledgerCount(), 1, '同 store 重跑（WeakSet 守卫）不得重复登记')

    // 进程重启语义：新 Store 对象打开同一 DB，WeakSet 无记忆，靠判列 + ON CONFLICT 幂等。
    store.close()
    const reopened = openDatabase(config.dbPath)
    try {
      ensureRecoverySchema(reopened)
      assert.ok(reopened.all('PRAGMA table_info(runs)').map(column => column.name).includes('recovery'), '重开库后列仍在')
      assert.equal(reopened.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?', RECOVERY_MIGRATION).n, 1, '重开库不重复登记')
    } finally {
      reopened.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
