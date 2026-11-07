// tests/review-subagent-gate.test.ts —— DSHBOTS-318 验收机械闸。
// owner bot 的 team_review_task 前置校验调用方当前活跃运行的子代理账目
// （run_events 的 subagent_spawned），把「验收必须经由子代理」从提示约束升级为
// 机械约束。守门四向 + 旁路锚：
// a) 有 subagent_spawned 账目 → 放行；
// b) 无账目且无兜底标记 → badRequest 且文案含「先派验收子代理」；
// c) 无账目但 comment 含「兜底验收」→ 放行；
// d) 非 in_review 状态仍走既有 conflict（闸不改变原状态校验顺序）；
// e) applyReview 直调（微信管理员/看板路径）不经闸。
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

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-gate-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new HoldingRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const dev = await service.createBot({ name: 'Builder', role: '开发', instructions: 'Build.', provider: 'fake', model: 'model-a' })
  const project = await service.createProject({ name: 'Gate', key: 'GATE', ownerBotId: director.id, memberIds: [dev.id] })
  const sessionId = 'sess-review-gate-owner'
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  return { root, store, service, director, project, sessionId }
}

async function cleanup(root, service, store) {
  for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
    try { await service.cancelRunInternal(run.id, false) } catch {}
  }
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

// 交付到位的 in_review 卡：派 Builder 后取消自动施工运行，直改待验收。
async function inReviewTask(t) {
  const task = await t.service.assignFromBot(t.sessionId, {
    assignee: 'Builder', title: '实施卡', description: '正常实施。', write_scopes: ['src/a.js'],
  })
  for (const run of t.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", task.id)) {
    await t.service.cancelRunInternal(run.id, false)
  }
  t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
  return t.store.get('SELECT * FROM tasks WHERE id = ?', task.id)
}

// 在总监会话播种一条活跃验收运行；withLedger 时同时落 subagent_spawned 账目。
function seedActiveRun(t, withLedger) {
  const runId = `run-gate-${withLedger ? 'led' : 'bare'}-${Date.now()}`
  const now = new Date().toISOString()
  t.store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, trigger_ref, status, attempt, idempotency_key, session_id, queued_at)
     VALUES (?, ?, ?, 'review', 'read', 'review_delegate', ?, 'running', 1, ?, ?, ?)`,
    runId, t.project.id, t.director.id, t.project.id, `idem-${runId}`, t.sessionId, now,
  )
  if (withLedger) {
    t.store.run(
      "INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, 'subagent_spawned', ?, ?)",
      `evt-${runId}`, runId, 'GATE 核验子代理 spawned', now,
    )
  }
  return runId
}

test('a) 有 subagent_spawned 账目 → 放行', async () => {
  const t = await setup()
  try {
    const task = await inReviewTask(t)
    seedActiveRun(t, true)
    const done = await t.service.reviewFromBot(t.sessionId, { task: 'GATE-1', decision: 'accept', comment: '核验通过：范围一致、目标测试绿' })
    assert.equal(done.status, 'done')
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'done')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('b) 无账目且无兜底标记 → badRequest 且文案含「先派验收子代理」', async () => {
  const t = await setup()
  try {
    await inReviewTask(t)
    seedActiveRun(t, false)
    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: 'GATE-1', decision: 'accept', comment: '看起来没问题' }),
      (error: { status: number; message: string }) => {
        assert.equal(error.status, 400, 'badRequest 同款错误链')
        assert.match(error.message, /没有子代理账目/)
        assert.match(error.message, /先派验收子代理（subagent\/subagent_fork）做范围比对\/目标测试\/红线预测/)
        assert.match(error.message, /兜底验收/)
        return true
      },
    )
    assert.equal(t.store.get('SELECT status FROM tasks WHERE number = 1').status, 'in_review', '拒绝不翻转任务状态')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('c) 无账目但 comment 含「兜底验收」→ 放行', async () => {
  const t = await setup()
  try {
    await inReviewTask(t)
    seedActiveRun(t, false)
    const done = await t.service.reviewFromBot(t.sessionId, {
      task: 'GATE-1', decision: 'accept', comment: '兜底验收：子代理两次失败，亲自复核目标测试全绿',
    })
    assert.equal(done.status, 'done')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('d) 非 in_review 状态仍走既有 conflict（闸不改变原状态校验顺序）', async () => {
  const t = await setup()
  try {
    // 不播种任何运行/账目：in_progress 卡必须先撞 applyReview 的状态 conflict，
    // 而不是闸的 badRequest——闸只拦真验收动作，不抢状态校验的跑。
    const task = await t.service.assignFromBot(t.sessionId, {
      assignee: 'Builder', title: '进行中卡', description: '正常实施。', write_scopes: ['src/b.js'],
    })
    // HoldingRuntime 下卡停在开工态（todo/in_progress 均非 in_review，可验冲突路径）。
    const before = t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status
    assert.notEqual(before, 'in_review')
    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: 'GATE-1', decision: 'accept' }),
      (error: { status: number; message: string }) => {
        assert.equal(error.status, 409, 'conflict 同款错误链')
        assert.match(error.message, /不在待验收状态/)
        assert.doesNotMatch(error.message, /先派验收子代理/, '状态 conflict 先于闸文案')
        return true
      },
    )
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, before, '拒绝不翻转任务状态')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('e) applyReview 直调（微信管理员/看板路径）不经闸', async () => {
  const t = await setup()
  try {
    const task = await inReviewTask(t)
    const actor = { type: 'bot', id: t.director.id }
    const done = await t.service.applyReview(task, t.project, 'accept', '管理员验收', actor)
    assert.equal(done.status, 'done', '无账目无兜底标记仍放行：闸只在 reviewFromBot 机器人路径')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})
