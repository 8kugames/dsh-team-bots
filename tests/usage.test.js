import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db.js'
import {
  applyRetention,
  recordUsage,
  reconcileUsage,
  reconciliationSummary,
  setPrice,
  usageSnapshot,
} from '../src/usage.js'

// 用量统计与对账口径的回归测试：保留期清理、过期 vs 丢失、零用量分档、未计价计数、对账记录清理。

const DAY = 86_400_000

async function withStore(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-'))
  const store = openDatabase(join(root, 'team.sqlite'))
  try {
    await fn(store)
  } finally {
    try {
      store.close()
    } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

function seedBot(store, id, name) {
  const now = new Date().toISOString()
  store.run(
    `INSERT INTO bots(id, name, role, instructions, color, status, current_revision, created_at, updated_at)
     VALUES (?, ?, 'dev', '', 'blue', 'active', 0, ?, ?)`,
    id, name, now, now,
  )
}

function seedProject(store, { id, key, name, slug, ownerBotId = 'b1' }) {
  const now = new Date().toISOString()
  store.run(
    `INSERT INTO projects(id, key, name, slug, owner_bot_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    id, key, name, slug, ownerBotId, now, now,
  )
}

function seedRun(store, {
  id,
  projectId = null,
  botId,
  queuedAt,
  endedAt = queuedAt,
  usageInput = 0,
  usageOutput = 0,
}) {
  store.run(
    `INSERT INTO runs(id, project_id, bot_id, kind, mode, trigger_type, status, attempt, idempotency_key,
        queued_at, started_at, ended_at, usage_input, usage_output)
     VALUES (?, ?, ?, 'task', 'write', 'manual', 'succeeded', 1, ?, ?, ?, ?, ?, ?)`,
    id, projectId, botId, `key-${id}`, queuedAt, endedAt, endedAt, usageInput, usageOutput,
  )
}

function seedReconciliation(store, { id, runId, status = 'ok', checkedAt }) {
  store.run(
    `INSERT INTO usage_reconciliation(id, run_id, event_calls, event_tokens, run_tokens, delta_tokens, status, note, checked_at)
     VALUES (?, ?, 0, 0, 0, 0, ?, '', ?)`,
    id, runId, status, checkedAt,
  )
}

test('保留期清理掉的用量明细判 expired，不再算作数据丢失', async () => {
  await withStore(async (store) => {
    seedBot(store, 'b1', 'Builder')
    seedProject(store, { id: 'p1', key: 'P1', name: 'Alpha', slug: 'alpha' })
    const endedAt = new Date(Date.now() - 10 * DAY).toISOString()
    seedRun(store, { id: 'r1', projectId: 'p1', botId: 'b1', queuedAt: endedAt, endedAt, usageInput: 100, usageOutput: 10 })
    recordUsage(store, {
      sourceKey: 'u:r1',
      run: { id: 'r1', project_id: 'p1', bot_id: 'b1' },
      provider: 'fake',
      model: 'model-a',
      usage: { inputTokens: 100, outputTokens: 10 },
      occurredAt: endedAt,
    })

    const retention = applyRetention(store, { usageDays: 7 })
    assert.equal(retention.usageEvents, 1)
    assert.equal(retention.usage.removed, 1)
    assert.equal(typeof retention.usage.before, 'string')
    assert.ok(!store.get("SELECT * FROM usage_events WHERE source_key = 'u:r1'"))

    const summary = reconcileUsage(store, { days: 30, expiredBefore: retention.usage.before })
    assert.equal(summary.expiredUsage, 1)
    assert.equal(summary.missingUsage, 0)
    assert.equal(summary.mismatched, 0)
    const record = store.get('SELECT * FROM usage_reconciliation WHERE run_id = ?', 'r1')
    assert.equal(record.status, 'expired')

    const snapshot = reconciliationSummary(store)
    assert.equal(snapshot.expiredUsage, 1)
    assert.equal(snapshot.missingUsage, 0)
    assert.equal(snapshot.mismatched, 0)
  })
})

test('真正缺少用量明细的运行仍判 missing 并计入不一致', async () => {
  await withStore(async (store) => {
    seedBot(store, 'b1', 'Builder')
    seedProject(store, { id: 'p1', key: 'P1', name: 'Alpha', slug: 'alpha' })
    const endedAt = new Date().toISOString()
    seedRun(store, { id: 'r1', projectId: 'p1', botId: 'b1', queuedAt: endedAt, endedAt, usageInput: 50 })

    const summary = reconcileUsage(store, { days: 30 })
    assert.equal(summary.missingUsage, 1)
    assert.equal(summary.expiredUsage, 0)
    assert.equal(summary.mismatched, 1)
    const record = store.get('SELECT * FROM usage_reconciliation WHERE run_id = ?', 'r1')
    assert.equal(record.status, 'missing')

    // 过期边界只豁免早于边界的运行：新运行缺明细仍然是 missing。
    const again = reconcileUsage(store, { days: 30, expiredBefore: new Date(Date.now() - 365 * DAY).toISOString() })
    assert.equal(again.missingUsage, 1)
    assert.equal(again.expiredUsage, 0)
    assert.equal(again.mismatched, 1)
  })
})

test('跑过但没有用量明细的 Bot 与项目仍出现在分档统计里', async () => {
  await withStore(async (store) => {
    seedBot(store, 'b1', 'Builder')
    seedBot(store, 'b2', 'Runner')
    seedProject(store, { id: 'p1', key: 'P1', name: 'Alpha', slug: 'alpha' })
    seedProject(store, { id: 'p2', key: 'P2', name: 'Beta', slug: 'beta' })
    const now = new Date().toISOString()
    seedRun(store, { id: 'r1', projectId: 'p1', botId: 'b1', queuedAt: now })
    seedRun(store, { id: 'r2', projectId: 'p2', botId: 'b2', queuedAt: now })
    recordUsage(store, {
      sourceKey: 'u:r1',
      run: { id: 'r1', project_id: 'p1', bot_id: 'b1' },
      provider: 'fake',
      model: 'model-a',
      usage: { inputTokens: 100, outputTokens: 10 },
    })

    const snapshot = usageSnapshot(store, null, 30)
    const builder = snapshot.byBot.find(item => item.botId === 'b1')
    const runner = snapshot.byBot.find(item => item.botId === 'b2')
    assert.equal(builder.totalTokens, 110)
    assert.equal(builder.calls, 1)
    assert.equal(runner.totalTokens, 0)
    assert.equal(runner.calls, 0)
    assert.equal(runner.cost, 0)
    assert.equal(runner.unpricedCalls, 0)
    assert.equal(runner.costComplete, true)

    const alpha = snapshot.byProject.find(item => item.projectId === 'p1')
    const beta = snapshot.byProject.find(item => item.projectId === 'p2')
    assert.equal(alpha.totalTokens, 110)
    assert.equal(beta.totalTokens, 0)
    assert.equal(beta.calls, 0)

    // 全局汇总只统计真实发生的调用，零用量行不污染总量。
    assert.equal(snapshot.global.totalTokens, 110)
    assert.equal(snapshot.global.calls, 1)

    // 项目口径下 p2 的运行不计入 p1。
    const projectScope = usageSnapshot(store, 'p1', 30)
    assert.equal(projectScope.scopeTiers.project.byBot.length, 1)
    assert.equal(projectScope.scopeTiers.project.byBot[0].botId, 'b1')
    assert.equal(projectScope.scopeTiers.project.byProject.length, 1)
  })
})

test('未计价调用单独计数，不与已计价成本混算', async () => {
  await withStore(async (store) => {
    seedBot(store, 'b1', 'Builder')
    seedBot(store, 'b2', 'Runner')
    seedProject(store, { id: 'p1', key: 'P1', name: 'Alpha', slug: 'alpha' })
    setPrice(store, {
      provider: 'fake',
      model: 'model-a',
      inputPerMtok: 10,
      outputPerMtok: 20,
      effectiveAt: '2020-01-01T00:00:00.000Z',
    })
    const now = new Date().toISOString()
    seedRun(store, { id: 'r1', projectId: 'p1', botId: 'b1', queuedAt: now })
    seedRun(store, { id: 'r2', projectId: 'p1', botId: 'b2', queuedAt: now })
    recordUsage(store, {
      sourceKey: 'u:r1',
      run: { id: 'r1', project_id: 'p1', bot_id: 'b1' },
      provider: 'fake',
      model: 'model-a',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })
    recordUsage(store, {
      sourceKey: 'u:r2',
      run: { id: 'r2', project_id: 'p1', bot_id: 'b2' },
      provider: 'other',
      model: 'model-b',
      usage: { inputTokens: 500, outputTokens: 100 },
    })

    const snapshot = usageSnapshot(store, null, 30)
    assert.equal(snapshot.global.calls, 2)
    assert.equal(snapshot.global.pricedCalls, 1)
    assert.equal(snapshot.global.unpricedCalls, 1)
    assert.equal(snapshot.global.costComplete, false)
    // 已计价成本口径不变：只累加命中价格表的明细。
    assert.equal(snapshot.global.cost, 30)
    assert.deepEqual(snapshot.global.costByCurrency, { CNY: 30 })

    const builder = snapshot.byBot.find(item => item.botId === 'b1')
    const runner = snapshot.byBot.find(item => item.botId === 'b2')
    assert.equal(builder.pricedCalls, 1)
    assert.equal(builder.unpricedCalls, 0)
    assert.equal(builder.cost, 30)
    assert.equal(builder.costComplete, true)
    assert.equal(runner.pricedCalls, 0)
    assert.equal(runner.unpricedCalls, 1)
    assert.equal(runner.cost, null)
    assert.equal(runner.costComplete, false)
  })
})

test('对账记录按保留期清理', async () => {
  await withStore(async (store) => {
    seedBot(store, 'b1', 'Builder')
    const now = new Date().toISOString()
    seedRun(store, { id: 'r1', botId: 'b1', queuedAt: now })
    seedRun(store, { id: 'r2', botId: 'b1', queuedAt: now })
    seedReconciliation(store, { id: 'rec_old', runId: 'r1', checkedAt: new Date(Date.now() - 40 * DAY).toISOString() })
    seedReconciliation(store, { id: 'rec_new', runId: 'r2', checkedAt: now })

    const removed = applyRetention(store, { reconciliationDays: 30 })
    assert.equal(removed.reconciliationRecords, 1)
    assert.equal(removed.reconciliation.removed, 1)
    assert.equal(typeof removed.reconciliation.before, 'string')
    assert.ok(!store.get('SELECT * FROM usage_reconciliation WHERE id = ?', 'rec_old'))
    assert.ok(store.get('SELECT * FROM usage_reconciliation WHERE id = ?', 'rec_new'))
    // 没有用量保留期时不给清理边界。
    assert.equal(removed.usage.before, null)
    assert.equal(removed.usage.removed, 0)

    // reconciliationDays = 0 关闭对账记录清理。
    const keep = applyRetention(store, { reconciliationDays: 0 })
    assert.equal(keep.reconciliationRecords, 0)
    assert.equal(keep.reconciliation.before, null)
    assert.ok(store.get('SELECT * FROM usage_reconciliation WHERE id = ?', 'rec_new'))
  })
})
