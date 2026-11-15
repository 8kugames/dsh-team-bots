// 故障注入演练：重启恢复、预算拦截、卡死看门狗。
// 每个场景都在独立临时目录里跑，跑完即删，不碰生产库。
//
// 用法：
//   node scripts/fault-test.mjs
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

const USAGE = `用法：node scripts/fault-test.mjs [选项]

  --keep        保留临时目录（排查用）
  --help        显示本帮助

三项演练全部通过时退出码 0，任一项失败退出码 1。`

function parseArgs(argv) {
  const args                                   = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
      continue
    }
    args[key] = next
    index += 1
  }
  return args
}

// 假 runtime：只负责让运行有个可控的结局，不碰真实模型。
class FakeRuntime {                                                                                                                                       
  constructor() {
    this.started = []
    this.canceled = []
    this.failures = []
  }

  setCompletionHandler(handler) { this.handler = handler }

  async catalog() {
    return [{
      ref: 'fake/model-a', provider: 'fake', providerName: 'Fake', model: 'model-a',
      name: 'Fake Model A', efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
    }]
  }

  async validateBotConfig() {}

  async startRun({ run }) {
    this.started.push(run.id)
    setTimeout(() => {
      Promise.resolve(this.handler({ runId: run.id, status: 'succeeded', output: '假运行完成', error: null }))
        .catch(error => this.failures.push(String(error?.stack || error)))
    }, 1)
    return `fake-session-${run.id}`
  }

  async cancelRun(runId) {
    this.canceled.push(runId)
    return true
  }

  async steer() { return true }
}

async function createEnvironment({ stallTimeoutMs = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-fault-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  const config = resolveConfig({
    workspace,
    dataDir,
    seedBots: [],
    stallTimeoutMs,
    maxConcurrentRuns: 4,
    schedulerIntervalMs: 250,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({
    store,
    config,
    logger: { info() {}, warn() {}, error() {} },
  })
  const runtime = new FakeRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  return { root, config, store, service, runtime }
}

async function seedWorkload(service, store, { key = 'FLT' } = {}) {
  const director = store.get('SELECT * FROM bots WHERE name = ?', service.config.seedOwnerName)
  const worker = await service.createBot({
    name: 'Worker1',
    role: '开发',
    instructions: '故障演练用 Bot。',
    provider: 'fake',
    model: 'model-a',
  })
  const project = await service.createProject({
    name: '故障演练项目',
    key,
    ownerBotId: director.id,
    memberIds: [worker.id],
  })
  const task = await service.createTask({
    projectId: project.id,
    title: '演练任务',
    assigneeBotId: worker.id,
    autoStart: true,
    postCard: false,
  })
  return { director, worker, project, task }
}

// 场景一：进程崩溃留下 running 运行，重启后应重新排队，且重复初始化不产生重复运行。
async function scenarioRestartRecovery() {
  const env = await createEnvironment()
  const checks = []
  try {
    const { store, service, runtime } = env
    const { task } = await seedWorkload(service, store, { key: 'RST' })
    const run = store.get('SELECT * FROM runs WHERE task_id = ?', task.id)
    const crashedAt = new Date(Date.now() - 60_000).toISOString()
    store.run(
      "UPDATE runs SET status = 'running', started_at = ?, last_progress_at = ?, session_id = 'crashed-session' WHERE id = ?",
      crashedAt, crashedAt, run.id,
    )
    store.close()

    // 第一次重启：恢复成 queued。
    const store2 = openDatabase(env.config.dbPath)
    const service2 = new TeamService({
      store: store2,
      config: env.config,
      logger: { info() {}, warn() {}, error() {} },
    })
    const runtime2 = new FakeRuntime()
    service2.attachRuntime(runtime2)
    await service2.initialize()
    const recovered = store2.get('SELECT * FROM runs WHERE id = ?', run.id)
    const recoveredEvents = Number(store2.get(
      "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'recovered'", run.id,
    )?.n ?? 0)
    checks.push({ name: '重启后运行回到 queued', pass: recovered.status === 'queued' })
    checks.push({ name: '重启后清空 started_at / last_progress_at / session_id', pass: !recovered.started_at && !recovered.last_progress_at && !recovered.session_id })
    checks.push({ name: '写入 recovered 运行事件', pass: recoveredEvents === 1 })
    const runsAfterFirstRestart = Number(store2.get('SELECT COUNT(*) AS n FROM runs')?.n ?? 0)
    store2.close()

    // 第二次重启：不应再产生新的 recovered 事件，也不应复制运行。
    const store3 = openDatabase(env.config.dbPath)
    const service3 = new TeamService({
      store: store3,
      config: env.config,
      logger: { info() {}, warn() {}, error() {} },
    })
    service3.attachRuntime(new FakeRuntime())
    await service3.initialize()
    const recoveredAgain = store3.get('SELECT * FROM runs WHERE id = ?', run.id)
    const recoveredEventsAgain = Number(store3.get(
      "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'recovered'", run.id,
    )?.n ?? 0)
    const runsAfterSecondRestart = Number(store3.get('SELECT COUNT(*) AS n FROM runs')?.n ?? 0)
    checks.push({ name: '重复初始化不改变运行状态', pass: recoveredAgain.status === 'queued' })
    checks.push({ name: '重复初始化不新增 recovered 事件', pass: recoveredEventsAgain === 1 })
    checks.push({ name: '重复初始化不复制运行', pass: runsAfterSecondRestart === runsAfterFirstRestart })

    // 排空队列，确认恢复后的运行只被执行一次。
    service3.started = true
    await service3.tick()
    await new Promise(resolve => setTimeout(resolve, 30))
    const finalRuns = Number(store3.get('SELECT COUNT(*) AS n FROM runs')?.n ?? 0)
    const finalTaskRuns = Number(store3.get(
      "SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND kind = 'task'", task.id,
    )?.n ?? 0)
    const finalStatus = store3.get('SELECT status FROM runs WHERE id = ?', run.id)?.status
    checks.push({ name: '恢复后的任务运行只产生一条记录', pass: finalTaskRuns === 1 })
    checks.push({ name: '恢复后的运行最终正常结束', pass: finalStatus === 'succeeded' })
    const newRuns = store3.all(
      "SELECT id, kind, status FROM runs WHERE id != ? AND queued_at >= (SELECT queued_at FROM runs WHERE id = ?)",
      run.id, run.id,
    ).map(row => row.kind)
    checks.push({ name: '恢复后新增的运行都是后续流程运行', pass: newRuns.every(kind => kind !== 'task') })
    store3.close()
    void runtime
    void runtime2
    return { scenario: 'restart_recovery', ok: checks.every(check => check.pass), checks }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
}

// 场景二：项目 token 预算用尽时，排队的运行应被判 BUDGET_EXCEEDED，而不是真正启动。
async function scenarioBudgetGuard() {
  const env = await createEnvironment()
  const checks = []
  try {
    const { store, service, runtime } = env
    const { project } = await seedWorkload(service, store, { key: 'BGT' })
    store.run('UPDATE projects SET token_budget = 1 WHERE id = ?', project.id)
    store.run(
      `INSERT INTO usage_events(id, source_key, project_id, bot_id, provider, model, purpose,
        input_tokens, output_tokens, occurred_at, created_at)
       VALUES ('use_budget_seed', 'budget-seed', ?, ?, 'fake', 'model-a', 'run', 1000, 0, ?, ?)`,
      project.id, project.owner_bot_id, new Date().toISOString(), new Date().toISOString(),
    )
    const task = store.get("SELECT * FROM tasks WHERE project_id = ?", project.id)
    const run = store.get('SELECT * FROM runs WHERE task_id = ?', task.id)

    service.started = true
    await service.tick()

    const after = store.get('SELECT * FROM runs WHERE id = ?', run.id)
    checks.push({ name: '超预算运行被判失败', pass: after.status === 'failed' })
    checks.push({ name: '错误码是 BUDGET_EXCEEDED', pass: after.error_code === 'BUDGET_EXCEEDED' })
    checks.push({ name: '超预算运行没有被启动', pass: !after.started_at })
    checks.push({ name: '超预算运行没有交给 runtime', pass: !runtime.started.includes(run.id) })
    const leftovers = store.all("SELECT id, kind FROM runs WHERE status = 'queued'")
    return {
      scenario: 'budget_guard',
      ok: checks.every(check => check.pass),
      checks,
      notes: {
        errorMessage: after.error_message,
        leftoverQueuedRuns: leftovers.map(row => ({ id: row.id, kind: row.kind })),
      },
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
}

// 场景三：长时间没有任何进展的运行应被看门狗置为 RUN_STALLED。
async function scenarioStallWatchdog() {
  const env = await createEnvironment({ stallTimeoutMs: 1_000 })
  const checks = []
  try {
    const { store, service, runtime } = env
    const { task } = await seedWorkload(service, store, { key: 'STL' })
    const run = store.get('SELECT * FROM runs WHERE task_id = ?', task.id)
    const staleAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    store.run(
      "UPDATE runs SET status = 'running', started_at = ?, last_progress_at = ? WHERE id = ?",
      staleAt, staleAt, run.id,
    )

    await service.reapStalledRuns()

    const after = store.get('SELECT * FROM runs WHERE id = ?', run.id)
    checks.push({ name: '卡死运行被判失败', pass: after.status === 'failed' })
    checks.push({ name: '错误码是 RUN_STALLED', pass: after.error_code === 'RUN_STALLED' })
    checks.push({ name: '看门狗通知 runtime 取消运行', pass: runtime.canceled.includes(run.id) })
    return {
      scenario: 'stall_watchdog',
      ok: checks.every(check => check.pass),
      checks,
      notes: { errorMessage: after.error_message },
    }
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }

  const scenarios = []
  scenarios.push(await scenarioRestartRecovery())
  scenarios.push(await scenarioBudgetGuard())
  scenarios.push(await scenarioStallWatchdog())

  const ok = scenarios.every(item => item.ok)
  console.log(JSON.stringify({
    ok,
    scenarios: scenarios.map(item => ({
      scenario: item.scenario,
      ok: item.ok,
      checks: item.checks,
      notes: item.notes ?? null,
    })),
  }, null, 2))
  if (!ok) process.exitCode = 1
}

main().catch(error => {
  console.error(`故障演练失败：${error?.stack || error}`)
  process.exitCode = 1
})
