// tests/review-goal-gate.test.ts —— 验收对照 Goal 闸与留痕。
// 有 Goal 的卡，bot 验收路径的 comment 必须写明当前版本号；accept 逐条引用全部完成标准，
// return 至少引用一条。机械闸只认格式；「兜底验收」只豁免子代理账目，不豁免引用。
// ① 无引用 / 版本写错 / 缺标准 → badRequest，卡留在 in_review；
// ② 引用齐全 → 放行，落 reviewed 事件；
// ③ 交付时的 Goal 版本与验收时不一致 → goal_version_mismatch 事件（目标漂移可分型）；
// ④ 没有 Goal 的卡不拦；人工路径（applyReview 直调）不拦但照常留痕。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class HoldingRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
  async startRun() { return 'session-stub' }
  async cancelRun() { return true }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-goal-'))
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
  const project = await service.createProject({ name: 'Gate', key: 'GG', ownerBotId: director.id, memberIds: [dev.id] })
  const sessionId = 'sess-review-goal-owner'
  store.run(
    'INSERT INTO session_bindings(session_id, bot_id, project_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    sessionId, director.id, project.id, 'project', new Date().toISOString(),
  )
  const actor = { type: 'user', id: service.localUserId }
  return { root, store, service, director, dev, project, sessionId, actor }
}

async function cleanup(root, service, store) {
  for (const run of store.all("SELECT id FROM runs WHERE status IN ('queued', 'running')")) {
    try { await service.cancelRunInternal(run.id, false) } catch {}
  }
  try { store.close() } catch {}
  await rm(root, { recursive: true, force: true })
}

const GOAL = { statement: '登录页可用手机号登录', criteria: ['能收到验证码', '验证码错误有提示', '连错 5 次锁定'] }

// 建卡 → 交付（带子代理账目的已结束核验运行）→ in_review。deliveredGoalVersion 写进交付事件。
async function deliveredCard(t, { goal = GOAL, deliveredGoalVersion = 1 } = {}) {
  const card = await t.service.createTask(
    { projectId: t.project.id, title: '带 Goal 的卡', writeScopes: ['src/a.js'], assigneeBotId: t.dev.id, ...(goal ? { goal } : {}), postCard: false },
    t.actor,
  )
  for (const run of t.store.all("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running')", card.id)) {
    await t.service.cancelRunInternal(run.id, false)
  }
  const at = new Date().toISOString()
  t.service.groupChatStore(t.project.id).run(
    'INSERT INTO task_events(id, task_id, type, actor_type, actor_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    `evt-deliver-${card.id}`, card.id, 'run_succeeded', 'bot', t.dev.id,
    JSON.stringify({ runId: `run-deliver-${card.id}`, identifier: `GG-${card.number}`, goalVersion: deliveredGoalVersion }), at,
  )
  // 本评审周期内的子代理核验账目：让第一道闸（子代理账目）放行，只测 Goal 引用闸。
  t.store.run(
    `INSERT INTO runs(id, project_id, bot_id, task_id, kind, mode, trigger_type, trigger_ref, status,
       attempt, idempotency_key, session_id, queued_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, 'review', 'read', 'review_delegate', ?, 'succeeded', 1, ?, ?, ?, ?, ?)`,
    `run-verify-${card.id}`, t.project.id, t.director.id, card.id, card.id, `idem-verify-${card.id}`, t.sessionId, at, at, at,
  )
  t.service.groupChatStore(t.project.id).run(
    "INSERT INTO run_events(id, run_id, type, message, created_at) VALUES (?, ?, 'subagent_spawned', ?, ?)",
    `evt-ledger-${card.id}`, `run-verify-${card.id}`, '核验子代理 spawned', at,
  )
  t.store.run("UPDATE tasks SET status = 'in_review' WHERE id = ?", card.id)
  return t.store.get('SELECT * FROM tasks WHERE id = ?', card.id)
}

const eventsOf = (t, taskId, type) => t.service.groupChatStore(t.project.id).all(
  'SELECT data_json FROM task_events WHERE task_id = ? AND type = ? ORDER BY created_at, rowid', taskId, type,
).map(row => JSON.parse(row.data_json))

test('① 无引用、版本写错、缺标准都被拒，卡留在 in_review，不留 reviewed 事件', async () => {
  const t = await setup()
  try {
    const task = await deliveredCard(t)
    const review = comment => t.service.reviewFromBot(t.sessionId, { task: `GG-${task.number}`, decision: 'accept', comment })
    await assert.rejects(review(undefined), /没有对照当前 Goal（v1）/)
    await assert.rejects(review('范围一致，目标测试全绿'), /需写明「Goal v1」/)
    await assert.rejects(review('Goal v2：C1、C2、C3 均通过'), /你引用的是 v2，卡片当前是 v1/)
    await assert.rejects(review('Goal v1：C1、C2 通过'), /缺少 C3/)
    // 「兜底验收」只豁免子代理账目，不豁免 Goal 引用。
    await assert.rejects(review('兜底验收：核验子代理失败，总监复核通过'), /需写明「Goal v1」/)
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'in_review', '被拒的验收不改状态')
    assert.equal(eventsOf(t, task.id, 'reviewed').length, 0, '被拒的验收不留 reviewed 事件')
    assert.equal(t.service.groupChatStore(t.project.id).get('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?', task.id).n, 0)
  } finally { await cleanup(t.root, t.service, t.store) }
})

test('② 引用齐全放行：accept 逐条引用，return 至少引用一条未通过的标准', async () => {
  const t = await setup()
  try {
    const task = await deliveredCard(t)
    const returned = await t.service.reviewFromBot(t.sessionId, {
      task: `GG-${task.number}`, decision: 'return', comment: 'Goal v1：C3 未通过，连错 5 次没有锁定',
    })
    assert.equal(returned.status, 'in_progress', '退回重做回到进行中')
    const returnedEvent = eventsOf(t, task.id, 'reviewed')[0]
    assert.deepEqual(
      { decision: returnedEvent.decision, goalVersion: returnedEvent.goalVersion, citedGoalVersion: returnedEvent.citedGoalVersion },
      { decision: 'return', goalVersion: 1, citedGoalVersion: 1 },
    )

    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: `GG-${task.number}`, decision: 'return', comment: 'Goal v1：整体需要重做' }),
      /任务 .* 不在待验收状态/,
    )
  } finally { await cleanup(t.root, t.service, t.store) }
})

test('③ accept 引用全部标准后关单，reviewed 事件记下版本', async () => {
  const t = await setup()
  try {
    const task = await deliveredCard(t)
    const done = await t.service.reviewFromBot(t.sessionId, {
      task: `GG-${task.number}`, decision: 'accept', comment: 'Goal v1：C1 通过（日志见评论），C2 通过，C3 通过',
    })
    assert.equal(done.status, 'done')
    const reviewed = eventsOf(t, task.id, 'reviewed')[0]
    assert.equal(reviewed.decision, 'accept')
    assert.equal(reviewed.goalVersion, 1)
    assert.equal(reviewed.citedGoalVersion, 1)
    assert.equal(eventsOf(t, task.id, 'goal_version_mismatch').length, 0, '交付版本与验收版本一致，不算漂移')
  } finally { await cleanup(t.root, t.service, t.store) }
})

test('④ 交付后目标被改：验收时落 goal_version_mismatch，旧版本号也会被拒', async () => {
  const t = await setup()
  try {
    const task = await deliveredCard(t)
    await t.service.updateTask(task.id, { goal: { statement: '登录页支持手机号与邮箱登录', criteria: GOAL.criteria } }, t.actor)
    assert.equal(t.store.get('SELECT goal_version FROM tasks WHERE id = ?', task.id).goal_version, 2)
    await assert.rejects(
      t.service.reviewFromBot(t.sessionId, { task: `GG-${task.number}`, decision: 'accept', comment: 'Goal v1：C1、C2、C3 通过' }),
      /你引用的是 v1，卡片当前是 v2/,
    )
    await t.service.reviewFromBot(t.sessionId, { task: `GG-${task.number}`, decision: 'accept', comment: 'Goal v2：C1、C2、C3 通过' })
    const mismatch = eventsOf(t, task.id, 'goal_version_mismatch')[0]
    assert.deepEqual(mismatch, { decision: 'accept', deliveredGoalVersion: 1, goalVersion: 2 }, '交付对着 v1 做、验收对着 v2 判，记一笔漂移')
  } finally { await cleanup(t.root, t.service, t.store) }
})

test('⑤ 没有 Goal 的卡不拦；人工路径不拦但照常留痕', async () => {
  const t = await setup()
  try {
    const plain = await deliveredCard(t, { goal: null, deliveredGoalVersion: null })
    const done = await t.service.reviewFromBot(t.sessionId, { task: `GG-${plain.number}`, decision: 'accept', comment: '核验通过：范围一致、目标测试绿' })
    assert.equal(done.status, 'done', '无 Goal 的卡沿用既有验收行为')
    assert.deepEqual(eventsOf(t, plain.id, 'reviewed')[0], { decision: 'accept', goalVersion: null, citedGoalVersion: null })
    assert.equal(eventsOf(t, plain.id, 'goal_version_mismatch').length, 0)

    const task = await deliveredCard(t)
    await t.service.applyReview(task, t.project, 'accept', '人工验收通过', t.actor)
    assert.equal(t.store.get('SELECT status FROM tasks WHERE id = ?', task.id).status, 'done', '工作台/微信管理员路径不做格式闸')
    assert.equal(eventsOf(t, task.id, 'reviewed')[0].citedGoalVersion, null, '人工结论没写版本号，如实记 null')
  } finally { await cleanup(t.root, t.service, t.store) }
})
