#!/usr/bin/env node
// 写并行闸门行为验证器：临时库 + 假 runtime，逐用例数同时 running 的写运行数。
// 不入测试套件、不改源码、不碰生产库；每个用例独立临时目录，跑完即删。
//
// 用法：
//   node scripts/verify-parallel.mjs
//
// 四个用例全部通过退出码 0，任一失败退出码 1：
//   ① 两条不相交写范围   → 同时 running=2，且第二条（后放行的写运行）有 run_parallel 事件
//   ② 相交写范围         → 只跑 1 条
//   ③ 一侧未声明写范围   → 只跑 1 条
//   ④ 两侧都未声明写范围 → 只跑 1 条
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

// 假 runtime：startRun 立即返回且从不回调完成，运行会停在 running，便于数并发。
class ManualRuntime {
  setCompletionHandler() {}
  setMask() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-x' }
  async steer() { return true }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-verify-parallel-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(workspace, { recursive: true })
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'),
    modelCacheMs: 0, schedulerIntervalMs: 60_000,
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new ManualRuntime())
  await service.initialize()
  service.started = true // tick() 需要 started 才会出队
  // 新库没有种子 bot：建一个临时 bot 兼任项目 owner 与任务负责人。
  const actor = { type: 'user', id: 'u1' }
  const worker = await service.createBot({ name: 'worker' }, actor)
  const project = await service.createProject({ name: 'VerifyParallel', key: 'VP', ownerBotId: worker.id }, actor)
  return { root, store, service, worker, project, actor }
}

async function runCase({ name, scopesA, scopesB }) {
  const { root, store, service, worker, project, actor } = await setup()
  try {
    const t1 = await service.createTask({ projectId: project.id, title: `A-${name}`, assigneeBotId: worker.id, writeScopes: scopesA, postCard: false }, actor)
    const t2 = await service.createTask({ projectId: project.id, title: `B-${name}`, assigneeBotId: worker.id, writeScopes: scopesB, postCard: false }, actor)
    const task1 = store.get('SELECT * FROM tasks WHERE id = ?', t1.id)
    const task2 = store.get('SELECT * FROM tasks WHERE id = ?', t2.id)
    service.enqueueTaskRun(task1, 'manual', actor)
    // 两条入队间隔几毫秒：queued_at 严格有序，出队 FIFO 顺序确定，第二条即 B 任务的运行。
    await new Promise(resolve => setTimeout(resolve, 5))
    service.enqueueTaskRun(task2, 'manual', actor)
    await service.tick()
    const running = store.all("SELECT task_id FROM runs WHERE status = 'running'")
    const queued = store.all("SELECT task_id FROM runs WHERE status = 'queued'")
    const parallelEvents = store.all(
      `SELECT e.run_id FROM run_events e JOIN runs r ON r.id = e.run_id
       WHERE e.type = 'run_parallel' AND r.task_id IN (?, ?)`,
      t1.id, t2.id,
    )
    return {
      name,
      scopesA: JSON.stringify(scopesA),
      scopesB: JSON.stringify(scopesB),
      runningCount: running.length,
      queuedCount: queued.length,
      runningFirst: running.length === 1 && running[0].task_id === t1.id,
      queuedSecond: queued.length === 1 && queued[0].task_id === t2.id,
      secondHasParallelEvent: parallelEvents.some(event => store.get('SELECT task_id FROM runs WHERE id = ?', event.run_id).task_id === t2.id),
      totalParallelEvents: parallelEvents.length,
    }
  } finally {
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

const cases = [
  { key: '①', name: '不相交写范围→并行', scopesA: ['src/ui/'], scopesB: ['src/db/'] },
  { key: '②', name: '相交写范围→串行', scopesA: ['src/ui/'], scopesB: ['src/ui/app.js'] },
  { key: '③', name: '一侧未声明→串行', scopesA: ['src/ui/'], scopesB: [] },
  { key: '④', name: '两侧都未声明→串行', scopesA: [], scopesB: [] },
]

const checks = []
for (const spec of cases) {
  const result = await runCase(spec)
  const head = `用例${spec.key} ${spec.name} (A=${result.scopesA}, B=${result.scopesB})`
  if (spec.key === '①') {
    checks.push(
      { label: `${head} — 同时 running=2`, ok: result.runningCount === 2, detail: `实际 running=${result.runningCount}` },
      { label: `${head} — 第二条 run_parallel 事件`, ok: result.secondHasParallelEvent, detail: `run_parallel 事件数=${result.totalParallelEvents}（应恰为 1 且落在 B 的运行上）` },
    )
  } else {
    checks.push(
      { label: `${head} — 只跑 1 条且是先入队的 A`, ok: result.runningFirst, detail: `实际 running=${result.runningCount}` },
      { label: `${head} — B 保持排队`, ok: result.queuedSecond, detail: `实际 queued=${result.queuedCount}` },
      { label: `${head} — 无 run_parallel 事件`, ok: result.totalParallelEvents === 0, detail: `run_parallel 事件数=${result.totalParallelEvents}` },
    )
  }
}

let failed = 0
for (const check of checks) {
  if (!check.ok) failed += 1
  console.log(`[${check.ok ? 'PASS' : 'FAIL'}] ${check.label}${check.ok ? '' : ` — ${check.detail}`}`)
}
console.log(`RESULT: ${checks.length - failed}/${checks.length} PASS`)
process.exit(failed === 0 ? 0 : 1)
