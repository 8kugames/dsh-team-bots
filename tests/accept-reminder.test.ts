// tests/accept-reminder.test.ts —— 验收边界沉淀提醒（吸收 dsh-agent-team
// acceptance-boundary 理念）：验收通过的当口向负责人的任务会话注入一条趁热沉淀提醒
// （team_remember 指引），并落 accept_reminder 运行事件；无会话/注入失败不阻塞验收。
// 另证记忆注入预算与结转沉淀已存在（本用例只补「验收时刻」这个钩子）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class SteerSpyRuntime {
  declare started: unknown[]
  declare steered: { sessionId: string; body: string }[]
  constructor() { this.started = []; this.steered = [] }
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun({ run }) { this.started.push({ id: run.id, kind: run.kind }); return `session-${run.id}` }
  async cancelRun() { return true }
  async steer(sessionId, body) { this.steered.push({ sessionId, body }); return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-accept-remind-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  const runtime = new SteerSpyRuntime()
  service.attachRuntime(runtime)
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Remind', key: 'RM', ownerBotId: director.id, memberIds: [dev.id] })
  const sessionId = 'sess-accept-remind-owner'
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  return { root, store, service, runtime, director, dev, project, sessionId, close: async () => {
    for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
      try { await service.cancelRunInternal(run.id, false) } catch {}
    }
    try { store.close() } catch {}
    await rm(root, { recursive: true, force: true })
  } }
}

async function setupReviewable(t) {
  const task = await t.service.assignFromBot(t.sessionId, {
    assignee: 'Builder', title: '提醒卡', description: '正常实施。', write_scopes: ['src/r.js'],
  })
  for (const run of t.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", task.id)) {
    await t.service.cancelRunInternal(run.id, false)
  }
  // 给负责人造一个带会话的历史任务运行：验收提醒的注入锚点。
  t.store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
       attempt, idempotency_key, session_id, queued_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, 'task', 'write', 'task_created', ?, 'succeeded', 1, ?, 'sess-builder-rm', ?, ?, ?)`,
    'run-rm-1', t.project.id, t.dev.id, task.id, task.id, 'idem-run-rm-1',
    new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
  )
  t.store.run(
    "INSERT INTO task_events(id, task_id, type, actor_type, actor_id, data_json, created_at) VALUES (?, ?, 'run_succeeded', 'bot', ?, ?, ?)",
    `evt-deliver-${task.id}`, task.id, t.dev.id,
    JSON.stringify({ runId: 'run-rm-1', identifier: 'RM-1' }), new Date().toISOString(),
  )
  t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
  return t.store.get('SELECT * FROM tasks WHERE id = ?', task.id)
}

test('验收通过：向负责人任务会话注入趁热沉淀提醒并落运行事件', async () => {
  const t = await setup()
  try {
    const task = await setupReviewable(t)
    const done = await t.service.applyReview(task, t.project, 'accept', '管理员验收', { type: 'user', id: 'local' })
    assert.equal(done.status, 'done')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(t.runtime.steered.length, 1, '恰注入一条提醒')
    const steer = t.runtime.steered[0]
    assert.equal(steer.sessionId, 'sess-builder-rm', '注入负责人（执行者）的任务会话')
    assert.match(steer.body, /RM-1/, '提醒点名任务号')
    assert.match(steer.body, /team_remember/, '提醒指引沉淀工具')
    assert.ok(
      t.store.get("SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'run-rm-1' AND type = 'accept_reminder'")?.n >= 1,
      '落 accept_reminder 运行事件',
    )
  } finally { await t.close() }
})

test('负责人无任务会话：提醒静默跳过，验收不受影响', async () => {
  const t = await setup()
  try {
    const task = await setupReviewable(t)
    t.store.run("UPDATE runs SET session_id = NULL WHERE id = 'run-rm-1'")
    const done = await t.service.applyReview(task, t.project, 'accept', '管理员验收', { type: 'user', id: 'local' })
    assert.equal(done.status, 'done')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(t.runtime.steered.length, 0)
  } finally { await t.close() }
})
