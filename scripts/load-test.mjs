// 调度负载测试：用假 runtime 驱动 TeamService，测量调度吞吐、端到端延迟分位数，
// 并验证并发上限、同项目写运行串行、只读运行并行这几条调度约束。
// 全程不调用真实模型，数据库落在临时目录里，跑完即删。
//
// 用法：
//   node scripts/load-test.mjs [--runs 60] [--projects 3] [--concurrency 8]
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

const USAGE = `用法：node scripts/load-test.mjs [选项]

  --runs <n>        任务运行总数（默认 60）
  --projects <n>    项目数量（默认 3，同项目写运行串行，所以并发上限受它约束）
  --concurrency <n> maxConcurrentRuns 上限（默认 8，服务端最大 16）
  --duration <ms>   单次假运行耗时（默认 2）
  --timeout <ms>    整体超时（默认 120000）
  --keep            保留临时目录（排查用）
  --help            显示本帮助

断言全部通过时退出码 0，任一断言失败退出码 1。`

function parseArgs(argv) {
  const args = {}
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

const intArg = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null
  const position = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
  return sorted[position]
}

// 假 runtime：立刻接管运行，延迟 durationMs 后回报成功，不碰任何真实模型。
class FakeRuntime {
  constructor({ durationMs = 2 } = {}) {
    this.durationMs = durationMs
    this.active = 0
    this.maxActive = 0
    this.started = 0
    this.completed = 0
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
    this.started += 1
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    setTimeout(() => {
      this.active -= 1
      this.completed += 1
      Promise.resolve(this.handler({ runId: run.id, status: 'succeeded', output: '假运行完成', error: null }))
        .catch(error => this.failures.push(String(error?.stack || error)))
    }, this.durationMs)
    return `fake-session-${run.id}`
  }

  async cancelRun() { return true }

  async steer() { return true }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }

  const runCount = intArg(args.runs, 60)
  const projectCount = intArg(args.projects, 3)
  const concurrency = Math.min(16, intArg(args.concurrency, 8))
  const durationMs = intArg(args.duration, 2)
  const timeoutMs = intArg(args.timeout, 120_000)

  const root = await mkdtemp(join(tmpdir(), 'dsh-team-load-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  const config = resolveConfig({
    workspace,
    dataDir,
    seedBots: [],
    maxConcurrentRuns: concurrency,
    schedulerIntervalMs: 250,
    stallTimeoutMs: 0,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({
    store,
    config,
    logger: { info() {}, warn() {}, error() {} },
  })
  const runtime = new FakeRuntime({ durationMs })
  service.attachRuntime(runtime)
  await service.initialize()

  const chief = store.get("SELECT * FROM bots WHERE name = ?", config.seedOwnerName)
  const workers = []
  for (let index = 0; index < projectCount; index += 1) {
    workers.push(await service.createBot({
      name: `Worker${index + 1}`,
      role: '开发',
      instructions: '压测用 Bot。',
      provider: 'fake',
      model: 'model-a',
    }))
  }

  const projects = []
  for (let index = 0; index < projectCount; index += 1) {
    projects.push(await service.createProject({
      name: `压测项目 ${index + 1}`,
      key: `LT${index + 1}`,
      ownerBotId: chief.id,
      memberIds: [workers[index].id],
    }))
  }

  // 任务运行（写模式）：同一项目共享工作目录，因此必须串行。
  for (let index = 0; index < runCount; index += 1) {
    const projectIndex = index % projectCount
    await service.createTask({
      projectId: projects[projectIndex].id,
      title: `压测任务 ${index + 1}`,
      assigneeBotId: workers[projectIndex].id,
      autoStart: true,
      postCard: false,
    })
  }
  // 群聊运行（只读模式）：不同 Bot 之间应当可以并行。
  for (let index = 0; index < projectCount; index += 1) {
    await service.sendMessage(projects[index].id, `@Worker${index + 1} 同步一下进度`)
  }

  const queuedBefore = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'")?.n ?? 0)

  // 手动驱动调度器：每次 tick 之间让出事件循环，观察队列排空过程。
  service.started = true
  let maxRunning = 0
  let ticks = 0
  let timedOut = false
  const startedAt = Date.now()
  while (true) {
    await service.tick()
    ticks += 1
    const running = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'")?.n ?? 0)
    const pending = Number(store.get("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")?.n ?? 0)
    maxRunning = Math.max(maxRunning, running)
    if (pending === 0) break
    if (Date.now() - startedAt > timeoutMs) {
      timedOut = true
      break
    }
    await sleep(1)
  }
  const elapsedMs = Date.now() - startedAt

  const runs = store.all('SELECT * FROM runs ORDER BY queued_at')
  const latencyOf = list => {
    const values = []
    for (const run of list) {
      if (!run.queued_at || !run.ended_at) continue
      values.push(new Date(run.ended_at).getTime() - new Date(run.queued_at).getTime())
    }
    values.sort((a, b) => a - b)
    return {
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      min: values[0] ?? null,
      max: values[values.length - 1] ?? null,
      samples: values.length,
    }
  }
  const taskRuns = runs.filter(run => run.kind === 'task')
  const chatRuns = runs.filter(run => run.kind === 'chat')
  const followUpRuns = runs.filter(run => run.kind !== 'task' && run.kind !== 'chat')

  const failedRuns = runs.filter(run => run.status === 'failed')
  const unfinishedRuns = runs.filter(run => !['succeeded', 'failed', 'canceled'].includes(run.status))

  // 同一个任务不应被派发出两条 task 运行。
  const duplicatedTaskRuns = []
  for (const run of taskRuns) {
    const sameTask = taskRuns.filter(other => other.task_id === run.task_id)
    if (sameTask.length > 1) duplicatedTaskRuns.push({ taskId: run.task_id, count: sameTask.length })
  }

  // 同项目的写运行不能重叠。
  const writeOverlap = []
  for (const project of projects) {
    const writes = runs
      .filter(run => run.project_id === project.id && run.mode === 'write' && run.started_at && run.ended_at)
      .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())
    for (let index = 1; index < writes.length; index += 1) {
      const previous = writes[index - 1]
      const current = writes[index]
      if (new Date(current.started_at).getTime() < new Date(previous.ended_at).getTime()) {
        writeOverlap.push({ project: project.key, previous: previous.id, current: current.id })
      }
    }
  }

  const assertions = {
    queueDrained: unfinishedRuns.length === 0 && !timedOut,
    allRunsSucceeded: failedRuns.length === 0,
    taskRunCountMatches: taskRuns.length === runCount,
    chatRunCountMatches: chatRuns.length === projectCount,
    noDuplicatedTaskRun: duplicatedTaskRuns.length === 0,
    concurrencyCapRespected: maxRunning <= concurrency && runtime.maxActive <= concurrency,
    writeRunsSerializedPerProject: writeOverlap.length === 0,
    parallelObserved: projectCount < 2 ? true : maxRunning >= 2,
    noRuntimeErrors: runtime.failures.length === 0,
  }
  const pass = Object.values(assertions).every(Boolean)

  const summary = {
    ok: pass,
    params: { runs: runCount, projects: projectCount, concurrency, durationMs },
    queuedBefore,
    totalRuns: runs.length,
    taskRuns: taskRuns.length,
    chatRuns: chatRuns.length,
    followUpRuns: followUpRuns.length,
    completedRuns: runs.filter(run => run.status === 'succeeded').length,
    failedRuns: failedRuns.length,
    ticks,
    elapsedMs,
    throughputPerSec: elapsedMs > 0 ? Number((runs.length / (elapsedMs / 1000)).toFixed(2)) : null,
    taskThroughputPerSec: elapsedMs > 0 ? Number((runCount / (elapsedMs / 1000)).toFixed(2)) : null,
    latencyMs: {
      task: latencyOf(taskRuns),
      followUp: latencyOf(followUpRuns),
      all: latencyOf(runs),
    },
    concurrency: {
      limit: concurrency,
      maxRunningSampled: maxRunning,
      maxActiveInRuntime: runtime.maxActive,
      writeOverlap,
    },
    assertions,
    details: {
      failed: failedRuns.map(run => ({ id: run.id, code: run.error_code, message: run.error_message })),
      runtimeFailures: runtime.failures,
      timedOut,
    },
  }
  console.log(JSON.stringify(summary, null, 2))

  store.close()
  if (args.keep) {
    console.error(`临时目录保留在：${root}`)
  } else {
    await rm(root, { recursive: true, force: true })
  }
  if (!pass) process.exitCode = 1
}

main().catch(error => {
  console.error(`压测失败：${error?.stack || error}`)
  process.exitCode = 1
})
