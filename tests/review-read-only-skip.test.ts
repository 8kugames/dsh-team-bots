// tests/review-read-only-skip.test.js —— 验收核验分档（P0）：只读档交付免自动核验。
// 单一口径 readOnlyDelivery（task-review.js）：交付运行生效沙箱 read-only
// （任务覆盖 override 或负责人配置档 bot_config）时——
// ① queueAutoReviewDelegate 跳过（审计 skipped:'read_only'，不排 outbox）；
// ② assertReviewSubagentVerified 免子代理账目，验收直通；
// ③ taskReviewStatus 标 skipped（UI「只读免核验」，不误报未核验）；
// ④ 写档交付（无覆盖、写档 bot）三处全部维持强制：照排自动核验、闸门照拦、状态 none；
// ⑤ reviewReadOnlySkip=false 关闭分档：只读交付回到全量强制。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class HoldingRuntime {
  declare started: unknown[]
  constructor() { this.started = [] }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { this.started.push({ id: run.id, kind: run.kind }); return `session-${run.id}` }
  async cancelRun() { return true }
}

async function setup({ reviewReadOnlySkip = true }: { reviewReadOnlySkip?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-ro-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  // 环境变量隔离：分档与自动委派开关都不许被外层 env 串扰。
  const savedSkip = process.env.DSH_TEAM_REVIEW_READ_ONLY_SKIP
  const savedAuto = process.env.DSH_TEAM_AUTO_REVIEW_DELEGATE
  delete process.env.DSH_TEAM_REVIEW_READ_ONLY_SKIP
  delete process.env.DSH_TEAM_AUTO_REVIEW_DELEGATE
  const config = resolveConfig({
    workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000,
    ...(reviewReadOnlySkip ? {} : { reviewReadOnlySkip: false }),
  })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({
    name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a',
  })
  const project = await service.createProject({ name: 'ROSkip', key: 'ROS', ownerBotId: director.id, memberIds: [dev.id] })
  const sessionId = 'sess-review-ro-owner'
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  const close = async () => {
    for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
      try { await service.cancelRunInternal(run.id, false) } catch {}
    }
    try { store.close() } catch {}
    for (const [key, value] of [['DSH_TEAM_REVIEW_READ_ONLY_SKIP', savedSkip], ['DSH_TEAM_AUTO_REVIEW_DELEGATE', savedAuto]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
  return { root, store, service, director, dev, project, sessionId, close }
}

// 建卡并清掉自动施工运行；交付=真实 run 行 + run_succeeded 事件（载荷 runId 指回）+ in_review。
async function deliveredTask(t, { sandboxOverride = null, runMode = 'write' }: { sandboxOverride?: string | null, runMode?: string } = {}) {
  const task = await t.service.assignFromBot(t.sessionId, {
    assignee: 'Builder', title: `分档卡-${Math.random().toString(36).slice(2, 7)}`,
    description: '正常实施。', write_scopes: ['src/a.js'],
  })
  for (const run of t.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", task.id)) {
    await t.service.cancelRunInternal(run.id, false)
  }
  if (sandboxOverride) t.store.run('UPDATE tasks SET sandbox_override = ? WHERE id = ?', sandboxOverride, task.id)
  const runId = `run-deliver-${task.id}`
  const now = new Date().toISOString()
  t.store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
       attempt, idempotency_key, queued_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, 'task', ?, 'task_created', ?, 'succeeded', 1, ?, ?, ?, ?)`,
    runId, t.project.id, t.dev.id, task.id, runMode, task.id, `idem-${runId}`, now, now, now,
  )
  t.service.addTaskEvent(task.id, 'run_succeeded', { type: 'bot', id: t.dev.id }, { runId, identifier: `ROS-${task.number}` })
  t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
  const fresh = t.store.get('SELECT * FROM tasks WHERE id = ?', task.id)
  const run = t.store.get('SELECT * FROM runs WHERE id = ?', runId)
  return { task: fresh, run }
}

test('任务覆盖只读档：自动核验跳过（审计留痕）、验收免账直通、状态标 skipped', async () => {
  const t = await setup()
  try {
    const { task, run } = await deliveredTask(t, { sandboxOverride: 'read-only' })
    // ① 自动委派跳过：不排 outbox，审计 skipped:'read_only'。
    assert.equal(t.service.queueAutoReviewDelegate(task, t.project, run, false), false)
    assert.equal(
      Number(t.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'review_delegate_auto' AND task_id = ?", task.id).n),
      0, '只读交付不排自动核验',
    )
    assert.ok(t.store.get(
      "SELECT 1 AS hit FROM audit_log WHERE action = 'review.auto_delegate' AND target_id = ? AND data_json LIKE '%read_only%'",
      task.id,
    ), '跳过留审计痕')
    // ② 验收闸门放宽：无任何 subagent_spawned 账目仍直通。
    const done = await t.service.reviewFromBot(t.sessionId, { task: `ROS-${task.number}`, decision: 'accept', comment: '只读报告已读，结论可信' })
    assert.equal(done.status, 'done')
    // ③ 核验状态标 skipped。
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
    assert.equal(t.service.taskReviewStatus(t.store.get('SELECT * FROM tasks WHERE id = ?', task.id)), 'skipped')
  } finally { await t.close() }
})

test('负责人配置档只读（bot_config 回落分支）同样豁免：override 为空时取 bot.file_policy', async () => {
  const t = await setup()
  try {
    const { task, run } = await deliveredTask(t, {})
    // 卡无 sandbox_override；负责人配置档收紧为只读后，effectiveSandbox 回落 bot_config 分支。
    t.store.run("UPDATE bots SET file_policy = 'read-only' WHERE id = ?", t.dev.id)
    assert.equal(t.service.readOnlyDelivery(run, task), true, 'override 为空回落 bot 配置档')
    assert.equal(t.service.queueAutoReviewDelegate(task, t.project, run, false), false)
    const done = await t.service.reviewFromBot(t.sessionId, { task: `ROS-${task.number}`, decision: 'accept', comment: '只读卡直收' })
    assert.equal(done.status, 'done')
  } finally { await t.close() }
})

test('写档交付维持强制：照排自动核验、闸门照拦、状态 none', async () => {
  const t = await setup()
  try {
    const { task, run } = await deliveredTask(t, {})
    // 自动委派照排（总监在位）。
    assert.equal(t.service.queueAutoReviewDelegate(task, t.project, run, false), true)
    assert.ok(
      t.store.get("SELECT id FROM outbox WHERE kind = 'review_delegate_auto' AND task_id = ?", task.id),
      '写档交付照排自动核验',
    )
    // 闸门照拦：无账目拒收。
    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: `ROS-${task.number}`, decision: 'accept', comment: '看起来没问题' }),
      (error: { status: number; message: string }) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /本次评审没有核验证据/)
        return true
      },
    )
    assert.equal(t.service.taskReviewStatus(task), 'pending', '已排自动核验：状态为核验中')
  } finally { await t.close() }
})

test('reviewReadOnlySkip=false 关闭分档：只读交付回到全量强制', async () => {
  const t = await setup({ reviewReadOnlySkip: false })
  try {
    const { task, run } = await deliveredTask(t, { sandboxOverride: 'read-only' })
    assert.equal(t.service.queueAutoReviewDelegate(task, t.project, run, false), true, '开关关闭照排自动核验')
    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: `ROS-${task.number}`, decision: 'accept', comment: '看起来没问题' }),
      (error: { status: number }) => error.status === 400,
    )
    assert.equal(t.service.taskReviewStatus(task), 'pending', '开关关闭照排自动核验：核验中')
  } finally { await t.close() }
})
