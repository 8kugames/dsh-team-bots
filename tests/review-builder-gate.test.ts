// tests/review-builder-gate.test.ts —— 执行者不得验收（builder≠verifier 机械闸）。
// 吸收自 dsh-agent-team 的协作理念，落在本项目形态：bot 验收者若曾担任本卡负责人
// （当前 assignee 或 task_events 的 created/assigned 历史）即拒；人与 system 不经闸。
// ① owner bot 恰是本卡执行者 → accept 拒，文案指明转派/看板两条下一步；
// ② owner bot 是历史执行者（已改派给别人）→ 仍拒；
// ③ 执行者 bot return 退回不拦（退回是重做指令，不是验收裁决）；
// ④ 人（user actor）直调 applyReview 验收自己执行过的卡 → 放行（信任边界归人）；
// ⑤ owner bot 验收他人执行且子代理账目齐全的卡 → 放行（对既有回归的对照）。
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-builder-gate-'))
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
  const project = await service.createProject({ name: 'BGate', key: 'BGATE', ownerBotId: director.id, memberIds: [dev.id] })
  const sessionId = 'sess-builder-gate-owner'
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  return { root, store, service, director, dev, project, sessionId }
}

async function cleanup(root, service, store) {
  for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
    try { await service.cancelRunInternal(run.id, false) } catch {}
  }
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

// 建卡（assignee 指向指定 bot）、清自动运行、置 in_review 并落交付锚点。
async function reviewableCard(t, assigneeName, title) {
  const task = await t.service.assignFromBot(t.sessionId, {
    assignee: assigneeName, title, description: '正常实施。', write_scopes: ['src/bg.js'],
  })
  for (const run of t.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", task.id)) {
    await t.service.cancelRunInternal(run.id, false)
  }
  t.store.run(
    "INSERT INTO task_events(id, task_id, type, actor_type, actor_id, data_json, created_at) VALUES (?, ?, 'run_succeeded', 'bot', ?, ?, ?)",
    `evt-deliver-${task.id}`, task.id, t.director.id,
    JSON.stringify({ runId: `run-deliver-${task.id}`, identifier: `BGATE-${task.number}` }),
    new Date().toISOString(),
  )
  t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
  return t.store.get('SELECT * FROM tasks WHERE id = ?', task.id)
}

test('① owner bot 验收自己执行的卡 → 拒，文案含转派与看板两条出路', async () => {
  const t = await setup()
  try {
    const task = await reviewableCard(t, 'director', '总监自建卡')
    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: 'BGATE-1', decision: 'accept', comment: '兜底验收' }),
      (error: any) => {
        assert.match(error.message, /执行者不得验收/)
        assert.match(error.message, /team_assign_task/)
        assert.match(error.message, /看板/)
        return true
      },
    )
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'in_review')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('② owner bot 是历史执行者（已改派给 Builder）→ 仍拒', async () => {
  const t = await setup()
  try {
    const task = await reviewableCard(t, 'director', '先自建后改派')
    await t.service.assignTask(task.id, t.dev.id, { type: 'user', id: 'local' })
    // 改派会重排施工把卡拉回 in_progress：历史执行者场景只关心派单历史，直接置回待验收。
    t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", task.id)
    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: 'BGATE-1', decision: 'accept', comment: '兜底验收' }),
      (error: any) => /执行者不得验收/.test(error.message),
    )
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('③ 执行者 bot 退回（return）不受闸影响', async () => {
  const t = await setup()
  try {
    await reviewableCard(t, 'director', '自建卡退回')
    const returned = await t.service.reviewFromBot(t.sessionId, {
      task: 'BGATE-1', decision: 'return', comment: '兜底验收：实现不符',
    })
    assert.equal(returned.status, 'in_progress')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('④ 人（user actor）直调 applyReview 验收同一张卡 → 放行', async () => {
  const t = await setup()
  try {
    const task = await reviewableCard(t, 'director', '人验收自建卡')
    const done = await t.service.applyReview(
      t.store.get('SELECT * FROM tasks WHERE id = ?', task.id), t.project, 'accept', '管理员验收',
      { type: 'user', id: 'local' },
    )
    assert.equal(done.status, 'done')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})

test('⑤ owner bot 验收他人执行且带子代理账目的卡 → 放行（对照回归）', async () => {
  const t = await setup()
  try {
    const task = await reviewableCard(t, 'Builder', '正常卡')
    const runId = 'run-bg-verify'
    const now = new Date().toISOString()
    t.store.run(
      `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
         attempt, idempotency_key, session_id, queued_at, started_at, ended_at)
       VALUES (?, ?, ?, ?, 'review', 'read', 'review_delegate', ?, 'succeeded', 1, ?, ?, ?, ?, ?)`,
      runId, t.project.id, t.director.id, task.id, task.id, `idem-${runId}`, t.sessionId, now, now, now,
    )
    t.store.run(
      "INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, 'subagent_spawned', ?, ?)",
      `evt-${runId}`, runId, 'BGATE 核验子代理 spawned', now,
    )
    const done = await t.service.reviewFromBot(t.sessionId, { task: 'BGATE-1', decision: 'accept', comment: '核验通过' })
    assert.equal(done.status, 'done')
  } finally {
    await cleanup(t.root, t.service, t.store)
  }
})
