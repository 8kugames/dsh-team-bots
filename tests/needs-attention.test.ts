// tests/needs-attention.test.ts —— A2+B9/DSHBOTS-322：needs-attention 聚合守门。
// health() 与 state 同源消费 needsAttentionView：待审/待答/待验收/滞留卡计数 + 系统问题
// 条目（outbox 投递耗尽、微信通道异常）。反双真值：只读聚合，不改状态真值。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import { resolveConfig } from '../src/config.js'
import { TeamService } from '../src/service.js'

class StubRuntime {
  setCompletionHandler() {}
  async catalog() { return [] }
  async validateBotConfig() {}
}

const HOURS = 3_600_000

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-needs-attention-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const config = resolveConfig({ workspace, dataDir, skillRoot: join(workspace, '.agents'), modelCacheMs: 0, schedulerIntervalMs: 30_000 })
  const store = openDatabase(config.dbPath)
  const service = new TeamService({ store, config, logger: { info() {}, warn() {}, error() {} } })
  service.attachRuntime(new StubRuntime())
  await service.initialize()
  service.started = true
  const director = store.get("SELECT * FROM bots WHERE name = 'director'")
  const projectView = await service.createProject({ name: 'Order', key: 'ORD', ownerBotId: director.id })
  const project = store.get('SELECT * FROM projects WHERE id = ?', projectView.id)
  const now = Date.now()
  const iso = (ms = now) => new Date(ms).toISOString()
  const seedTask = (id, number, status, updatedAtMs) => store.run(
    `INSERT INTO tasks(id, project_id, number, title, status, priority, creator_type, creator_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'medium', 'user', 'u1', ?, ?)`,
    id, project.id, number, `任务 ${number}`, status, iso(now), iso(updatedAtMs),
  )
  return { root, store, service, project, director, iso, seedTask, now }
}

async function teardown(root, store) {
  try { await store.close() } catch { /* 忽略 */ }
  await rm(root, { recursive: true, force: true })
}

test('needsAttentionView 汇总四类需要人计数与系统问题条目', async () => {
  const { root, store, service, project, director, iso, seedTask, now } = await setup()
  try {
    // 待审 1、待答 1、待验收 2（其中 1 张同时滞留 >24h）、outbox 投递耗尽 1 行。
    store.run(
      `INSERT INTO approvals(id, project_id, bot_id, tool_name, status, created_at, expires_at)
       VALUES ('ap1', ?, ?, 'bash', 'pending', ?, ?)`,
      project.id, director.id, iso(now), iso(now + 10 * 60_000),
    )
    store.run(
      `INSERT INTO questions(id, project_id, bot_id, questions, status, created_at, expires_at)
       VALUES ('q1', ?, ?, '[]', 'pending', ?, ?)`,
      project.id, director.id, iso(now), iso(now + 10 * 60_000),
    )
    seedTask('t-fresh', 1, 'in_review', now)
    seedTask('t-stale', 2, 'in_review', now - 100 * HOURS) // 超过 in_review 24h 阈值
    store.run(
      `INSERT INTO outbox(id, kind, payload_json, status, available_at, created_at)
       VALUES ('ob1', 'chat_run', '{}', 'failed', ?, ?)`,
      iso(now), iso(now),
    )
    // 微信通道异常（enabled 且 phase 非 connected/connecting）。
    service.wechat = { status: () => ({ phase: 'needs_reauth', enabled: true, error: 'credentials expired', auth: null }) } as any

    const view = service.needsAttentionView()
    assert.deepEqual(view.needsYou, { approvals: 1, questions: 1, reviews: 2, stale: 1 })
    assert.equal(view.issues.length, 2)
    const outboxIssue = view.issues.find(issue => issue.kind === 'outbox_failed')
    assert.equal(outboxIssue.count, 1)
    assert.equal(outboxIssue.since, iso(now))
    const wechatIssue = view.issues.find(issue => issue.kind === 'wechat_channel')
    assert.equal(wechatIssue.phase, 'needs_reauth')

    // health() 与聚合同源（外部巡检口径）。
    const health = await service.health()
    assert.deepEqual(health.needsAttention, view)
  } finally {
    await teardown(root, store)
  }
})

test('Quiet by default：无待办无问题时聚合为零数组，解决事项后计数回落', async () => {
  const { root, store, service, project, director, iso, seedTask, now } = await setup()
  try {
    const view = service.needsAttentionView()
    assert.deepEqual(view, { needsYou: { approvals: 0, questions: 0, reviews: 0, stale: 0 }, issues: [] })

    seedTask('t1', 1, 'in_review', now)
    store.run(
      `INSERT INTO questions(id, project_id, bot_id, questions, status, created_at, expires_at)
       VALUES ('q1', ?, ?, '[]', 'pending', ?, ?)`,
      project.id, director.id, iso(now), iso(now + 10 * 60_000),
    )
    assert.equal(service.needsAttentionView().needsYou.questions, 1)
    assert.equal(service.needsAttentionView().needsYou.reviews, 1)
    // 解决事项：计数回落，不残留（反双真值——计数是复算不是状态）。
    store.run("UPDATE questions SET status = 'answered' WHERE id = 'q1'")
    store.run("UPDATE tasks SET status = 'done' WHERE id = 't1'")
    assert.deepEqual(service.needsAttentionView(), { needsYou: { approvals: 0, questions: 0, reviews: 0, stale: 0 }, issues: [] })
  } finally {
    await teardown(root, store)
  }
})

test('滞留判定复用 staleCardHit：阈值内的 in_review 不算滞留，blocked/backlog 超时计入', async () => {
  const { root, store, service, iso, seedTask, now } = await setup()
  try {
    seedTask('t-ok', 1, 'in_review', now - 2 * HOURS) // 24h 阈值内
    seedTask('t-blocked', 2, 'blocked', now - 50 * HOURS) // 48h 阈值外
    seedTask('t-backlog', 3, 'backlog', now - 80 * HOURS) // 72h 阈值外
    const view = service.needsAttentionView()
    assert.equal(view.needsYou.reviews, 1)
    assert.equal(view.needsYou.stale, 2)
  } finally {
    await teardown(root, store)
  }
})
